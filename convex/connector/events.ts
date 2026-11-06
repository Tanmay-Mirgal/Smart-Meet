import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Actor } from "../lib/actor";
import type { ExternalRef } from "../lib/connectorFields";
import { listAllMeetingParticipants } from "../lib/meetinghelpers";
import { isConnectorEnabled } from "./config";
import { SubjectCache, isoOpt, meetingDetailsUrl, toTaskEntity } from "./entities";
import { getEventScopes, matchesAnyPattern, type EventType } from "./registry";
import { getUserInfo } from "./subject";

/**
 * TRANSACTIONAL OUTBOX (CP1 §5).
 *
 * `emitConnectorEvent` is called from inside the very mutation that changes
 * state, so the event row is committed atomically with that change: a crash
 * between the two cannot lose the event, and a rolled-back change cannot emit
 * one. Delivery happens later, from the scheduler — never inline in a
 * user-facing request.
 *
 * Cost when the connector is OFF: a single env check, no database access. When
 * ON but the organization has no active connection: one indexed read.
 */

export type EventActor = { id: string; name: string; kind: "user" | "system" | "connector" };

/** Updates to one entity inside this window that are not yet delivered are merged. */
export const COALESCE_WINDOW_MS = 5_000;

export type EmitInput = {
  orgId: string;
  type: EventType;
  /** Who caused it; null for system-triggered events (debounced jobs, etc.). */
  actor: Actor | null;
  /** Evaluated only once we know the event will actually be written. */
  build: () => Promise<{ data: Record<string, unknown>; externalRef?: ExternalRef }>;
  /** Exactly-once key: a second emit with the same key is dropped. */
  dedupeKey?: string;
  /** Merge into a still-undelivered event for the same `dedupeKey` instead of adding one. */
  coalesce?: boolean;
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `evt_` + a ULID: lexicographically sortable by time, 128 bits of uniqueness. */
export function newEventId(now: number): string {
  let time = now;
  let timePart = "";
  for (let i = 0; i < 10; i += 1) {
    timePart = CROCKFORD[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  return `evt_${timePart}${Array.from(random, (byte) => CROCKFORD[byte % 32]).join("")}`;
}

export function mergeExternalRef(...refs: Array<ExternalRef | undefined>): ExternalRef | undefined {
  const merged: ExternalRef = {};
  for (const ref of refs) {
    if (!ref) continue;
    for (const key of ["hubProjectId", "hubRunId", "hubStepId"] as const) {
      if (ref[key] !== undefined) merged[key] = ref[key];
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

async function describeActor(ctx: MutationCtx, actor: Actor | null): Promise<EventActor> {
  if (!actor) return { id: "system", name: "Meetup", kind: "system" };
  const info = await getUserInfo(ctx, actor.tokenIdentifier);
  return {
    id: info.id,
    name: actor.displayName,
    kind: actor.via === "connector" ? "connector" : "user",
  };
}

/** Gap-free, commit-ordered per-org sequence (see schema: connector_event_counters). */
async function nextSeq(ctx: MutationCtx, orgId: string): Promise<number> {
  const counter = await ctx.db
    .query("connector_event_counters")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .unique();
  if (!counter) {
    await ctx.db.insert("connector_event_counters", { orgId, nextSeq: 2 });
    return 1;
  }
  await ctx.db.patch(counter._id, { nextSeq: counter.nextSeq + 1 });
  return counter.nextSeq;
}

export async function emitConnectorEvent(ctx: MutationCtx, input: EmitInput): Promise<void> {
  if (!isConnectorEnabled()) return;

  const { orgId, type } = input;
  // Nobody could read this organization's events: skip all work.
  const activeGrant = await ctx.db
    .query("connector_grants")
    .withIndex("by_orgId_and_revokedAt", (q) => q.eq("orgId", orgId).eq("revokedAt", undefined))
    .first();
  if (!activeGrant) return;

  const dedupeKey = input.dedupeKey;
  if (dedupeKey && !input.coalesce) {
    const existing = await ctx.db
      .query("connector_events")
      .withIndex("by_orgId_and_dedupeKey", (q) => q.eq("orgId", orgId).eq("dedupeKey", dedupeKey))
      .first();
    if (existing) return; // exactly once
  }

  const now = Date.now();
  const built = await input.build();
  // JSON round trip drops `undefined`, which Convex values cannot hold.
  const data = JSON.parse(JSON.stringify(built.data)) as Record<string, unknown>;
  const externalRef = built.externalRef
    ? (JSON.parse(JSON.stringify(built.externalRef)) as ExternalRef)
    : undefined;
  const actor = await describeActor(ctx, input.actor);

  // Coalescing: fold rapid updates into the still-undelivered event.
  if (input.coalesce && dedupeKey) {
    const latest = await ctx.db
      .query("connector_events")
      .withIndex("by_orgId_and_dedupeKey", (q) => q.eq("orgId", orgId).eq("dedupeKey", dedupeKey))
      .order("desc")
      .first();
    if (latest && now - latest.occurredAt < COALESCE_WINDOW_MS) {
      const deliveries = await ctx.db
        .query("connector_deliveries")
        .withIndex("by_eventId", (q) => q.eq("eventId", latest._id))
        .take(60);
      if (deliveries.every((d) => d.status === "pending" && d.attempts === 0)) {
        await ctx.db.patch(latest._id, { data, externalRef, actor, occurredAt: now });
        return;
      }
    }
  }

  const eventDocId = await ctx.db.insert("connector_events", {
    orgId,
    seq: await nextSeq(ctx, orgId),
    eventId: newEventId(now),
    type,
    occurredAt: now,
    actor,
    externalRef,
    data,
    dedupeKey,
  });

  // Filter BEFORE enqueueing: pattern match + the grant must be allowed to read this entity.
  const webhooks = await ctx.db
    .query("connector_webhooks")
    .withIndex("by_orgId_and_status", (q) => q.eq("orgId", orgId).eq("status", "active"))
    .take(50);
  const needed = getEventScopes(type);
  const grants = new Map<string, Doc<"connector_grants"> | null>();
  const delay = input.coalesce ? COALESCE_WINDOW_MS : 0;
  let queued = 0;

  for (const webhook of webhooks) {
    if (!matchesAnyPattern(webhook.events, type)) continue;
    let grant = grants.get(webhook.grantId);
    if (grant === undefined) {
      grant = await ctx.db.get(webhook.grantId);
      grants.set(webhook.grantId, grant);
    }
    if (!grant || grant.revokedAt !== undefined) continue;
    if (!needed.every((scope) => grant.scopes.includes(scope))) continue;

    await ctx.db.insert("connector_deliveries", {
      eventId: eventDocId,
      webhookId: webhook._id,
      orgId,
      deliveryUuid: crypto.randomUUID(),
      status: "pending",
      attempts: 0,
      nextAttemptAt: now + delay,
      createdAt: now,
    });
    queued += 1;
  }

  if (queued > 0) {
    await ctx.scheduler.runAfter(delay, internal.connector.dispatch.deliverPending, {
      eventId: eventDocId,
    });
  }
}

/** Debounce for `meeting.transcript.ready`: the later of endedAt+60 s and the last transcript write. */
export const TRANSCRIPT_READY_DEBOUNCE_MS = 60_000;

async function hasActiveGrant(ctx: MutationCtx, orgId: string) {
  return Boolean(
    await ctx.db
      .query("connector_grants")
      .withIndex("by_orgId_and_revokedAt", (q) => q.eq("orgId", orgId).eq("revokedAt", undefined))
      .first(),
  );
}

/**
 * Called when a meeting ends. Schedules the two jobs that depend on it:
 *  - `meeting.transcript.ready` (debounced), and
 *  - the server-side summary fallback (CONNECTOR_AUTO_SUMMARY=true) for when the
 *    host closes the tab before any summary exists.
 * No-op unless the connector is on and the org has an active connection.
 */
export async function scheduleEndTriggers(ctx: MutationCtx, meeting: Doc<"meetings">) {
  if (!isConnectorEnabled() || !(await hasActiveGrant(ctx, meeting.orgId))) return;

  await ctx.scheduler.runAfter(
    TRANSCRIPT_READY_DEBOUNCE_MS,
    internal.connector.triggers.transcriptReady,
    { meetingId: meeting._id, attempt: 0 },
  );

  if (process.env.CONNECTOR_AUTO_SUMMARY === "true") {
    const minutes = Number(process.env.CONNECTOR_AUTO_SUMMARY_DELAY_MINUTES ?? "10");
    const delayMs = (Number.isFinite(minutes) && minutes >= 0 ? minutes : 10) * 60_000;
    await ctx.scheduler.runAfter(delayMs, internal.connector.triggers.autoSummary, {
      meetingId: meeting._id,
    });
  }
}

// ── event builders ──────────────────────────────────────────────────────────

export function meetingRef(meeting: Doc<"meetings">) {
  return {
    id: String(meeting._id),
    title: meeting.title,
    purpose: meeting.purpose,
    status: meeting.status,
    scheduledFor: isoOpt(meeting.scheduledFor),
    startedAt: isoOpt(meeting.startedAt),
    endedAt: isoOpt(meeting.endedAt),
    webUrl: meetingDetailsUrl(String(meeting._id)),
  };
}

export async function emitMeetingLifecycle(
  ctx: MutationCtx,
  type: "meeting.scheduled" | "meeting.started" | "meeting.ended",
  meeting: Doc<"meetings">,
  actor: Actor | null,
) {
  await emitConnectorEvent(ctx, {
    orgId: meeting.orgId,
    type,
    actor,
    dedupeKey: `meeting:${meeting._id}:${type.split(".")[1]}`,
    build: async () => {
      const host = await getUserInfo(ctx, meeting.hostUserTokenIdentifier);
      const participants = await listAllMeetingParticipants(ctx, meeting._id);
      return {
        externalRef: meeting.externalRef,
        data: {
          meeting: meetingRef(meeting),
          host: { id: host.id, name: host.name },
          participantCount: participants.filter(
            (p) => p.status === "joined" || p.admittedAt !== undefined,
          ).length,
        },
      };
    },
  });
}

export async function emitSummaryReady(
  ctx: MutationCtx,
  actor: Actor | null,
  meeting: Doc<"meetings">,
  summary: {
    version: number;
    summary: string;
    key_points?: string[];
    decisions?: string[];
    action_items?: Array<{ task: string; assignee: string | null; due: string | null }>;
    language?: string;
  },
) {
  await emitConnectorEvent(ctx, {
    orgId: meeting.orgId,
    type: "meeting.summary.ready",
    actor,
    // Exactly once per summary VERSION.
    dedupeKey: `summary:${meeting._id}:v${summary.version}`,
    build: async () => {
      const cache = new SubjectCache(ctx);
      const host = await cache.user(meeting.hostUserTokenIdentifier);
      const everyone = await listAllMeetingParticipants(ctx, meeting._id);
      const participants = [];
      for (const participant of everyone) {
        if (participant.status !== "joined" && participant.admittedAt === undefined) continue;
        const user = await cache.user(participant.userTokenIdentifier);
        participants.push({ name: participant.name, email: user.email ?? undefined });
      }
      return {
        externalRef: meeting.externalRef,
        data: {
          meeting: { ...meetingRef(meeting), host: { id: host.id, name: host.name, email: host.email ?? undefined } },
          version: summary.version,
          summary: summary.summary,
          keyPoints: summary.key_points ?? [],
          decisions: summary.decisions ?? [],
          actionItems: summary.action_items ?? [],
          participants,
          language: summary.language,
        },
      };
    },
  });
}

export async function emitTaskEvent(
  ctx: MutationCtx,
  type: "task.created" | "task.updated" | "task.completed",
  task: Doc<"tasks">,
  actor: Actor | null,
) {
  await emitConnectorEvent(ctx, {
    orgId: task.orgId,
    type,
    actor,
    dedupeKey:
      type === "task.created"
        ? `task:${task._id}:created`
        : type === "task.updated"
          ? `task:${task._id}:updated`
          : `task:${task._id}:completed:${task.completedAt ?? 0}`,
    coalesce: type === "task.updated",
    build: async () => {
      const meeting = task.meetingId ? await ctx.db.get(task.meetingId) : null;
      return {
        // A task inherits its meeting's correlation ids unless it has its own.
        externalRef: mergeExternalRef(meeting?.externalRef, task.externalRef),
        data: {
          task: await toTaskEntity(task, new SubjectCache(ctx)),
          meetingId: task.meetingId ? String(task.meetingId) : undefined,
        },
      };
    },
  });
}

export async function emitRecordingEvent(
  ctx: MutationCtx,
  type: "recording.ready" | "recording.failed",
  recording: Doc<"meeting_recordings">,
  actor: Actor | null,
) {
  await emitConnectorEvent(ctx, {
    orgId: recording.orgId,
    type,
    actor,
    dedupeKey: `recording:${recording._id}:${type.split(".")[1]}`,
    build: async () => {
      const meeting = await ctx.db.get(recording.meetingId);
      return {
        externalRef: meeting?.externalRef,
        data: {
          meeting: meeting ? meetingRef(meeting) : { id: String(recording.meetingId) },
          recording: {
            id: String(recording._id),
            durationMs: recording.durationMs,
            mimeType: recording.mimeType,
          },
        },
      };
    },
  });
}

export async function emitInviteAccepted(
  ctx: MutationCtx,
  meeting: Doc<"meetings">,
  invite: Doc<"meeting_invites">,
  actor: Actor | null,
) {
  await emitConnectorEvent(ctx, {
    orgId: meeting.orgId,
    type: "invite.accepted",
    actor,
    dedupeKey: `invite:${invite._id}:accepted`,
    build: async () => ({
      externalRef: meeting.externalRef,
      data: { meeting: meetingRef(meeting), email: invite.email },
    }),
  });
}
