import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import type { Id, Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { actorFromIdentity } from "../lib/actor";
import { isConnectorEnabled } from "../connector/config";
import { emitInviteAccepted, emitMeetingLifecycle } from "../connector/events";
import {
  assertMeetingAccess,
  getCurrentUserRecord,
  getIdentityName,
  hasMeetingInvite,
  hasOrgAccess,
  requireIdentity,
} from "../lib/auth";
import { normalizeInviteEmail, resolveInviteStatus } from "../lib/invitations";
import {
  getMeetingParticipant,
  listAllMeetingParticipants,
  listMeetingParticipantsByStatus,
} from "../lib/meetinghelpers";
import {
  canManageParticipantRole,
  hasMeetingPermission,
  meetingRoleValidator,
  pickNextHost,
  resolveJoinDecision,
} from "../lib/meetingPermissions";

type ConvexCtx = QueryCtx | MutationCtx;

async function insertAuditLog(
  ctx: MutationCtx,
  args: {
    meetingId: Id<"meetings">;
    actorParticipantId?: Id<"meeting_participants">;
    actorName: string;
    action: string;
    targetParticipantId?: Id<"meeting_participants">;
    targetName?: string;
    metadata?: string;
  },
) {
  await ctx.db.insert("meeting_audit_logs", {
    meetingId: args.meetingId,
    actorParticipantId: args.actorParticipantId,
    actorName: args.actorName,
    action: args.action,
    targetParticipantId: args.targetParticipantId,
    targetName: args.targetName,
    metadata: args.metadata,
    createdAt: Date.now(),
  });
}

async function requireJoinedParticipant(
  ctx: ConvexCtx,
  meetingId: Id<"meetings">,
  tokenIdentifier: string,
) {
  const participant = await getMeetingParticipant(ctx, meetingId, tokenIdentifier);
  if (!participant || participant.status !== "joined") {
    throw new Error("Join the meeting before performing this action");
  }

  return participant;
}

async function maybeTransferHost(
  ctx: MutationCtx,
  args: {
    meeting: Doc<"meetings">;
    leavingParticipant: Doc<"meeting_participants">;
  },
) {
  if (args.leavingParticipant.role !== "host") {
    return;
  }

  const everyone = await listAllMeetingParticipants(ctx, args.meeting._id);
  const nextHost = pickNextHost(
    everyone.filter((participant) => participant._id !== args.leavingParticipant._id),
  );

  if (!nextHost) {
    return;
  }

  await ctx.db.patch(nextHost._id, {
    role: "host",
  });

  await ctx.db.patch(args.leavingParticipant._id, {
    role: "co_host",
  });

  const nextHostParticipant = await ctx.db.get(nextHost._id);
  if (!nextHostParticipant) {
    return;
  }

  await ctx.db.patch(args.meeting._id, {
    hostUserTokenIdentifier: nextHostParticipant.userTokenIdentifier,
    hostClerkId: nextHostParticipant.clerkId,
    lastActivityAt: Date.now(),
  });

  await insertAuditLog(ctx, {
    meetingId: args.meeting._id,
    actorParticipantId: args.leavingParticipant._id,
    actorName: args.leavingParticipant.name,
    action: "host_transferred",
    targetParticipantId: nextHostParticipant._id,
    targetName: nextHostParticipant.name,
  });
}

async function getInviteRole(
  ctx: ConvexCtx,
  meetingId: Id<"meetings">,
  email: string | null | undefined,
) {
  if (!email) {
    return null;
  }

  const invite = await ctx.db
    .query("meeting_invites")
    .withIndex("by_meetingId_and_email", (q) =>
      q.eq("meetingId", meetingId).eq("email", normalizeInviteEmail(email)),
    )
    .unique();

  if (!invite) {
    return null;
  }

  const status = resolveInviteStatus(invite);
  if (status === "cancelled" || status === "expired" || status === "declined") {
    return null;
  }

  return invite;
}

export const join = mutation({
  args: {
    meetingId: v.id("meetings"),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const meeting = await ctx.db.get(args.meetingId);
    if (!meeting) {
      throw new Error("Meeting not found");
    }

    const now = Date.now();
    const user = await getCurrentUserRecord(ctx, identity.tokenIdentifier);
    const existing = await getMeetingParticipant(
      ctx,
      args.meetingId,
      identity.tokenIdentifier,
    );
    const invite = await getInviteRole(ctx, args.meetingId, identity.email ?? user?.email);
    const isOrgMember = await hasOrgAccess(
      ctx,
      identity.tokenIdentifier,
      meeting.orgId,
    );
    const isInvited = await hasMeetingInvite(
      ctx,
      args.meetingId,
      identity.email ?? user?.email ?? null,
      identity.tokenIdentifier,
    );
    const decision = resolveJoinDecision({
      meeting,
      participant: existing,
      isOrgMember,
      isInvited,
    });

    if (decision.status === "denied") {
      throw new Error(decision.reason ?? "Unable to join this meeting");
    }

    if (
      meeting.status === "scheduled" &&
      typeof meeting.scheduledFor === "number" &&
      meeting.scheduledFor <= now
    ) {
      await ctx.db.patch(args.meetingId, {
        status: "active",
        startedAt: meeting.startedAt ?? now,
        lastActivityAt: now,
      });

      // A scheduled meeting just went live: tell connected apps (outbox, same transaction).
      if (isConnectorEnabled()) {
        const started = await ctx.db.get(args.meetingId);
        if (started) {
          await emitMeetingLifecycle(ctx, "meeting.started", started, actorFromIdentity(identity));
        }
      }
    }

    const nextRole =
      existing?.role ??
      invite?.role ??
      (meeting.hostUserTokenIdentifier === identity.tokenIdentifier ? "host" : "participant");

    const participantPatch = {
      clerkId: identity.subject,
      name: getIdentityName(identity),
      imageUrl: identity.pictureUrl,
      role: nextRole,
      status: decision.status,
      requestedAt: now,
      joinedAt: decision.status === "joined" ? now : (existing?.joinedAt ?? now),
      admittedAt: decision.status === "joined" ? now : existing?.admittedAt,
      leftAt: decision.status === "joined" ? undefined : existing?.leftAt,
      removedAt: undefined,
      rejectedAt: undefined,
      removedByParticipantId: undefined,
      rejoinBlocked: false,
      lastSeenAt: now,
      isMutedByModerator: false,
      isMicEnabled: false,
      isCameraEnabled: false,
      isScreenSharing: false,
    } satisfies Partial<Doc<"meeting_participants">>;

    let participantId: Id<"meeting_participants">;
    if (existing) {
      await ctx.db.patch(existing._id, participantPatch);
      participantId = existing._id;
    } else {
      participantId = await ctx.db.insert("meeting_participants", {
        meetingId: args.meetingId,
        userTokenIdentifier: identity.tokenIdentifier,
        clerkId: identity.subject,
        name: getIdentityName(identity),
        imageUrl: identity.pictureUrl,
        role: nextRole,
        permissionsOverride: undefined,
        status: decision.status,
        createdAt: now,
        requestedAt: now,
        joinedAt: decision.status === "joined" ? now : now,
        admittedAt: decision.status === "joined" ? now : undefined,
        leftAt: undefined,
        removedAt: undefined,
        rejectedAt: undefined,
        removedByParticipantId: undefined,
        rejoinBlocked: false,
        lastSeenAt: now,
        isMutedByModerator: false,
        isMicEnabled: false,
        isCameraEnabled: false,
        isScreenSharing: false,
      });
    }

    await ctx.db.patch(args.meetingId, {
      lastActivityAt: now,
    });

    if (invite && decision.status === "joined" && resolveInviteStatus(invite) !== "accepted") {
      await ctx.db.patch(invite._id, {
        status: "accepted",
        acceptedAt: now,
        respondedAt: now,
      });

      if (isConnectorEnabled()) {
        await emitInviteAccepted(ctx, meeting, invite, actorFromIdentity(identity));
      }
    }

    await insertAuditLog(ctx, {
      meetingId: args.meetingId,
      actorParticipantId: participantId,
      actorName: getIdentityName(identity),
      action:
        decision.status === "joined" ? "participant_joined" : "participant_waiting",
    });

    return {
      participantId: decision.status === "joined" ? participantId : null,
      participantStatus: decision.status,
      reason: decision.reason,
    };
  },
});

export const leave = mutation({
  args: {
    meetingId: v.id("meetings"),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const meeting = await assertMeetingAccess(ctx, identity.tokenIdentifier, args.meetingId);
    const participant = await getMeetingParticipant(
      ctx,
      args.meetingId,
      identity.tokenIdentifier,
    );
    if (!participant) {
      return null;
    }

    await maybeTransferHost(ctx, {
      meeting,
      leavingParticipant: participant,
    });

    await ctx.db.patch(participant._id, {
      status: "left",
      leftAt: Date.now(),
      isScreenSharing: false,
      isMicEnabled: false,
      isCameraEnabled: false,
      lastSeenAt: Date.now(),
    });

    await insertAuditLog(ctx, {
      meetingId: args.meetingId,
      actorParticipantId: participant._id,
      actorName: participant.name,
      action: "participant_left",
    });

    return participant._id;
  },
});

export const heartbeat = mutation({
  args: {
    meetingId: v.id("meetings"),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const participant = await requireJoinedParticipant(
      ctx,
      args.meetingId,
      identity.tokenIdentifier,
    );

    await ctx.db.patch(participant._id, {
      lastSeenAt: Date.now(),
    });

    return participant._id;
  },
});

export const updateMedia = mutation({
  args: {
    meetingId: v.id("meetings"),
    isMicEnabled: v.boolean(),
    isCameraEnabled: v.boolean(),
    isScreenSharing: v.boolean(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const participant = await getMeetingParticipant(
      ctx,
      args.meetingId,
      identity.tokenIdentifier,
    );

    // Media sync calls can race with join/leave transitions during mount,
    // teardown, or moderation changes. Treat those windows as a harmless no-op
    // instead of surfacing a server error in the client console.
    if (!participant || participant.status !== "joined") {
      return null;
    }

    const meeting = await assertMeetingAccess(ctx, identity.tokenIdentifier, args.meetingId);

    if (participant.role === "viewer" && (args.isMicEnabled || args.isCameraEnabled || args.isScreenSharing)) {
      throw new Error("Viewers cannot publish audio or video");
    }

    if (args.isScreenSharing && !hasMeetingPermission(meeting, participant, "canShareScreen")) {
      throw new Error("Screen sharing is disabled for you");
    }

    if (args.isMicEnabled && !hasMeetingPermission(meeting, participant, "canUnmuteSelf")) {
      throw new Error("You cannot unmute yourself right now");
    }

    await ctx.db.patch(participant._id, {
      isMicEnabled: args.isMicEnabled,
      isCameraEnabled: args.isCameraEnabled,
      isScreenSharing: args.isScreenSharing,
      isMutedByModerator: args.isMicEnabled ? false : participant.isMutedByModerator,
      lastSeenAt: Date.now(),
    });

    return participant._id;
  },
});

export const list = query({
  args: {
    meetingId: v.id("meetings"),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    await assertMeetingAccess(ctx, identity.tokenIdentifier, args.meetingId);
    const participant = await getMeetingParticipant(
      ctx,
      args.meetingId,
      identity.tokenIdentifier,
    );
    if (!participant || participant.status !== "joined") {
      return [];
    }
    return await listMeetingParticipantsByStatus(ctx, args.meetingId, "joined");
  },
});

export const listWaitingRoom = query({
  args: {
    meetingId: v.id("meetings"),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const meeting = await assertMeetingAccess(ctx, identity.tokenIdentifier, args.meetingId);
    const participant = await requireJoinedParticipant(
      ctx,
      args.meetingId,
      identity.tokenIdentifier,
    );

    if (!hasMeetingPermission(meeting, participant, "canAdmitOthers")) {
      throw new Error("You do not have permission to manage the waiting room");
    }

    return await listMeetingParticipantsByStatus(ctx, args.meetingId, "waiting");
  },
});

export const admit = mutation({
  args: {
    meetingId: v.id("meetings"),
    participantId: v.id("meeting_participants"),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const meeting = await assertMeetingAccess(ctx, identity.tokenIdentifier, args.meetingId);
    const actor = await requireJoinedParticipant(ctx, args.meetingId, identity.tokenIdentifier);

    if (!hasMeetingPermission(meeting, actor, "canAdmitOthers")) {
      throw new Error("You do not have permission to admit participants");
    }

    const target = await ctx.db.get(args.participantId);
    if (!target || target.meetingId !== args.meetingId) {
      throw new Error("Participant not found");
    }

    await ctx.db.patch(target._id, {
      status: "joined",
      admittedAt: Date.now(),
      leftAt: undefined,
      removedAt: undefined,
      rejectedAt: undefined,
      rejoinBlocked: false,
      removedByParticipantId: undefined,
      lastSeenAt: Date.now(),
    });

    await insertAuditLog(ctx, {
      meetingId: args.meetingId,
      actorParticipantId: actor._id,
      actorName: actor.name,
      action: "participant_admitted",
      targetParticipantId: target._id,
      targetName: target.name,
    });

    return target._id;
  },
});

export const bulkAdmit = mutation({
  args: {
    meetingId: v.id("meetings"),
    participantIds: v.array(v.id("meeting_participants")),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const meeting = await assertMeetingAccess(ctx, identity.tokenIdentifier, args.meetingId);
    const actor = await requireJoinedParticipant(ctx, args.meetingId, identity.tokenIdentifier);

    if (!hasMeetingPermission(meeting, actor, "canAdmitOthers")) {
      throw new Error("You do not have permission to admit participants");
    }

    const admitted: Id<"meeting_participants">[] = [];
    for (const participantId of args.participantIds) {
      const target = await ctx.db.get(participantId);
      if (!target || target.meetingId !== args.meetingId) {
        continue;
      }

      await ctx.db.patch(participantId, {
        status: "joined",
        admittedAt: Date.now(),
        leftAt: undefined,
        removedAt: undefined,
        rejectedAt: undefined,
        rejoinBlocked: false,
        removedByParticipantId: undefined,
        lastSeenAt: Date.now(),
      });
      admitted.push(participantId);
    }

    await insertAuditLog(ctx, {
      meetingId: args.meetingId,
      actorParticipantId: actor._id,
      actorName: actor.name,
      action: "participants_bulk_admitted",
      metadata: JSON.stringify({ count: admitted.length }),
    });

    return admitted;
  },
});

export const reject = mutation({
  args: {
    meetingId: v.id("meetings"),
    participantId: v.id("meeting_participants"),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const meeting = await assertMeetingAccess(ctx, identity.tokenIdentifier, args.meetingId);
    const actor = await requireJoinedParticipant(ctx, args.meetingId, identity.tokenIdentifier);

    if (!hasMeetingPermission(meeting, actor, "canAdmitOthers")) {
      throw new Error("You do not have permission to reject participants");
    }

    const target = await ctx.db.get(args.participantId);
    if (!target || target.meetingId !== args.meetingId) {
      throw new Error("Participant not found");
    }

    await ctx.db.patch(target._id, {
      status: "rejected",
      rejectedAt: Date.now(),
      leftAt: Date.now(),
      isMicEnabled: false,
      isCameraEnabled: false,
      isScreenSharing: false,
    });

    await insertAuditLog(ctx, {
      meetingId: args.meetingId,
      actorParticipantId: actor._id,
      actorName: actor.name,
      action: "participant_rejected",
      targetParticipantId: target._id,
      targetName: target.name,
    });

    return target._id;
  },
});

export const updateRole = mutation({
  args: {
    meetingId: v.id("meetings"),
    participantId: v.id("meeting_participants"),
    role: meetingRoleValidator,
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const meeting = await assertMeetingAccess(ctx, identity.tokenIdentifier, args.meetingId);
    const actor = await requireJoinedParticipant(ctx, args.meetingId, identity.tokenIdentifier);

    if (!hasMeetingPermission(meeting, actor, "canManageRoles")) {
      throw new Error("You do not have permission to change participant roles");
    }

    if (args.role === "host") {
      throw new Error("Use host transfer flow instead of manually assigning host");
    }

    const target = await ctx.db.get(args.participantId);
    if (!target || target.meetingId !== args.meetingId) {
      throw new Error("Participant not found");
    }

    if (!canManageParticipantRole(actor, target)) {
      throw new Error("You cannot change this participant's role");
    }

    await ctx.db.patch(target._id, {
      role: args.role,
    });

    await insertAuditLog(ctx, {
      meetingId: args.meetingId,
      actorParticipantId: actor._id,
      actorName: actor.name,
      action: "participant_role_updated",
      targetParticipantId: target._id,
      targetName: target.name,
      metadata: JSON.stringify({ role: args.role }),
    });

    return target._id;
  },
});

export const setParticipantAudio = mutation({
  args: {
    meetingId: v.id("meetings"),
    participantId: v.id("meeting_participants"),
    isMicEnabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const meeting = await assertMeetingAccess(ctx, identity.tokenIdentifier, args.meetingId);
    const actor = await requireJoinedParticipant(ctx, args.meetingId, identity.tokenIdentifier);

    if (!hasMeetingPermission(meeting, actor, "canMuteOthers")) {
      throw new Error("You do not have permission to control participant audio");
    }

    const target = await ctx.db.get(args.participantId);
    if (!target || target.meetingId !== args.meetingId) {
      throw new Error("Participant not found");
    }

    if (!canManageParticipantRole(actor, target)) {
      throw new Error("You cannot control this participant");
    }

    await ctx.db.patch(target._id, {
      isMicEnabled: args.isMicEnabled,
      isMutedByModerator: !args.isMicEnabled,
      lastSeenAt: Date.now(),
    });

    await insertAuditLog(ctx, {
      meetingId: args.meetingId,
      actorParticipantId: actor._id,
      actorName: actor.name,
      action: args.isMicEnabled ? "participant_unmuted" : "participant_muted",
      targetParticipantId: target._id,
      targetName: target.name,
    });

    return target._id;
  },
});

export const removeParticipant = mutation({
  args: {
    meetingId: v.id("meetings"),
    participantId: v.id("meeting_participants"),
    allowRejoin: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const meeting = await assertMeetingAccess(ctx, identity.tokenIdentifier, args.meetingId);
    const actor = await requireJoinedParticipant(ctx, args.meetingId, identity.tokenIdentifier);

    if (!hasMeetingPermission(meeting, actor, "canRemoveParticipants")) {
      throw new Error("You do not have permission to remove participants");
    }

    const target = await ctx.db.get(args.participantId);
    if (!target || target.meetingId !== args.meetingId) {
      throw new Error("Participant not found");
    }

    if (actor._id === target._id) {
      throw new Error("You cannot remove yourself");
    }

    if (!canManageParticipantRole(actor, target)) {
      throw new Error("You cannot remove this participant");
    }

    await ctx.db.patch(target._id, {
      status: "removed",
      removedAt: Date.now(),
      leftAt: Date.now(),
      removedByParticipantId: actor._id,
      rejoinBlocked: !(args.allowRejoin ?? false),
      isMutedByModerator: true,
      isMicEnabled: false,
      isCameraEnabled: false,
      isScreenSharing: false,
    });

    await insertAuditLog(ctx, {
      meetingId: args.meetingId,
      actorParticipantId: actor._id,
      actorName: actor.name,
      action: "participant_removed",
      targetParticipantId: target._id,
      targetName: target.name,
      metadata: JSON.stringify({ allowRejoin: args.allowRejoin ?? false }),
    });

    return target._id;
  },
});

export const restoreParticipant = mutation({
  args: {
    meetingId: v.id("meetings"),
    participantId: v.id("meeting_participants"),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const meeting = await assertMeetingAccess(ctx, identity.tokenIdentifier, args.meetingId);
    const actor = await requireJoinedParticipant(ctx, args.meetingId, identity.tokenIdentifier);

    if (!hasMeetingPermission(meeting, actor, "canRemoveParticipants")) {
      throw new Error("You do not have permission to restore participant access");
    }

    const target = await ctx.db.get(args.participantId);
    if (!target || target.meetingId !== args.meetingId) {
      throw new Error("Participant not found");
    }

    await ctx.db.patch(target._id, {
      status: "left",
      rejoinBlocked: false,
      removedAt: undefined,
      rejectedAt: undefined,
      removedByParticipantId: undefined,
    });

    await insertAuditLog(ctx, {
      meetingId: args.meetingId,
      actorParticipantId: actor._id,
      actorName: actor.name,
      action: "participant_restored",
      targetParticipantId: target._id,
      targetName: target.name,
    });

    return target._id;
  },
});
