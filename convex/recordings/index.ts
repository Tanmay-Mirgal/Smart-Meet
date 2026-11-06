import { mutation, query } from "../_generated/server";
import { v, type ObjectType } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { api } from "../_generated/api";
import { actorFromIdentity, type Actor } from "../lib/actor";
import { assertMeetingAccess, requireIdentity } from "../lib/auth";
import { getMeetingParticipant } from "../lib/meetinghelpers";
import { hasMeetingPermission } from "../lib/meetingPermissions";

async function requireRecordingPermission(
  ctx: MutationCtx,
  meetingId: Id<"meetings">,
) {
  const identity = await requireIdentity(ctx);
  const meeting = await assertMeetingAccess(
    ctx,
    identity.tokenIdentifier,
    meetingId,
  );
  const participant = await getMeetingParticipant(
    ctx,
    meetingId,
    identity.tokenIdentifier,
  );

  if (
    !participant ||
    participant.status !== "joined" ||
    !hasMeetingPermission(meeting, participant, "canStartRecording")
  ) {
    throw new Error("You do not have permission to manage recordings");
  }

  return { identity, meeting, participant };
}

export const generateUploadUrl = mutation({
  args: {
    meetingId: v.id("meetings"),
  },
  handler: async (ctx, args) => {
    const { meeting } = await requireRecordingPermission(ctx, args.meetingId);
    const billing: {
      features: {
        recording: boolean;
      };
    } = await ctx.runQuery(api.billing.index.getOrganizationPlan, {
      orgId: meeting.orgId,
    });

    if (!billing.features.recording) {
      throw new Error("Recordings are only available on paid workspace plans");
    }

    return await ctx.storage.generateUploadUrl();
  },
});

export const start = mutation({
  args: {
    meetingId: v.id("meetings"),
    storageProvider: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { identity, meeting, participant } = await requireRecordingPermission(
      ctx,
      args.meetingId,
    );
    const billing: {
      features: {
        recording: boolean;
      };
    } = await ctx.runQuery(api.billing.index.getOrganizationPlan, {
      orgId: meeting.orgId,
    });

    if (!billing.features.recording) {
      throw new Error("Recordings are only available on paid workspace plans");
    }

    const active = await ctx.db
      .query("meeting_recordings")
      .withIndex("by_meetingId_and_status", (q) =>
        q.eq("meetingId", args.meetingId).eq("status", "recording"),
      )
      .unique();

    if (active) {
      throw new Error("Recording is already in progress");
    }

    const now = Date.now();
    return await ctx.db.insert("meeting_recordings", {
      meetingId: args.meetingId,
      orgId: meeting.orgId,
      ownerParticipantId: participant._id,
      ownerTokenIdentifier: identity.tokenIdentifier,
      startedAt: now,
      stoppedAt: undefined,
      durationMs: undefined,
      status: "recording",
      storageId: undefined,
      storageProvider: args.storageProvider ?? undefined,
      storageLocation: undefined,
      playbackUrl: undefined,
      mimeType: undefined,
      containerFormat: undefined,
      transcriptAssetId: undefined,
      summaryAssetId: undefined,
      errorMessage: undefined,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const stop = mutation({
  args: {
    meetingId: v.id("meetings"),
    recordingId: v.optional(v.id("meeting_recordings")),
    storageId: v.optional(v.id("_storage")),
    storageProvider: v.optional(v.string()),
    storageLocation: v.optional(v.string()),
    playbackUrl: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    containerFormat: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireRecordingPermission(ctx, args.meetingId);

    let recording = args.recordingId
      ? await ctx.db.get(args.recordingId)
      : null;

    if (!recording) {
      recording = await ctx.db
        .query("meeting_recordings")
        .withIndex("by_meetingId_and_status", (q) =>
          q.eq("meetingId", args.meetingId).eq("status", "recording"),
        )
        .unique();
    }

    if (!recording || recording.meetingId !== args.meetingId) {
      throw new Error("Active recording not found");
    }

    const now = Date.now();
    await ctx.db.patch(recording._id, {
      stoppedAt: now,
      durationMs: Math.max(0, now - recording.startedAt),
      status: "processing",
      storageId: args.storageId ?? recording.storageId,
      storageProvider: args.storageProvider ?? recording.storageProvider,
      storageLocation: args.storageLocation ?? recording.storageLocation,
      playbackUrl: args.playbackUrl ?? recording.playbackUrl,
      mimeType: args.mimeType ?? recording.mimeType,
      containerFormat: args.containerFormat ?? recording.containerFormat,
      updatedAt: now,
    });

    return recording._id;
  },
});

export const markReady = mutation({
  args: {
    meetingId: v.id("meetings"),
    recordingId: v.id("meeting_recordings"),
    storageId: v.optional(v.id("_storage")),
    playbackUrl: v.optional(v.string()),
    storageProvider: v.optional(v.string()),
    storageLocation: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    containerFormat: v.optional(v.string()),
    transcriptAssetId: v.optional(v.id("meeting_assets")),
    summaryAssetId: v.optional(v.id("meeting_assets")),
  },
  handler: async (ctx, args) => {
    await requireRecordingPermission(ctx, args.meetingId);
    const recording = await ctx.db.get(args.recordingId);
    if (!recording || recording.meetingId !== args.meetingId) {
      throw new Error("Recording not found");
    }

    const resolvedStorageId = args.storageId ?? recording.storageId;
    const playbackFromStorage = resolvedStorageId
      ? await ctx.storage.getUrl(resolvedStorageId)
      : null;

    await ctx.db.patch(args.recordingId, {
      status: "ready",
      playbackUrl:
        args.playbackUrl ??
        playbackFromStorage ??
        recording.playbackUrl,
      storageId: resolvedStorageId,
      storageProvider: args.storageProvider ?? recording.storageProvider,
      storageLocation:
        args.storageLocation ??
        (resolvedStorageId ? String(resolvedStorageId) : recording.storageLocation),
      mimeType: args.mimeType ?? recording.mimeType,
      containerFormat: args.containerFormat ?? recording.containerFormat,
      transcriptAssetId: args.transcriptAssetId ?? recording.transcriptAssetId,
      summaryAssetId: args.summaryAssetId ?? recording.summaryAssetId,
      errorMessage: undefined,
      updatedAt: Date.now(),
    });

    return args.recordingId;
  },
});

export const markFailed = mutation({
  args: {
    meetingId: v.id("meetings"),
    recordingId: v.id("meeting_recordings"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    await requireRecordingPermission(ctx, args.meetingId);
    const recording = await ctx.db.get(args.recordingId);
    if (!recording || recording.meetingId !== args.meetingId) {
      throw new Error("Recording not found");
    }

    await ctx.db.patch(args.recordingId, {
      status: "failed",
      errorMessage: args.errorMessage,
      updatedAt: Date.now(),
    });
    return args.recordingId;
  },
});

const listRecordingsByMeetingArgs = {
  meetingId: v.id("meetings"),
};

export async function listRecordingsByMeetingCore(
  ctx: QueryCtx,
  actor: Actor,
  args: ObjectType<typeof listRecordingsByMeetingArgs>,
) {
  await assertMeetingAccess(ctx, actor.tokenIdentifier, args.meetingId);
  const recordings = await ctx.db
    .query("meeting_recordings")
    .withIndex("by_meetingId_and_createdAt", (q) => q.eq("meetingId", args.meetingId))
    .order("desc")
    .take(100);

  return await Promise.all(
    recordings.map(async (recording) => {
      const freshPlaybackUrl = recording.storageId
        ? await ctx.storage.getUrl(recording.storageId)
        : null;
      return {
        ...recording,
        playbackUrl: freshPlaybackUrl ?? recording.playbackUrl,
      };
    }),
  );
}

export const listByMeeting = query({
  args: listRecordingsByMeetingArgs,
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    return await listRecordingsByMeetingCore(ctx, actorFromIdentity(identity), args);
  },
});
