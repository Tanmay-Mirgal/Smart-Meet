import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import {
  SUMMARY_MAX_LINES,
  SummarizerError,
  normalizeTranscript,
  requestSummary,
  type SummaryPayload,
  type TranscriptInput,
} from "../../lib/summarizer";
import { persistSummary } from "../meetings/index";
import { createTasksFromSummaryCore } from "../tasks/index";
import { missing } from "./access";
import { meetingDetailsUrl } from "./entities";
import { ConnectorError, normalizeError } from "./errors";
import { loadActiveGrant } from "./grantAccess";

/**
 * Server-side `meetings.generateSummary` (CP1 §4.5). The browser used to be the
 * only thing that could summarize — if the host closed the tab no summary
 * existed. This runs the SAME prompt, model and JSON repair (lib/summarizer.ts)
 * from Convex and persists through the SAME core as `meetings.saveSummary`.
 */

/** A meeting's transcript is read up to this many segments (≈ several hours of speech). */
const MAX_SEGMENTS = 5000;
/** Long transcripts are summarized in parts of this many lines, then merged. */
const CHUNK_LINES = 400;

const actionItemValidator = v.object({
  task: v.string(),
  assignee: v.union(v.string(), v.null()),
  due: v.union(v.string(), v.null()),
});

type Prepared =
  | { kind: "existing"; version: number; summary: string; actionItemCount: number }
  | { kind: "ready"; lines: TranscriptInput[] };

const preparedValidator = v.union(
  v.object({
    kind: v.literal("existing"),
    version: v.number(),
    summary: v.string(),
    actionItemCount: v.number(),
  }),
  v.object({
    kind: v.literal("ready"),
    lines: v.array(v.object({ sender: v.string(), text: v.string() })),
  }),
);

export const prepare = internalQuery({
  args: {
    grantId: v.id("connector_grants"),
    meetingId: v.id("meetings"),
    force: v.boolean(),
    now: v.number(),
  },
  returns: preparedValidator,
  handler: async (ctx, args): Promise<Prepared> => {
    // The operation can start well after the request, so the access token may
    // have expired; revocation, membership and tenancy still apply.
    const { grant } = await loadActiveGrant(ctx, args.grantId, args.now, {
      ignoreAccessExpiry: true,
    });
    const meeting = await ctx.db.get(args.meetingId);
    if (!meeting || meeting.orgId !== grant.orgId) return missing("Meeting");

    const existing = await ctx.db
      .query("meeting_assets")
      .withIndex("by_meetingId_and_type", (q) =>
        q.eq("meetingId", meeting._id).eq("type", "summary"),
      )
      .unique();
    // Idempotent: a summary that already exists is returned unless `force`.
    if (existing?.content?.trim() && !args.force) {
      return {
        kind: "existing",
        version: existing.summaryVersion ?? 1,
        summary: existing.content,
        actionItemCount: existing.action_items?.length ?? 0,
      };
    }

    const lines: TranscriptInput[] = [];
    const stream = ctx.db
      .query("transcripts")
      .withIndex("by_meetingId_and_timestamp", (q) => q.eq("meetingId", meeting._id))
      .order("asc");
    for await (const segment of stream) {
      if (lines.length >= MAX_SEGMENTS) break;
      lines.push({ sender: segment.speakerName, text: segment.text });
    }
    return { kind: "ready", lines };
  },
});

/**
 * Persists everything atomically: the summary (through the shared core, which
 * enforces the plan's `aiSummary` feature), its chunks, the tasks from its
 * action items, and the operation's result. Any failure rolls all of it back.
 */
export const save = internalMutation({
  args: {
    operationId: v.id("connector_operations"),
    grantId: v.id("connector_grants"),
    meetingId: v.id("meetings"),
    force: v.boolean(),
    language: v.optional(v.string()),
    summary: v.string(),
    key_points: v.array(v.string()),
    decisions: v.array(v.string()),
    action_items: v.array(actionItemValidator),
    chunks: v.array(
      v.object({
        summary: v.string(),
        key_points: v.array(v.string()),
        decisions: v.array(v.string()),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const { grant, actor } = await loadActiveGrant(ctx, args.grantId, now, {
      ignoreAccessExpiry: true,
    });
    const meeting = await ctx.db.get(args.meetingId);
    if (!meeting || meeting.orgId !== grant.orgId) return missing("Meeting");
    const webUrl = meetingDetailsUrl(String(meeting._id));

    const finish = async (output: Record<string, unknown>) => {
      const operation = await ctx.db.get(args.operationId);
      if (operation && (operation.status === "pending" || operation.status === "running")) {
        await ctx.db.patch(operation._id, { status: "succeeded", output, finishedAt: now });
      }
    };

    // Another save may have landed while the model was running.
    const existing = await ctx.db
      .query("meeting_assets")
      .withIndex("by_meetingId_and_type", (q) =>
        q.eq("meetingId", meeting._id).eq("type", "summary"),
      )
      .unique();
    if (existing?.content?.trim() && !args.force) {
      await finish({
        meetingId: String(meeting._id),
        status: "existing",
        version: existing.summaryVersion ?? 1,
        summary: existing.content,
        actionItemCount: existing.action_items?.length ?? 0,
        tasksCreated: 0,
        webUrl,
      });
      return null;
    }

    const saved = await persistSummary(ctx, actor, {
      meetingId: meeting._id,
      summary: args.summary,
      key_points: args.key_points,
      decisions: args.decisions,
      action_items: args.action_items,
      language: args.language,
    });

    // Same row shape as the existing `summaryChunks.saveChunk` mutation.
    for (const [chunkIndex, chunk] of args.chunks.entries()) {
      const row = await ctx.db
        .query("summary_chunks")
        .withIndex("by_meetingId_and_chunkIndex", (q) =>
          q.eq("meetingId", meeting._id).eq("chunkIndex", chunkIndex),
        )
        .unique();
      const fields = { ...chunk, createdAt: now };
      if (row) await ctx.db.patch(row._id, fields);
      else await ctx.db.insert("summary_chunks", { meetingId: meeting._id, chunkIndex, ...fields });
    }

    // As in the UI flow: action items become tasks (de-duplicated by title).
    const created = await createTasksFromSummaryCore(ctx, actor, {
      orgId: grant.orgId,
      meetingId: meeting._id,
      actionItems: args.action_items.map((item) => ({
        title: item.task,
        assigneeName: item.assignee,
      })),
      createdVia: "connector",
    });

    await finish({
      meetingId: String(meeting._id),
      status: "generated",
      version: saved.version,
      summary: args.summary,
      actionItemCount: args.action_items.length,
      tasksCreated: created.length,
      webUrl,
    });
    return null;
  },
});

function toFailure(error: unknown): { code: string; message: string } {
  if (error instanceof SummarizerError) {
    return {
      code: error.kind === "invalid" || error.kind === "timeout" || error.kind === "upstream"
        ? "upstream_failed"
        : "internal",
      message: error.message,
    };
  }
  const normalized = normalizeError(error);
  return { code: normalized.code, message: normalized.message };
}

/** Summarizes one part, or the whole thing when it fits the prompt's line budget. */
async function summarizeLines(
  apiKey: string,
  rawLines: TranscriptInput[],
  language: string | undefined,
): Promise<{ payload: SummaryPayload; chunks: SummaryPayload[] }> {
  const lines = normalizeTranscript(rawLines);
  if (lines.length === 0) {
    throw new ConnectorError("precondition_failed", "The transcript has no usable text.");
  }

  // Short meetings take exactly the path the browser takes: one call.
  if (lines.length <= SUMMARY_MAX_LINES) {
    return { payload: await requestSummary(apiKey, lines, { language }), chunks: [] };
  }

  // Long meetings: summarize each part, then summarize the parts.
  const chunks: SummaryPayload[] = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES) {
    chunks.push(await requestSummary(apiKey, lines.slice(start, start + CHUNK_LINES)));
  }
  const digest = normalizeTranscript(
    chunks.map((chunk, index) => ({
      sender: `Part ${index + 1} of ${chunks.length}`,
      text: [
        chunk.summary,
        ...chunk.key_points.map((point) => `Key point: ${point}`),
        ...chunk.decisions.map((decision) => `Decision: ${decision}`),
        ...chunk.action_items.map(
          (item) => `Action: ${item.task}${item.assignee ? ` (${item.assignee})` : ""}`,
        ),
      ].join(" "),
    })),
  );
  return { payload: await requestSummary(apiKey, digest, { language }), chunks };
}

export const run = internalAction({
  args: {
    operationId: v.id("connector_operations"),
    grantId: v.id("connector_grants"),
    meetingId: v.id("meetings"),
    force: v.boolean(),
    language: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.connector.operations.markRunning, {
      operationId: args.operationId,
    });

    try {
      const prepared: Prepared = await ctx.runQuery(internal.connector.summary.prepare, {
        grantId: args.grantId,
        meetingId: args.meetingId,
        force: args.force,
        now: Date.now(),
      });

      if (prepared.kind === "existing") {
        await ctx.runMutation(internal.connector.operations.finish, {
          operationId: args.operationId,
          status: "succeeded",
          output: {
            meetingId: String(args.meetingId),
            status: "existing",
            version: prepared.version,
            summary: prepared.summary,
            actionItemCount: prepared.actionItemCount,
            tasksCreated: 0,
            webUrl: meetingDetailsUrl(String(args.meetingId)),
          },
        });
        return null;
      }

      const apiKey = process.env.GROQ_API_KEY?.trim();
      if (!apiKey) {
        throw new ConnectorError("unavailable", "Summarization is not configured on this server.");
      }

      const { payload, chunks } = await summarizeLines(apiKey, prepared.lines, args.language);
      await ctx.runMutation(internal.connector.summary.save, {
        operationId: args.operationId,
        grantId: args.grantId,
        meetingId: args.meetingId as Id<"meetings">,
        force: args.force,
        language: args.language,
        summary: payload.summary,
        key_points: payload.key_points,
        decisions: payload.decisions,
        action_items: payload.action_items,
        chunks: chunks.map((chunk) => ({
          summary: chunk.summary,
          key_points: chunk.key_points,
          decisions: chunk.decisions,
        })),
      });
    } catch (error) {
      // `save` is atomic, so a failure leaves no half-written summary behind.
      await ctx.runMutation(internal.connector.operations.finish, {
        operationId: args.operationId,
        status: "failed",
        error: toFailure(error),
      });
    }
    return null;
  },
});
