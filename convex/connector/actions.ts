import { v } from "convex/values";
import type { z } from "zod";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { getOrganizationPlanCore } from "../billing/index";
import type { Actor } from "../lib/actor";
import { assertMeetingHost, getUserRecordByEmail, hasOrgAccess } from "../lib/auth";
import { InputError, PlanLimitError, PreconditionError } from "../lib/errors";
import { getMeetingParticipant } from "../lib/meetinghelpers";
import {
  createMeetingCore,
  endMeetingCore,
  inviteParticipantsCore,
} from "../meetings/index";
import {
  createTaskCore,
  createTasksFromSummaryCore,
  updateTaskCore,
} from "../tasks/index";
import { loadMeetingInOrg, loadTaskInOrg, missing } from "./access";
import { LIMITS, PUBLIC_API_PREFIX, webUrl } from "./config";
import { sha256Hex } from "./crypto";
import { SubjectCache, iso, isoOpt, meetingDetailsUrl, meetingJoinUrl, toTaskEntity } from "./entities";
import { ConnectorError, normalizeError, toConvexError } from "./errors";
import { loadActiveGrant } from "./grantAccess";
import { canonicalJson } from "./httpUtil";
import { beginIdempotent, completeIdempotent } from "./idempotency";
import { consumeRateLimit } from "./rateLimit";
import { ACTIONS, type ActionName } from "./registry";

/**
 * Connector WRITE actions (CP1 §4.5). Each is one Convex mutation, so the
 * grant/membership re-check, the idempotency record and the business change
 * commit — or roll back — together. Business rules are NOT reimplemented: every
 * action calls the same `…Core` helper the browser's public function uses.
 */

type ActionDefinition<N extends ActionName> = Extract<(typeof ACTIONS)[number], { name: N }>;
type InputOf<N extends ActionName> = z.output<ActionDefinition<N>["input"]>;

type Handled = { status: number; body: unknown };
type HandlerArgs<N extends ActionName> = {
  ctx: MutationCtx;
  grant: Doc<"connector_grants">;
  actor: Actor;
  input: InputOf<N>;
  now: number;
};

const commonArgs = {
  grantId: v.id("connector_grants"),
  now: v.number(),
  idempotencyKey: v.optional(v.string()),
  // Already validated by the router against the registry's zod schema, and
  // parsed again below, so the handlers see fully typed input.
  input: v.any(),
};

const actionResult = v.object({
  status: v.number(),
  /** JSON text, stored verbatim so an idempotent replay is byte-identical. */
  response: v.string(),
  replayed: v.boolean(),
});

function parseStored<N extends ActionName>(name: N, raw: unknown): InputOf<N> {
  const definition = ACTIONS.find((action) => action.name === name);
  if (!definition) throw new Error(`Unregistered action ${name}`);
  return definition.input.parse(raw) as InputOf<N>;
}

async function execute<N extends ActionName>(
  ctx: MutationCtx,
  name: N,
  args: { grantId: Doc<"connector_grants">["_id"]; now: number; idempotencyKey?: string; input: unknown },
  handler: (handlerArgs: HandlerArgs<N>) => Promise<Handled>,
) {
  try {
    const { grant, actor } = await loadActiveGrant(ctx, args.grantId, args.now);
    const input = parseStored(name, args.input);

    let requestHash = "";
    if (args.idempotencyKey) {
      requestHash = await sha256Hex(`${name}\n${canonicalJson(args.input)}`);
      const begin = await beginIdempotent(ctx, grant._id, args.idempotencyKey, requestHash, args.now);
      if (begin.kind === "replay") {
        // C10: same key + same body ⇒ the stored response, flagged as a replay.
        return { status: begin.status, response: begin.response, replayed: true };
      }
      if (begin.kind === "conflict") {
        throw new ConnectorError(
          "idempotency_conflict",
          "This Idempotency-Key was already used with a different request body.",
        );
      }
    }

    const result = await handler({ ctx, grant, actor, input, now: args.now });
    const response = JSON.stringify(result.body);
    if (args.idempotencyKey) {
      await completeIdempotent(ctx, grant._id, args.idempotencyKey, requestHash, result.status, response, args.now);
    }
    return { status: result.status, response, replayed: false };
  } catch (error) {
    // Re-throw as a typed ConvexError: the transaction rolls back (nothing
    // half-done is committed) and the router can still answer precisely.
    throw toConvexError(normalizeError(error));
  }
}

// ── meetings ─────────────────────────────────────────────────────────────────

export const meetingsCreate = internalMutation({
  args: commonArgs,
  returns: actionResult,
  handler: (ctx, args) =>
    execute(ctx, "meetings.create", args, async ({ ctx, grant, actor, input }) => {
      const meetingId = await createMeetingCore(ctx, actor, {
        orgId: grant.orgId,
        title: input.title,
        purpose: input.purpose,
        description: input.description,
        scheduledFor: input.scheduledFor ? Date.parse(input.scheduledFor) : undefined,
        scheduledEndsAt: input.scheduledEndsAt ? Date.parse(input.scheduledEndsAt) : undefined,
        scheduledTimeZone: input.scheduledTimeZone,
        syncWithGoogleCalendar: input.syncWithGoogleCalendar,
        settings: input.settings,
        inviteEmails: input.inviteEmails,
        createdVia: "connector",
        externalRef: input.externalRef,
        metadataJson: input.metadata ? JSON.stringify(input.metadata) : undefined,
      });
      const meeting = (await ctx.db.get(meetingId))!;
      const id = String(meeting._id);
      return {
        status: 200,
        body: {
          output: {
            meeting: {
              id,
              title: meeting.title,
              status: meeting.status,
              scheduledFor: isoOpt(meeting.scheduledFor),
              joinUrl: meetingJoinUrl(id),
              webUrl: meetingDetailsUrl(id),
            },
          },
        },
      };
    }),
});

export const meetingsEnd = internalMutation({
  args: commonArgs,
  returns: actionResult,
  handler: (ctx, args) =>
    execute(ctx, "meetings.end", args, async ({ ctx, grant, actor, input }) => {
      const meeting = await loadMeetingInOrg(ctx, grant, actor, input.meetingId);

      // Host-only, exactly as in the UI: a connector never bypasses it (403).
      const participant = await getMeetingParticipant(ctx, meeting._id, actor.tokenIdentifier);
      assertMeetingHost(participant);

      // Ending twice is a no-op, so retries cannot move `endedAt`.
      if (meeting.status !== "ended") {
        await endMeetingCore(ctx, actor, { meetingId: meeting._id });
      }
      const after = (await ctx.db.get(meeting._id))!;
      return {
        status: 200,
        body: {
          output: {
            meeting: {
              id: String(after._id),
              status: after.status,
              endedAt: isoOpt(after.endedAt),
              webUrl: meetingDetailsUrl(String(after._id)),
            },
          },
        },
      };
    }),
});

export const meetingsInvite = internalMutation({
  args: commonArgs,
  returns: actionResult,
  handler: (ctx, args) =>
    execute(ctx, "meetings.invite", args, async ({ ctx, grant, actor, input }) => {
      const meeting = await loadMeetingInOrg(ctx, grant, actor, input.meetingId);
      const invited = await inviteParticipantsCore(ctx, actor, {
        meetingId: meeting._id,
        emails: input.emails,
        role: input.role,
      });
      return {
        status: 200,
        body: { output: { invited, webUrl: meetingDetailsUrl(String(meeting._id)) } },
      };
    }),
});

export const meetingsGenerateSummary = internalMutation({
  args: commonArgs,
  returns: actionResult,
  handler: (ctx, args) =>
    execute(ctx, "meetings.generateSummary", args, async ({ ctx, grant, actor, input, now }) => {
      const meeting = await loadMeetingInOrg(ctx, grant, actor, input.meetingId);

      // Fail fast and synchronously for problems the caller can act on.
      const plan = await getOrganizationPlanCore(ctx, actor, grant.orgId);
      if (!plan.features.aiSummary) {
        throw new PlanLimitError("AI summaries are only available on paid workspace plans", {
          feature: "aiSummary",
        });
      }
      const firstSegment = await ctx.db
        .query("transcripts")
        .withIndex("by_meetingId_and_timestamp", (q) => q.eq("meetingId", meeting._id))
        .first();
      if (!firstSegment) {
        throw new PreconditionError(
          "This meeting has no transcript yet, so there is nothing to summarize.",
        );
      }

      const operationId = await ctx.db.insert("connector_operations", {
        grantId: grant._id,
        orgId: grant.orgId,
        action: "meetings.generateSummary",
        status: "pending",
        createdAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.connector.summary.run, {
        operationId,
        grantId: grant._id,
        meetingId: meeting._id,
        force: input.force ?? false,
        language: input.language,
      });

      return {
        status: 202,
        body: {
          operation: {
            id: String(operationId),
            status: "pending",
            pollUrl: webUrl(`${PUBLIC_API_PREFIX}/operations/${operationId}`),
          },
        },
      };
    }),
});

// ── tasks ────────────────────────────────────────────────────────────────────

async function resolveOrgMemberByEmail(ctx: MutationCtx, orgId: string, email: string) {
  const user = await getUserRecordByEmail(ctx, email);
  return user && (await hasOrgAccess(ctx, user.tokenIdentifier, orgId)) ? user : null;
}

export const tasksCreate = internalMutation({
  args: commonArgs,
  returns: actionResult,
  handler: (ctx, args) =>
    execute(ctx, "tasks.create", args, async ({ ctx, grant, actor, input }) => {
      const meetingId = input.meetingId
        ? (await loadMeetingInOrg(ctx, grant, actor, input.meetingId))._id
        : undefined;

      // Known member → assigned. Unknown email → unassigned, kept as a suggestion.
      let assigneeTokenIdentifier: string | undefined;
      let suggestedAssigneeName: string | undefined;
      if (input.assigneeEmail) {
        const member = await resolveOrgMemberByEmail(ctx, grant.orgId, input.assigneeEmail);
        if (member) assigneeTokenIdentifier = member.tokenIdentifier;
        else suggestedAssigneeName = input.assigneeEmail;
      }

      const taskId = await createTaskCore(ctx, actor, {
        orgId: grant.orgId,
        meetingId,
        title: input.title,
        assigneeTokenIdentifier,
        suggestedAssigneeName,
        dueAt: input.dueAt ? Date.parse(input.dueAt) : undefined,
        createdVia: "connector",
        externalRef: input.externalRef,
        metadataJson: input.metadata ? JSON.stringify(input.metadata) : undefined,
      });
      const task = (await ctx.db.get(taskId))!;
      return {
        status: 200,
        body: { output: { task: await toTaskEntity(task, new SubjectCache(ctx)) } },
      };
    }),
});

export const tasksCreateFromSummary = internalMutation({
  args: commonArgs,
  returns: actionResult,
  handler: (ctx, args) =>
    execute(ctx, "tasks.createFromSummary", args, async ({ ctx, grant, actor, input }) => {
      const meeting = await loadMeetingInOrg(ctx, grant, actor, input.meetingId);
      const created = await createTasksFromSummaryCore(ctx, actor, {
        orgId: grant.orgId,
        meetingId: meeting._id,
        actionItems: input.actionItems,
        createdVia: "connector",
        externalRef: input.externalRef,
      });

      const cache = new SubjectCache(ctx);
      const tasks = [];
      for (const taskId of created) {
        tasks.push(await toTaskEntity((await ctx.db.get(taskId))!, cache));
      }
      return {
        status: 200,
        body: {
          output: { tasks, skippedDuplicates: input.actionItems.length - created.length },
        },
      };
    }),
});

export const tasksUpdate = internalMutation({
  args: commonArgs,
  returns: actionResult,
  handler: (ctx, args) =>
    execute(ctx, "tasks.update", args, async ({ ctx, grant, actor, input }) => {
      const task = await loadTaskInOrg(ctx, grant, input.taskId);

      // null unassigns; an email must belong to this organization.
      let assigneeTokenIdentifier: string | null | undefined;
      if (input.assigneeEmail === null) {
        assigneeTokenIdentifier = null;
      } else if (input.assigneeEmail !== undefined) {
        const member = await resolveOrgMemberByEmail(ctx, grant.orgId, input.assigneeEmail);
        if (!member) {
          throw new InputError("Assignee must belong to this workspace", "assigneeEmail");
        }
        assigneeTokenIdentifier = member.tokenIdentifier;
      }

      await updateTaskCore(ctx, actor, {
        taskId: task._id,
        status: input.status,
        assigneeTokenIdentifier,
        dueAt:
          input.dueAt === undefined ? undefined : input.dueAt === null ? null : Date.parse(input.dueAt),
        title: input.title,
      });
      const after = (await ctx.db.get(task._id))!;
      return {
        status: 200,
        body: { output: { task: await toTaskEntity(after, new SubjectCache(ctx)) } },
      };
    }),
});

// ── notifications ────────────────────────────────────────────────────────────

/** Clicking a notification navigates the user, so only https URLs or in-app paths are allowed. */
function normalizeNotificationLink(link: string | undefined): string | undefined {
  if (!link) return undefined;
  if (link.startsWith("/") && !link.startsWith("//")) return link;
  try {
    const url = new URL(link);
    if (url.protocol === "https:") return url.toString();
  } catch {
    // fall through
  }
  throw new InputError("link must be an https URL or a path inside Meetup", "link");
}

export const notificationsCreate = internalMutation({
  args: commonArgs,
  returns: actionResult,
  handler: (ctx, args) =>
    execute(ctx, "notifications.create", args, async ({ ctx, grant, actor, input, now }) => {
      // 60 per minute per connection, on top of the global request limit.
      const limit = await consumeRateLimit(ctx, grant._id, "notif", LIMITS.notificationsPerMinute, now);
      if (!limit.allowed) {
        throw new ConnectorError("rate_limited", "Notification rate limit exceeded (60 per minute).", {
          extras: { retryAfterSeconds: limit.retryAfterSeconds },
        });
      }

      const link = normalizeNotificationLink(input.link);
      const meetingId = input.meetingId
        ? (await loadMeetingInOrg(ctx, grant, actor, input.meetingId))._id
        : undefined;

      let recipient: Doc<"users"> | null = null;
      if (input.userEmail) {
        recipient = await getUserRecordByEmail(ctx, input.userEmail);
      } else if (input.userId) {
        const userId = ctx.db.normalizeId("users", input.userId);
        recipient = userId ? await ctx.db.get(userId) : null;
      }
      // Non-members look exactly like unknown users.
      if (!recipient || !(await hasOrgAccess(ctx, recipient.tokenIdentifier, grant.orgId))) {
        return missing("Recipient");
      }

      const notificationId = await ctx.db.insert("notifications", {
        userTokenIdentifier: recipient.tokenIdentifier,
        orgId: grant.orgId,
        kind: "connector",
        title: input.title,
        message: input.message,
        link,
        meetingId,
        isRead: false,
        createdAt: now,
      });
      return {
        status: 200,
        body: { output: { notification: { id: String(notificationId), createdAt: iso(now) } } },
      };
    }),
});
