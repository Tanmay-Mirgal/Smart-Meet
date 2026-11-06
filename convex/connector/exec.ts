import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { computeOrganizationPlan } from "../billing/index";
import type { Actor } from "../lib/actor";
import {
  assertMeetingAccess,
  getCurrentUserRecord,
  getUserRecordByEmail,
  hasOrgAccess,
} from "../lib/auth";
import { listAllMeetingParticipants } from "../lib/meetinghelpers";
import { getDefaultMeetingSettings } from "../lib/meetingPermissions";
import { webUrl } from "./config";
import { SubjectCache, iso, isoOpt, toMeetingEntity, toTaskEntity } from "./entities";
import { notFound, toConvexError } from "./errors";
import { loadActiveGrant } from "./grantAccess";
import { buildMediaUrl } from "./mediaUrl";
import {
  MAX_TIME,
  decodeCursor,
  encodeCursor,
  isTimeCursor,
  scanNewestFirst,
} from "./pagination";
import { getTenantInfo, getUserInfo } from "./subject";

/**
 * Connector READ functions (CP1 §4.6). Each begins with `loadActiveGrant`, which
 * re-verifies the grant and the user's live membership inside the same
 * transaction as the data access (C08/C09). Ids from another organization —
 * or ids that are simply malformed — are reported as 404, never 403, so ids
 * cannot be probed across tenants.
 *
 * `returns: v.any()` is deliberate: the response shapes are the zod output
 * schemas in registry.ts (single source of truth), and tests parse every
 * response against them.
 */

const base = { grantId: v.id("connector_grants"), now: v.number() };
const page = { limit: v.number(), cursor: v.optional(v.string()) };

function missing(what: string): never {
  throw toConvexError(notFound(`${what} not found`));
}

async function loadMeeting(
  ctx: QueryCtx,
  grant: Doc<"connector_grants">,
  actor: Actor,
  rawId: string,
): Promise<Doc<"meetings">> {
  const id = ctx.db.normalizeId("meetings", rawId);
  const meeting = id ? await ctx.db.get(id) : null;
  if (!meeting || meeting.orgId !== grant.orgId) return missing("Meeting");
  // Same rule the UI applies (throws "Forbidden" → 403, which cannot happen for
  // an org member but keeps the rule in one place).
  await assertMeetingAccess(ctx, actor.tokenIdentifier, meeting._id);
  return meeting;
}

export const me = internalQuery({
  args: base,
  returns: v.any(),
  handler: async (ctx, args) => {
    const { grant } = await loadActiveGrant(ctx, args.grantId, args.now);
    const plan = await computeOrganizationPlan(ctx, grant.orgId);

    return {
      user: await getUserInfo(ctx, grant.userTokenIdentifier),
      tenant: await getTenantInfo(ctx, grant.orgId),
      scopes: grant.scopes,
      grantId: String(grant._id),
      plan: {
        name: plan.planName,
        limits: { maxMeetings: plan.maxMeetings },
        usage: {
          meetingsUsed: plan.usage.meetingsUsed,
          meetingsRemaining: plan.usage.meetingsRemaining,
        },
      },
      capabilities: {
        aiSummary: plan.features.aiSummary,
        recording: plan.features.recording,
        notionExport: plan.features.notionExport,
        googleCalendarSync: plan.features.googleCalendarSync,
        meetingsUsed: plan.usage.meetingsUsed,
        meetingsCap: plan.maxMeetings,
      },
    };
  },
});

export const orgsGet = internalQuery({
  args: base,
  returns: v.any(),
  handler: async (ctx, args) => {
    const { grant } = await loadActiveGrant(ctx, args.grantId, args.now);
    const organization = await ctx.db
      .query("organizations")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", grant.orgId))
      .unique();
    return {
      id: grant.orgId,
      name: organization?.name ?? "Workspace",
      slug: organization?.slug,
      imageUrl: organization?.imageUrl,
      webUrl: webUrl("/dashboard"),
    };
  },
});

export const membersList = internalQuery({
  args: { ...base, ...page },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { grant } = await loadActiveGrant(ctx, args.grantId, args.now);
    const before = decodeCursor(args.cursor, isTimeCursor);

    const { items, nextTime } = await scanNewestFirst({
      limit: args.limit,
      beforeTime: before?.t,
      fetchBatch: (upper, n) =>
        ctx.db
          .query("user_org_memberships")
          .withIndex("by_orgId", (q) =>
            q.eq("orgId", grant.orgId).lt("_creationTime", upper),
          )
          .order("desc")
          .take(n),
      // A membership whose user has not synced yet has no name/email to show.
      accept: async (membership) =>
        (await getCurrentUserRecord(ctx, membership.userTokenIdentifier)) !== null,
    });

    const seen = new Set<string>();
    const members = [];
    for (const membership of items) {
      const user = await getCurrentUserRecord(ctx, membership.userTokenIdentifier);
      if (!user || seen.has(user._id)) continue;
      seen.add(user._id);
      const name =
        user.fullName?.trim() ||
        [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
        user.email;
      members.push({
        id: String(user._id),
        name,
        email: user.email?.trim() || null,
        imageUrl: user.imageUrl || undefined,
      });
    }

    return {
      items: members,
      nextCursor: nextTime === null ? null : encodeCursor({ t: nextTime }),
    };
  },
});

export const meetingsList = internalQuery({
  args: {
    ...base,
    ...page,
    status: v.optional(
      v.union(v.literal("scheduled"), v.literal("active"), v.literal("ended")),
    ),
    purpose: v.optional(v.string()),
    from: v.optional(v.number()),
    to: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { grant } = await loadActiveGrant(ctx, args.grantId, args.now);
    const before = decodeCursor(args.cursor, isTimeCursor);
    const lower = args.from ?? 0;
    const purpose = args.purpose?.trim().toLowerCase();
    const status = args.status;

    const { items, nextTime } = await scanNewestFirst({
      limit: args.limit,
      beforeTime: before?.t,
      fetchBatch: (upper, n) => {
        const hi = Math.min(upper, args.to ?? MAX_TIME);
        return status
          ? ctx.db
              .query("meetings")
              .withIndex("by_orgId_and_status", (q) =>
                q
                  .eq("orgId", grant.orgId)
                  .eq("status", status)
                  .gte("_creationTime", lower)
                  .lt("_creationTime", hi),
              )
              .order("desc")
              .take(n)
          : ctx.db
              .query("meetings")
              .withIndex("by_orgId", (q) =>
                q
                  .eq("orgId", grant.orgId)
                  .gte("_creationTime", lower)
                  .lt("_creationTime", hi),
              )
              .order("desc")
              .take(n);
      },
      // `purpose` is free text with no index: filtered in memory, scan-capped.
      accept: purpose ? (meeting) => meeting.purpose.toLowerCase() === purpose : undefined,
    });

    const cache = new SubjectCache(ctx);
    return {
      items: await Promise.all(items.map((meeting) => toMeetingEntity(meeting, cache))),
      nextCursor: nextTime === null ? null : encodeCursor({ t: nextTime }),
    };
  },
});

export const meetingsGet = internalQuery({
  args: { ...base, id: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { grant, actor } = await loadActiveGrant(ctx, args.grantId, args.now);
    const meeting = await loadMeeting(ctx, grant, actor, args.id);

    const participants = await listAllMeetingParticipants(ctx, meeting._id);
    const summary = await ctx.db
      .query("meeting_assets")
      .withIndex("by_meetingId_and_type", (q) =>
        q.eq("meetingId", meeting._id).eq("type", "summary"),
      )
      .unique();
    const recordings = await ctx.db
      .query("meeting_recordings")
      .withIndex("by_meetingId_and_createdAt", (q) => q.eq("meetingId", meeting._id))
      .take(100);
    const settings = getDefaultMeetingSettings(meeting.settings);
    const cache = new SubjectCache(ctx);

    return {
      ...(await toMeetingEntity(meeting, cache)),
      settings,
      durationMs: meeting.startedAt
        ? Math.max(0, (meeting.endedAt ?? args.now) - meeting.startedAt)
        : 0,
      // People who actually got into the room (the host's pre-created row doesn't count).
      participantCount: participants.filter(
        (p) => p.status === "joined" || p.admittedAt !== undefined,
      ).length,
      activeParticipants: participants.filter((p) => p.status === "joined").length,
      hasSummary: Boolean(summary?.content?.trim()),
      googleCalendar: {
        syncRequested: meeting.googleCalendarSyncRequested ?? false,
        status: meeting.googleCalendarSyncStatus,
        eventUrl: meeting.googleCalendarEventUrl,
      },
      recording: {
        allowed: settings.allowRecording,
        recordingCount: recordings.length,
        hasReadyRecording: recordings.some((r) => r.status === "ready"),
      },
    };
  },
});

export const meetingsParticipants = internalQuery({
  args: { ...base, ...page, id: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { grant, actor } = await loadActiveGrant(ctx, args.grantId, args.now);
    const meeting = await loadMeeting(ctx, grant, actor, args.id);

    const cursor = decodeCursor(
      args.cursor,
      (value): value is { c: number; i: string } =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as { c?: unknown }).c === "number" &&
        typeof (value as { i?: unknown }).i === "string",
    );

    // A meeting has at most a few hundred participants: sort in memory by the
    // stable key (createdAt, id) and page with a keyset cursor over it.
    const all = (await listAllMeetingParticipants(ctx, meeting._id)).sort(
      (a, b) => a.createdAt - b.createdAt || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0),
    );
    const start = cursor
      ? all.findIndex((p) => p.createdAt > cursor.c || (p.createdAt === cursor.c && p._id > cursor.i))
      : 0;
    const remaining = start < 0 ? [] : all.slice(start);
    const pageItems = remaining.slice(0, args.limit);

    const cache = new SubjectCache(ctx);
    const items = [];
    for (const participant of pageItems) {
      const user = await cache.user(participant.userTokenIdentifier);
      items.push({
        id: String(participant._id),
        name: participant.name,
        email: user.email ?? undefined,
        role: participant.role,
        status: participant.status,
        joinedAt: isoOpt(participant.admittedAt),
        leftAt: isoOpt(participant.leftAt),
      });
    }

    const last = pageItems[pageItems.length - 1];
    return {
      items,
      nextCursor:
        remaining.length > args.limit && last
          ? encodeCursor({ c: last.createdAt, i: String(last._id) })
          : null,
    };
  },
});

export const meetingsTranscript = internalQuery({
  args: { ...base, ...page, id: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { grant, actor } = await loadActiveGrant(ctx, args.grantId, args.now);
    const meeting = await loadMeeting(ctx, grant, actor, args.id);

    const cursor = decodeCursor(
      args.cursor,
      (value): value is { t: number; c: number } =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as { t?: unknown }).t === "number" &&
        typeof (value as { c?: unknown }).c === "number",
    );

    // Total order = the index order: (timestamp, _creationTime).
    const stream = ctx.db
      .query("transcripts")
      .withIndex("by_meetingId_and_timestamp", (q) =>
        q.eq("meetingId", meeting._id).gte("timestamp", cursor?.t ?? -Number.MAX_VALUE),
      )
      .order("asc");

    const segments: Doc<"transcripts">[] = [];
    let hasMore = false;
    for await (const segment of stream) {
      if (cursor && segment.timestamp === cursor.t && segment._creationTime <= cursor.c) {
        continue;
      }
      if (segments.length === args.limit) {
        hasMore = true;
        break;
      }
      segments.push(segment);
    }

    const last = segments[segments.length - 1];
    return {
      items: segments.map((segment) => ({
        id: String(segment._id),
        speakerId: segment.speakerId,
        speaker: segment.speakerName,
        text: segment.text,
        timestamp: iso(segment.timestamp),
      })),
      nextCursor:
        hasMore && last ? encodeCursor({ t: last.timestamp, c: last._creationTime }) : null,
    };
  },
});

export const meetingsSummary = internalQuery({
  args: { ...base, id: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { grant, actor } = await loadActiveGrant(ctx, args.grantId, args.now);
    const meeting = await loadMeeting(ctx, grant, actor, args.id);

    const asset = await ctx.db
      .query("meeting_assets")
      .withIndex("by_meetingId_and_type", (q) =>
        q.eq("meetingId", meeting._id).eq("type", "summary"),
      )
      .unique();
    if (!asset?.content?.trim()) return missing("Summary");

    return {
      summary: asset.content,
      keyPoints: asset.key_points ?? [],
      decisions: asset.decisions ?? [],
      actionItems: asset.action_items ?? [],
      version: asset.summaryVersion ?? 1,
      language: asset.language,
      generatedAt: iso(asset.updatedAt),
    };
  },
});

export const meetingsRecordings = internalQuery({
  args: { ...base, ...page, id: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { grant, actor } = await loadActiveGrant(ctx, args.grantId, args.now);
    const meeting = await loadMeeting(ctx, grant, actor, args.id);
    const before = decodeCursor(args.cursor, isTimeCursor);

    const rows = await ctx.db
      .query("meeting_recordings")
      .withIndex("by_meetingId_and_createdAt", (q) =>
        q.eq("meetingId", meeting._id).lt("createdAt", before?.t ?? MAX_TIME),
      )
      .order("desc")
      .take(args.limit + 1);
    const pageRows = rows.slice(0, args.limit);

    const items = [];
    for (const recording of pageRows) {
      // Never a permanent link: a signed URL that lives for 10 minutes.
      const canPlay =
        recording.status === "ready" && Boolean(recording.storageId || recording.playbackUrl);
      const playback = canPlay
        ? await buildMediaUrl(String(recording._id), String(grant._id), args.now)
        : null;
      items.push({
        id: String(recording._id),
        status: recording.status,
        startedAt: iso(recording.startedAt),
        stoppedAt: isoOpt(recording.stoppedAt),
        durationMs: recording.durationMs,
        mimeType: recording.mimeType,
        playbackUrl: playback?.url,
        playbackUrlExpiresAt: playback ? iso(playback.expiresAt) : undefined,
        errorMessage: recording.errorMessage,
      });
    }

    const last = pageRows[pageRows.length - 1];
    return {
      items,
      nextCursor: rows.length > args.limit && last ? encodeCursor({ t: last.createdAt }) : null,
    };
  },
});

/** Resolves a signed media link to the storage URL (see router `recording.media`). */
export const mediaTarget = internalQuery({
  args: { ...base, recordingId: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    // The 10-minute link may outlive the 1-hour access token's last minutes, so
    // only revocation, membership and tenancy are enforced here.
    const { grant, actor } = await loadActiveGrant(ctx, args.grantId, args.now, {
      ignoreAccessExpiry: true,
    });
    const id = ctx.db.normalizeId("meeting_recordings", args.recordingId);
    const recording = id ? await ctx.db.get(id) : null;
    if (!recording || recording.orgId !== grant.orgId) return missing("Recording");
    await assertMeetingAccess(ctx, actor.tokenIdentifier, recording.meetingId);
    if (recording.status !== "ready") return missing("Recording");

    const url = recording.storageId
      ? await ctx.storage.getUrl(recording.storageId)
      : (recording.playbackUrl ?? null);
    return url ?? missing("Recording");
  },
});

export const meetingsWhiteboard = internalQuery({
  args: { ...base, id: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { grant, actor } = await loadActiveGrant(ctx, args.grantId, args.now);
    const meeting = await loadMeeting(ctx, grant, actor, args.id);

    const whiteboard = await ctx.db
      .query("meeting_whiteboards")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", meeting._id))
      .unique();

    // Scenes are saved up to 900 kB; responses are capped lower.
    const MAX_SCENE_CHARS = 800_000;
    let scene: unknown = null;
    let truncated = false;
    if (whiteboard?.scene) {
      if (whiteboard.scene.length > MAX_SCENE_CHARS) {
        truncated = true;
      } else {
        try {
          scene = JSON.parse(whiteboard.scene);
        } catch {
          scene = null;
        }
      }
    }

    return {
      isOpen: whiteboard?.isOpen ?? false,
      scene,
      updatedAt: whiteboard ? iso(whiteboard.updatedAt) : null,
      truncated,
    };
  },
});

export const tasksList = internalQuery({
  args: {
    ...base,
    ...page,
    status: v.optional(
      v.union(v.literal("open"), v.literal("in_progress"), v.literal("done")),
    ),
    meetingId: v.optional(v.string()),
    assigneeEmail: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { grant, actor } = await loadActiveGrant(ctx, args.grantId, args.now);
    const before = decodeCursor(args.cursor, isTimeCursor);
    const { status } = args;

    let meetingId: Id<"meetings"> | undefined;
    if (args.meetingId) {
      meetingId = (await loadMeeting(ctx, grant, actor, args.meetingId))._id;
    }

    let assigneeToken: string | undefined;
    if (args.assigneeEmail) {
      const user = await getUserRecordByEmail(ctx, args.assigneeEmail);
      if (!user || !(await hasOrgAccess(ctx, user.tokenIdentifier, grant.orgId))) {
        return { items: [], nextCursor: null }; // nobody in this org has that email
      }
      assigneeToken = user.tokenIdentifier;
    }

    const { items, nextTime } = await scanNewestFirst({
      limit: args.limit,
      beforeTime: before?.t,
      fetchBatch: (upper, n) => {
        if (meetingId) {
          return ctx.db
            .query("tasks")
            .withIndex("by_meetingId", (q) =>
              q.eq("meetingId", meetingId).lt("_creationTime", upper),
            )
            .order("desc")
            .take(n);
        }
        return status
          ? ctx.db
              .query("tasks")
              .withIndex("by_orgId_and_status", (q) =>
                q.eq("orgId", grant.orgId).eq("status", status).lt("_creationTime", upper),
              )
              .order("desc")
              .take(n)
          : ctx.db
              .query("tasks")
              .withIndex("by_orgId", (q) =>
                q.eq("orgId", grant.orgId).lt("_creationTime", upper),
              )
              .order("desc")
              .take(n);
      },
      // A task can reference a meeting from another org the user also belongs
      // to, so the tenant is re-checked on every row, not only on the index.
      accept:
        meetingId || assigneeToken
          ? (task) =>
              task.orgId === grant.orgId &&
              (!status || task.status === status) &&
              (!assigneeToken || task.assigneeTokenIdentifier === assigneeToken)
          : (task) => task.orgId === grant.orgId,
    });

    const cache = new SubjectCache(ctx);
    return {
      items: await Promise.all(items.map((task) => toTaskEntity(task, cache))),
      nextCursor: nextTime === null ? null : encodeCursor({ t: nextTime }),
    };
  },
});

export const insightsGet = internalQuery({
  args: {
    ...base,
    range: v.union(v.literal("7d"), v.literal("30d"), v.literal("90d"), v.literal("all")),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { grant } = await loadActiveGrant(ctx, args.grantId, args.now);

    const days = { "7d": 7, "30d": 30, "90d": 90, all: 0 }[args.range];
    const from = days ? args.now - days * 86_400_000 : 0;

    // Bounded: counts are capped at 500 meetings / 1000 tasks per status.
    const meetings = await ctx.db
      .query("meetings")
      .withIndex("by_orgId", (q) => q.eq("orgId", grant.orgId).gte("_creationTime", from))
      .order("desc")
      .take(500);

    const durations = meetings
      .filter((m) => m.status === "ended" && m.startedAt !== undefined && m.endedAt !== undefined)
      .map((m) => Math.max(0, (m.endedAt as number) - (m.startedAt as number)));

    const countTasks = async (status: "open" | "in_progress" | "done") =>
      (
        await ctx.db
          .query("tasks")
          .withIndex("by_orgId_and_status", (q) =>
            q.eq("orgId", grant.orgId).eq("status", status),
          )
          .take(1000)
      ).length;

    return {
      range: args.range,
      meetings: {
        total: meetings.length,
        scheduled: meetings.filter((m) => m.status === "scheduled").length,
        active: meetings.filter((m) => m.status === "active").length,
        ended: meetings.filter((m) => m.status === "ended").length,
      },
      averageDurationMs: durations.length
        ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length)
        : null,
      tasks: {
        open: await countTasks("open"),
        inProgress: await countTasks("in_progress"),
        done: await countTasks("done"),
      },
      timeline: meetings.slice(0, 50).map((m) => ({
        id: String(m._id),
        title: m.title,
        status: m.status,
        createdAt: iso(m._creationTime),
      })),
    };
  },
});
