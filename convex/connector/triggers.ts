import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { computeOrganizationPlan } from "../billing/index";
import { isConnectorEnabled } from "./config";
import { TRANSCRIPT_READY_DEBOUNCE_MS, emitConnectorEvent, meetingRef } from "./events";
import { getEventScopes, matchesAnyPattern } from "./registry";

/**
 * Scheduled follow-ups of a meeting ending (scheduled from `endMeetingCore`
 * through `scheduleEndTriggers`; nothing is scheduled when the connector is off).
 */

/** Below this much spoken text a meeting is not worth auto-summarizing. */
const AUTO_SUMMARY_MIN_CHARS = 400;
const MAX_SEGMENTS_COUNTED = 10_000;
const MAX_RESCHEDULES = 10;

/**
 * `meeting.transcript.ready`, emitted ONCE after the meeting ended and the final
 * transcript batch has been stored. Debounced: it waits until 60 s after the
 * later of the end time and the last write to the meeting, rescheduling itself
 * if a late transcript batch arrives.
 */
export const transcriptReady = internalMutation({
  args: { meetingId: v.id("meetings"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!isConnectorEnabled()) return null;
    const meeting = await ctx.db.get(args.meetingId);
    if (!meeting || meeting.status !== "ended" || meeting.endedAt === undefined) return null;

    const now = Date.now();
    const dueAt = Math.max(meeting.endedAt, meeting.lastActivityAt) + TRANSCRIPT_READY_DEBOUNCE_MS;
    if (now < dueAt) {
      if (args.attempt < MAX_RESCHEDULES) {
        await ctx.scheduler.runAfter(dueAt - now, internal.connector.triggers.transcriptReady, {
          meetingId: args.meetingId,
          attempt: args.attempt + 1,
        });
      }
      return null;
    }

    let segments = 0;
    const stream = ctx.db
      .query("transcripts")
      .withIndex("by_meetingId_and_timestamp", (q) => q.eq("meetingId", meeting._id));
    for await (const _segment of stream) {
      void _segment;
      segments += 1;
      if (segments >= MAX_SEGMENTS_COUNTED) break;
    }
    if (segments === 0) return null;

    const endedAt = meeting.endedAt;
    await emitConnectorEvent(ctx, {
      orgId: meeting.orgId,
      type: "meeting.transcript.ready",
      actor: null,
      dedupeKey: `transcript:${meeting._id}`,
      build: async () => ({
        externalRef: meeting.externalRef,
        data: {
          meeting: meetingRef(meeting),
          segments,
          durationMs: meeting.startedAt ? Math.max(0, endedAt - meeting.startedAt) : 0,
        },
      }),
    });
    return null;
  },
});

/**
 * Server-side summary fallback. If, some minutes after a meeting ended, nobody
 * has produced a summary (the host closed the tab), and the transcript is long
 * enough, and the organization's plan allows AI summaries, and a connected app
 * is waiting for `meeting.summary.ready` — generate it on the server so the
 * workflow does not stall. Gated by CONNECTOR_AUTO_SUMMARY=true.
 */
export const autoSummary = internalMutation({
  args: { meetingId: v.id("meetings") },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!isConnectorEnabled() || process.env.CONNECTOR_AUTO_SUMMARY !== "true") return null;

    const meeting = await ctx.db.get(args.meetingId);
    if (!meeting || meeting.status !== "ended") return null;

    const existing = await ctx.db
      .query("meeting_assets")
      .withIndex("by_meetingId_and_type", (q) =>
        q.eq("meetingId", meeting._id).eq("type", "summary"),
      )
      .unique();
    if (existing?.content?.trim()) return null;

    let characters = 0;
    let counted = 0;
    const stream = ctx.db
      .query("transcripts")
      .withIndex("by_meetingId_and_timestamp", (q) => q.eq("meetingId", meeting._id));
    for await (const segment of stream) {
      characters += segment.text.length;
      counted += 1;
      if (characters >= AUTO_SUMMARY_MIN_CHARS || counted >= MAX_SEGMENTS_COUNTED) break;
    }
    if (characters < AUTO_SUMMARY_MIN_CHARS) return null;

    if (!(await computeOrganizationPlan(ctx, meeting.orgId)).features.aiSummary) return null;

    // Run it on behalf of a connection that is actually subscribed and allowed to read summaries.
    const webhooks = await ctx.db
      .query("connector_webhooks")
      .withIndex("by_orgId_and_status", (q) => q.eq("orgId", meeting.orgId).eq("status", "active"))
      .take(50);
    const needed = getEventScopes("meeting.summary.ready");

    for (const webhook of webhooks) {
      if (!matchesAnyPattern(webhook.events, "meeting.summary.ready")) continue;
      const grant = await ctx.db.get(webhook.grantId);
      if (!grant || grant.revokedAt !== undefined) continue;
      if (!needed.every((scope) => grant.scopes.includes(scope))) continue;

      const operationId = await ctx.db.insert("connector_operations", {
        grantId: grant._id,
        orgId: grant.orgId,
        action: "meetings.generateSummary",
        status: "pending",
        createdAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.connector.summary.run, {
        operationId,
        grantId: grant._id,
        meetingId: meeting._id,
        force: false,
      });
      return null;
    }
    return null;
  },
});
