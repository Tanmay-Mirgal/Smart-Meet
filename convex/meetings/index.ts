import { mutation, query } from "../_generated/server";
import { v, type ObjectType } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { actorFromIdentity, type Actor } from "../lib/actor";
import { isConnectorEnabled } from "../connector/config";
import {
  emitMeetingLifecycle,
  emitSummaryReady,
  scheduleEndTriggers,
} from "../connector/events";
import { getOrganizationPlanCore } from "../billing/index";
import { getGoogleCalendarConnectionCore } from "../integrations/index";
import { InputError, PlanLimitError, PreconditionError } from "../lib/errors";
import type { ExternalRef } from "../lib/connectorFields";
import {
  assertMeetingAccess,
  assertMeetingHost,
  assertOrgAccess,
  getIdentityName,
  getUserRecordByEmail,
  hasMeetingInvite,
  hasOrgAccess,
  requireIdentity,
} from "../lib/auth";
import {
  getMeetingParticipant,
  listActiveParticipants,
  listMeetingParticipantsByStatus,
  getMeetingDuration,
} from "../lib/meetinghelpers";
import {
  createEmptyMeetingPermissionMap,
  getDefaultMeetingSettings,
  hasMeetingPermission,
  meetingRoleValidator,
  meetingSettingsValidator,
  resolveJoinDecision,
  resolveParticipantPermissions,
  type MeetingSettings,
} from "../lib/meetingPermissions";
import {
  normalizeInviteEmailList,
  resolveInviteStatus,
} from "../lib/invitations";
import { formatMeetingTimeRange } from "../../lib/meeting-schedule";
import {
  getInvitationEmailConfig,
  getInvitationEmailConfigError,
} from "../../lib/invitation-email-config";
import { buildPublicAppUrl } from "../../lib/public-app-url";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function createInviteAccessToken() {
  return crypto.randomUUID().replace(/-/g, "");
}

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

async function getOrganizationName(ctx: MutationCtx, orgId: string) {
  const organization = await ctx.db
    .query("organizations")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", orgId))
    .unique();

  return organization?.name ?? "Workspace";
}

async function createOrRefreshInviteNotification(
  ctx: MutationCtx,
  args: {
    inviteId: Id<"meeting_invites">;
    meetingId: Id<"meetings">;
    orgId: string;
    userTokenIdentifier: string;
    meetingTitle: string;
    inviterName: string;
  },
) {
  const existing = await ctx.db
    .query("notifications")
    .withIndex("by_userTokenIdentifier_and_invitationId", (q) =>
      q
        .eq("userTokenIdentifier", args.userTokenIdentifier)
        .eq("invitationId", args.inviteId),
    )
    .unique();

  const payload = {
    kind: "meeting_invitation",
    title: "Meeting invitation",
    message: `You’ve been invited to ${args.meetingTitle} by ${args.inviterName}`,
    link: "/dashboard#invitation-inbox",
    invitationId: args.inviteId,
    meetingId: args.meetingId,
    isRead: false,
    createdAt: Date.now(),
  } as const;

  if (existing) {
    await ctx.db.patch(existing._id, payload);
    return existing._id;
  }

  return await ctx.db.insert("notifications", {
    userTokenIdentifier: args.userTokenIdentifier,
    orgId: args.orgId,
    ...payload,
  });
}

async function deliverInvite(
  ctx: MutationCtx,
  args: {
    inviteId: Id<"meeting_invites">;
    meetingId: Id<"meetings">;
    orgId: string;
    meetingTitle: string;
    inviterName: string;
    email: string;
    scheduledFor?: number;
    scheduledEndsAt?: number;
    scheduledTimeZone?: string;
    inviteToken: string;
  },
) {
  const invitationEmailConfig = getInvitationEmailConfig();
  const invitedUser = await getUserRecordByEmail(ctx, args.email);
  if (invitedUser) {
    await createOrRefreshInviteNotification(ctx, {
      inviteId: args.inviteId,
      meetingId: args.meetingId,
      orgId: args.orgId,
      userTokenIdentifier: invitedUser.tokenIdentifier,
      meetingTitle: args.meetingTitle,
      inviterName: args.inviterName,
    });
  }

  await ctx.db.patch(args.inviteId, {
    invitedUserTokenIdentifier: invitedUser?.tokenIdentifier,
    lastNotificationAt: invitedUser ? Date.now() : undefined,
    emailDeliveryStatus: invitationEmailConfig ? "pending" : "failed",
    lastEmailError: invitationEmailConfig
      ? undefined
      : getInvitationEmailConfigError(),
  });

  const organizationName = await getOrganizationName(ctx, args.orgId);
  const meetingLink = buildPublicAppUrl("/dashboard#invitation-inbox");
  const calendarBaseUrl = buildPublicAppUrl(
    `/api/invitations/${args.inviteId}/calendar`,
  );
  if (invitationEmailConfig) {
    await ctx.scheduler.runAfter(0, internal.invitationsDelivery.sendMeetingInviteEmail, {
      inviteId: args.inviteId,
      toEmail: args.email,
      meetingTitle: args.meetingTitle,
      organizerName: args.inviterName,
      organizationName,
      meetingLink: meetingLink ?? undefined,
      scheduledFor: args.scheduledFor,
      scheduledEndsAt: args.scheduledEndsAt,
      scheduledTimeZone: args.scheduledTimeZone,
      scheduledLabel:
        typeof args.scheduledFor === "number" && typeof args.scheduledEndsAt === "number"
          ? formatMeetingTimeRange(
              args.scheduledFor,
              args.scheduledEndsAt,
              args.scheduledTimeZone,
            )
          : undefined,
      calendarBaseUrl: calendarBaseUrl ?? undefined,
      inviteToken: args.inviteToken,
    });
  }
}

async function archiveInviteNotifications(
  ctx: MutationCtx,
  args: {
    inviteId: Id<"meeting_invites">;
    message: string;
  },
) {
  const invite = await ctx.db.get(args.inviteId);
  if (!invite?.invitedUserTokenIdentifier) {
    return;
  }

  const notification = await ctx.db
    .query("notifications")
    .withIndex("by_userTokenIdentifier_and_invitationId", (q) =>
      q
        .eq("userTokenIdentifier", invite.invitedUserTokenIdentifier!)
        .eq("invitationId", args.inviteId),
    )
    .unique();

  if (!notification) {
    return;
  }

  await ctx.db.patch(notification._id, {
    message: args.message,
    isRead: true,
  });
}

async function requireWhiteboardEditorAccess(
  ctx: MutationCtx,
  meetingId: Id<"meetings">,
  userTokenIdentifier: string,
) {
  const meeting = await assertMeetingAccess(ctx, userTokenIdentifier, meetingId);
  const participant = await getMeetingParticipant(ctx, meetingId, userTokenIdentifier);

  if (!participant || participant.status !== "joined") {
    throw new Error("Join the meeting before using the whiteboard");
  }

  const permissions = resolveParticipantPermissions(meeting, participant);
  if (!permissions.canUseWhiteboard) {
    throw new Error("You do not have permission to present the whiteboard");
  }

  return { meeting, participant };
}

const createMeetingArgs = {
  orgId: v.string(),
  title: v.string(),
  purpose: v.optional(v.string()),
  description: v.optional(v.string()),
  scheduledFor: v.optional(v.number()),
  scheduledEndsAt: v.optional(v.number()),
  scheduledTimeZone: v.optional(v.string()),
  syncWithGoogleCalendar: v.optional(v.boolean()),
  settings: v.optional(meetingSettingsValidator),
  inviteEmails: v.optional(v.array(v.string())),
};

/**
 * Everything the browser sends, plus the optional correlation fields the
 * ecosystem connector sets. `settings` is partial because defaults are merged
 * in below; the browser always sends a complete object.
 */
export type CreateMeetingInput = Omit<
  ObjectType<typeof createMeetingArgs>,
  "settings"
> & {
  settings?: Partial<MeetingSettings>;
  createdVia?: "connector";
  externalRef?: ExternalRef;
  metadataJson?: string;
};

export async function createMeetingCore(
  ctx: MutationCtx,
  actor: Actor,
  args: CreateMeetingInput,
): Promise<Id<"meetings">> {
  await assertOrgAccess(ctx, actor.tokenIdentifier, args.orgId);
  const billing = await getOrganizationPlanCore(ctx, actor, args.orgId);
  const now = Date.now();
  const isScheduled =
    typeof args.scheduledFor === "number" && args.scheduledFor > now;
  const settings = getDefaultMeetingSettings(args.settings);
  const shouldSyncWithGoogleCalendar =
    isScheduled && args.syncWithGoogleCalendar === true;

  if (
    typeof args.scheduledFor === "number" &&
    typeof args.scheduledEndsAt === "number" &&
    args.scheduledEndsAt <= args.scheduledFor
  ) {
    throw new InputError(
      "Meeting end time must be after the start time",
      "scheduledEndsAt",
    );
  }

  if (args.syncWithGoogleCalendar && !isScheduled) {
    throw new InputError(
      "Google Calendar sync is only available for scheduled meetings",
      "syncWithGoogleCalendar",
    );
  }

  if (billing.usage.meetingsLimitReached) {
    throw new PlanLimitError(
      billing.maxMeetings === null
        ? "This workspace cannot create more meetings right now."
        : `This workspace has reached its ${billing.maxMeetings}-meeting limit. Upgrade the plan to create more meetings.`,
      { limit: billing.maxMeetings, feature: "maxMeetings" },
    );
  }

  if (shouldSyncWithGoogleCalendar && !billing.features.googleCalendarSync) {
    throw new PlanLimitError(
      "Google Calendar sync is only available on paid workspace plans",
      { feature: "googleCalendarSync" },
    );
  }

  if (shouldSyncWithGoogleCalendar) {
    const googleCalendarConnection = await getGoogleCalendarConnectionCore(
      ctx,
      actor,
      args.orgId,
    );

    if (!googleCalendarConnection?.connected) {
      throw new PreconditionError(
        "Connect Google Calendar before enabling calendar sync",
        "/integrations",
      );
    }
  }

  const meetingId = await ctx.db.insert("meetings", {
    orgId: args.orgId,
    title: args.title,
    purpose: args.purpose ?? args.description ?? args.title,
    description: args.description,
    creatorTokenIdentifier: actor.tokenIdentifier,
    creatorClerkId: actor.clerkId,
    creatorName: actor.displayName,
    hostUserTokenIdentifier: actor.tokenIdentifier,
    hostClerkId: actor.clerkId,
    status: isScheduled ? "scheduled" : "active",
    isLocked: false,
    settings,
    scheduledFor: args.scheduledFor,
    scheduledEndsAt: args.scheduledEndsAt,
    scheduledTimeZone: args.scheduledTimeZone,
    startedAt: isScheduled ? undefined : now,
    googleCalendarSyncRequested: shouldSyncWithGoogleCalendar || undefined,
    googleCalendarSyncStatus: shouldSyncWithGoogleCalendar ? "pending" : undefined,
    googleCalendarEventId: undefined,
    googleCalendarEventUrl: undefined,
    googleCalendarLastSyncedAt: undefined,
    googleCalendarSyncError: undefined,
    lastActivityAt: now,
    createdVia: args.createdVia,
    externalRef: args.externalRef,
    metadataJson: args.metadataJson,
  });

  await ctx.db.insert("meeting_participants", {
    meetingId,
    userTokenIdentifier: actor.tokenIdentifier,
    clerkId: actor.clerkId,
    name: actor.displayName,
    imageUrl: actor.imageUrl,
    role: "host",
    permissionsOverride: undefined,
    status: "left",
    createdAt: now,
    requestedAt: now,
    joinedAt: now,
    admittedAt: undefined,
    leftAt: now,
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

  const inviteEmails = normalizeInviteEmailList(args.inviteEmails ?? []);

  for (const email of inviteEmails) {
    const inviteToken = createInviteAccessToken();
    const inviteId = await ctx.db.insert("meeting_invites", {
      meetingId,
      orgId: args.orgId,
      email,
      invitedUserTokenIdentifier: undefined,
      role: "participant",
      invitedByTokenIdentifier: actor.tokenIdentifier,
      invitedByName: actor.displayName,
      token: inviteToken,
      status: "pending",
      expiresAt: now + INVITE_TTL_MS,
      lastSentAt: now,
      acceptedAt: undefined,
      declinedAt: undefined,
      cancelledAt: undefined,
      respondedAt: undefined,
      lastNotificationAt: undefined,
      emailDeliveryStatus: "pending",
      lastEmailAttemptAt: undefined,
      lastEmailError: undefined,
      createdAt: now,
    });

    await deliverInvite(ctx, {
      inviteId,
      meetingId,
      orgId: args.orgId,
      meetingTitle: args.title,
      inviterName: actor.displayName,
      email,
      scheduledFor: args.scheduledFor,
      scheduledEndsAt: args.scheduledEndsAt,
      scheduledTimeZone: args.scheduledTimeZone,
      inviteToken,
    });
  }

  const memberships = await ctx.db
    .query("user_org_memberships")
    .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
    .collect();

  for (const membership of memberships) {
    await ctx.db.insert("notifications", {
      userTokenIdentifier: membership.userTokenIdentifier,
      orgId: args.orgId,
      message: isScheduled
        ? `New meeting scheduled: ${args.title}`
        : `${actor.displayName} started ${args.title}`,
      link: `/meeting/${meetingId}`,
      isRead: false,
      createdAt: now,
    });
  }

  if (shouldSyncWithGoogleCalendar) {
    await ctx.scheduler.runAfter(
      0,
      internal.integrations.index.syncMeetingToGoogleCalendar,
      { meetingId },
    );
  }

  // Outbox: written in this same transaction (a single env check when disabled).
  if (isConnectorEnabled()) {
    const created = await ctx.db.get(meetingId);
    if (created) {
      await emitMeetingLifecycle(
        ctx,
        isScheduled ? "meeting.scheduled" : "meeting.started",
        created,
        actor,
      );
    }
  }

  return meetingId;
}

export const create = mutation({
  args: createMeetingArgs,
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    return await createMeetingCore(ctx, actorFromIdentity(identity), args);
  },
});

const getMeetingArgs = { meetingId: v.id("meetings") };

export async function getMeetingCore(
  ctx: QueryCtx,
  actor: Actor,
  args: ObjectType<typeof getMeetingArgs>,
) {
  const meeting = await assertMeetingAccess(ctx, actor.tokenIdentifier, args.meetingId);
  const participant = await getMeetingParticipant(
    ctx,
    args.meetingId,
    actor.tokenIdentifier,
  );
  const isOrgMember = await hasOrgAccess(
    ctx,
    actor.tokenIdentifier,
    meeting.orgId,
  );
  const isInvited = await hasMeetingInvite(
    ctx,
    args.meetingId,
    actor.email,
    actor.tokenIdentifier,
  );
  const participants = await listActiveParticipants(ctx, args.meetingId);
  const waitingRoom = hasMeetingPermission(meeting, participant, "canAdmitOthers")
    ? await listMeetingParticipantsByStatus(ctx, args.meetingId, "waiting")
    : [];
  const latestSummary = await ctx.db
    .query("meeting_assets")
    .withIndex("by_meetingId_and_type", (q) =>
      q.eq("meetingId", args.meetingId).eq("type", "summary"),
    )
    .unique();
  const effectivePermissions = participant
    ? resolveParticipantPermissions(meeting, participant)
    : createEmptyMeetingPermissionMap();
  const joinDecision = resolveJoinDecision({
    meeting,
    participant,
    isOrgMember,
    isInvited,
  });

  return {
    ...meeting,
    settings: getDefaultMeetingSettings(meeting.settings),
    durationMs: getMeetingDuration(meeting),
    activeParticipants: participants.length,
    waitingParticipants: waitingRoom.length,
    summary: latestSummary?.content ?? null,
    key_points: latestSummary?.key_points ?? [],
    decisions: latestSummary?.decisions ?? [],
    action_items: latestSummary?.action_items ?? [],
    currentParticipant: participant,
    effectivePermissions,
    joinDecision,
    isOrgMember,
    isInvited,
  };
}

export const get = query({
  args: getMeetingArgs,
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    return await getMeetingCore(ctx, actorFromIdentity(identity), args);
  },
});

export const updateSettings = mutation({
  args: {
    meetingId: v.id("meetings"),
    settings: meetingSettingsValidator,
    isLocked: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const meeting = await assertMeetingAccess(ctx, identity.tokenIdentifier, args.meetingId);
    const participant = await getMeetingParticipant(
      ctx,
      args.meetingId,
      identity.tokenIdentifier,
    );

    if (!hasMeetingPermission(meeting, participant, "canChangeSettings")) {
      throw new Error("You do not have permission to change meeting settings");
    }

    await ctx.db.patch(args.meetingId, {
      settings: getDefaultMeetingSettings(args.settings),
      isLocked: args.isLocked ?? meeting.isLocked,
      lastActivityAt: Date.now(),
    });

    await insertAuditLog(ctx, {
      meetingId: args.meetingId,
      actorParticipantId: participant?._id,
      actorName: participant?.name ?? getIdentityName(identity),
      action: "meeting_settings_updated",
      metadata: JSON.stringify({
        joinMode: args.settings.joinMode,
        isLocked: args.isLocked ?? meeting.isLocked,
      }),
    });
  },
});

export const updateLock = mutation({
  args: {
    meetingId: v.id("meetings"),
    isLocked: v.boolean(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const meeting = await assertMeetingAccess(ctx, identity.tokenIdentifier, args.meetingId);
    const participant = await getMeetingParticipant(
      ctx,
      args.meetingId,
      identity.tokenIdentifier,
    );

    if (!hasMeetingPermission(meeting, participant, "canLockMeeting")) {
      throw new Error("You do not have permission to lock this meeting");
    }

    await ctx.db.patch(args.meetingId, {
      isLocked: args.isLocked,
      lastActivityAt: Date.now(),
    });

    await insertAuditLog(ctx, {
      meetingId: args.meetingId,
      actorParticipantId: participant?._id,
      actorName: participant?.name ?? getIdentityName(identity),
      action: args.isLocked ? "meeting_locked" : "meeting_unlocked",
    });
  },
});

const inviteParticipantsArgs = {
  meetingId: v.id("meetings"),
  emails: v.array(v.string()),
  role: v.optional(meetingRoleValidator),
};

export async function inviteParticipantsCore(
  ctx: MutationCtx,
  actor: Actor,
  args: ObjectType<typeof inviteParticipantsArgs>,
) {
  const meeting = await assertMeetingAccess(ctx, actor.tokenIdentifier, args.meetingId);
  const participant = await getMeetingParticipant(
    ctx,
    args.meetingId,
    actor.tokenIdentifier,
  );

  if (!hasMeetingPermission(meeting, participant, "canChangeSettings")) {
    throw new Error("You do not have permission to invite people");
  }

  const role = args.role ?? "participant";
  const now = Date.now();
  const inserted: string[] = [];
  for (const email of normalizeInviteEmailList(args.emails)) {
    const existing = await ctx.db
      .query("meeting_invites")
      .withIndex("by_meetingId_and_email", (q) =>
        q.eq("meetingId", args.meetingId).eq("email", email),
      )
      .unique();

    if (existing) {
      const resolvedStatus = resolveInviteStatus(existing);
      if (resolvedStatus === "accepted" || resolvedStatus === "pending") {
        continue;
      }

      const inviteToken = existing.token ?? createInviteAccessToken();

      await ctx.db.patch(existing._id, {
        role,
        invitedUserTokenIdentifier: existing.invitedUserTokenIdentifier,
        invitedByTokenIdentifier: actor.tokenIdentifier,
        invitedByName: actor.displayName,
        token: inviteToken,
        status: "pending",
        expiresAt: now + INVITE_TTL_MS,
        lastSentAt: now,
        declinedAt: undefined,
        cancelledAt: undefined,
        respondedAt: undefined,
        lastNotificationAt: undefined,
        emailDeliveryStatus: "pending",
        lastEmailAttemptAt: undefined,
        lastEmailError: undefined,
      });

      await deliverInvite(ctx, {
        inviteId: existing._id,
        meetingId: args.meetingId,
        orgId: meeting.orgId,
        meetingTitle: meeting.title,
        inviterName: participant?.name ?? actor.displayName,
        email,
        scheduledFor: meeting.scheduledFor,
        scheduledEndsAt: meeting.scheduledEndsAt,
        scheduledTimeZone: meeting.scheduledTimeZone,
        inviteToken,
      });
      inserted.push(email);
      continue;
    }

    const inviteToken = createInviteAccessToken();
    const inviteId = await ctx.db.insert("meeting_invites", {
      meetingId: args.meetingId,
      orgId: meeting.orgId,
      email,
      invitedUserTokenIdentifier: undefined,
      role,
      invitedByTokenIdentifier: actor.tokenIdentifier,
      invitedByName: participant?.name ?? actor.displayName,
      token: inviteToken,
      status: "pending",
      expiresAt: now + INVITE_TTL_MS,
      lastSentAt: now,
      acceptedAt: undefined,
      declinedAt: undefined,
      cancelledAt: undefined,
      respondedAt: undefined,
      lastNotificationAt: undefined,
      emailDeliveryStatus: "pending",
      lastEmailAttemptAt: undefined,
      lastEmailError: undefined,
      createdAt: now,
    });
    await deliverInvite(ctx, {
      inviteId,
      meetingId: args.meetingId,
      orgId: meeting.orgId,
      meetingTitle: meeting.title,
      inviterName: participant?.name ?? actor.displayName,
      email,
      scheduledFor: meeting.scheduledFor,
      scheduledEndsAt: meeting.scheduledEndsAt,
      scheduledTimeZone: meeting.scheduledTimeZone,
      inviteToken,
    });
    inserted.push(email);
  }

  await insertAuditLog(ctx, {
    meetingId: args.meetingId,
    actorParticipantId: participant?._id,
    actorName: participant?.name ?? actor.displayName,
    action: "participants_invited",
    metadata: JSON.stringify({ count: inserted.length, role }),
  });

  return inserted;
}

export const inviteParticipants = mutation({
  args: inviteParticipantsArgs,
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    return await inviteParticipantsCore(ctx, actorFromIdentity(identity), args);
  },
});

export const listInvites = query({
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

    if (!hasMeetingPermission(meeting, participant, "canChangeSettings")) {
      throw new Error("You do not have permission to view invites");
    }

    const invites = await ctx.db
      .query("meeting_invites")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", args.meetingId))
      .order("desc")
      .take(200);

    return invites.map((invite) => {
      const resolvedStatus = resolveInviteStatus(invite);
      return {
        ...invite,
        resolvedStatus,
      };
    });
  },
});

export const resendInvite = mutation({
  args: {
    meetingId: v.id("meetings"),
    inviteId: v.id("meeting_invites"),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const meeting = await assertMeetingAccess(ctx, identity.tokenIdentifier, args.meetingId);
    const participant = await getMeetingParticipant(
      ctx,
      args.meetingId,
      identity.tokenIdentifier,
    );

    if (!hasMeetingPermission(meeting, participant, "canChangeSettings")) {
      throw new Error("You do not have permission to resend invites");
    }

    const invite = await ctx.db.get(args.inviteId);
    if (!invite || invite.meetingId !== args.meetingId) {
      throw new Error("Invite not found");
    }
    if ((invite.status ?? "pending") === "accepted") {
      throw new Error("Accepted invites cannot be resent");
    }

    const now = Date.now();
    const inviteToken = invite.token ?? createInviteAccessToken();
    await ctx.db.patch(args.inviteId, {
      token: inviteToken,
      status: "pending",
      expiresAt: now + INVITE_TTL_MS,
      lastSentAt: now,
      declinedAt: undefined,
      respondedAt: undefined,
      cancelledAt: undefined,
      emailDeliveryStatus: "pending",
      lastEmailAttemptAt: undefined,
      lastEmailError: undefined,
    });

    await deliverInvite(ctx, {
      inviteId: args.inviteId,
      meetingId: args.meetingId,
      orgId: meeting.orgId,
      meetingTitle: meeting.title,
      inviterName: participant?.name ?? getIdentityName(identity),
      email: invite.email,
      scheduledFor: meeting.scheduledFor,
      scheduledEndsAt: meeting.scheduledEndsAt,
      scheduledTimeZone: meeting.scheduledTimeZone,
      inviteToken,
    });

    await insertAuditLog(ctx, {
      meetingId: args.meetingId,
      actorParticipantId: participant?._id,
      actorName: participant?.name ?? getIdentityName(identity),
      action: "invite_resent",
      metadata: JSON.stringify({ email: invite.email }),
    });

    return args.inviteId;
  },
});

export const cancelInvite = mutation({
  args: {
    meetingId: v.id("meetings"),
    inviteId: v.id("meeting_invites"),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const meeting = await assertMeetingAccess(ctx, identity.tokenIdentifier, args.meetingId);
    const participant = await getMeetingParticipant(
      ctx,
      args.meetingId,
      identity.tokenIdentifier,
    );

    if (!hasMeetingPermission(meeting, participant, "canChangeSettings")) {
      throw new Error("You do not have permission to cancel invites");
    }

    const invite = await ctx.db.get(args.inviteId);
    if (!invite || invite.meetingId !== args.meetingId) {
      throw new Error("Invite not found");
    }
    if ((invite.status ?? "pending") === "accepted") {
      throw new Error("Accepted invites cannot be cancelled");
    }

    const now = Date.now();
    await ctx.db.patch(args.inviteId, {
      status: "cancelled",
      cancelledAt: now,
      respondedAt: now,
    });

    await archiveInviteNotifications(ctx, {
      inviteId: args.inviteId,
      message: `Meeting invite revoked for ${invite.email}`,
    });

    await insertAuditLog(ctx, {
      meetingId: args.meetingId,
      actorParticipantId: participant?._id,
      actorName: participant?.name ?? getIdentityName(identity),
      action: "invite_cancelled",
      metadata: JSON.stringify({ email: invite.email }),
    });

    return args.inviteId;
  },
});

const endMeetingArgs = { meetingId: v.id("meetings") };

export async function endMeetingCore(
  ctx: MutationCtx,
  actor: Actor,
  args: ObjectType<typeof endMeetingArgs>,
) {
  const meeting = await assertMeetingAccess(ctx, actor.tokenIdentifier, args.meetingId);
  const participant = await getMeetingParticipant(
    ctx,
    args.meetingId,
    actor.tokenIdentifier,
  );
  assertMeetingHost(participant);
  await ctx.db.patch(args.meetingId, {
    status: "ended",
    endedAt: Date.now(),
    lastActivityAt: Date.now(),
  });

  // Auto-clear any notifications linked to this meeting for all org members.
  await ctx.scheduler.runAfter(0, internal.notifications.index.markReadByMeetingId, {
    meetingId: args.meetingId,
    orgId: meeting.orgId,
  });

  await insertAuditLog(ctx, {
    meetingId: args.meetingId,
    actorParticipantId: participant?._id,
    actorName: participant?.name ?? actor.displayName,
    action: "meeting_ended",
  });

  if (isConnectorEnabled()) {
    const ended = await ctx.db.get(args.meetingId);
    if (ended) {
      await emitMeetingLifecycle(ctx, "meeting.ended", ended, actor);
      await scheduleEndTriggers(ctx, ended);
    }
  }
}

export const endMeeting = mutation({
  args: endMeetingArgs,
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    return await endMeetingCore(ctx, actorFromIdentity(identity), args);
  },
});

const getMeetingSummaryArgs = { meetingId: v.id("meetings") };

export async function getMeetingSummaryCore(
  ctx: QueryCtx,
  actor: Actor,
  args: ObjectType<typeof getMeetingSummaryArgs>,
) {
  await assertMeetingAccess(ctx, actor.tokenIdentifier, args.meetingId);
  return await ctx.db
    .query("meeting_assets")
    .withIndex("by_meetingId_and_type", (q) =>
      q.eq("meetingId", args.meetingId).eq("type", "summary"),
    )
    .unique();
}

export const getSummary = query({
  args: getMeetingSummaryArgs,
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    return await getMeetingSummaryCore(ctx, actorFromIdentity(identity), args);
  },
});

export const getWhiteboard = query({
  args: { meetingId: v.id("meetings") },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    await assertMeetingAccess(ctx, identity.tokenIdentifier, args.meetingId);

    return await ctx.db
      .query("meeting_whiteboards")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", args.meetingId))
      .unique();
  },
});

export const setWhiteboardOpen = mutation({
  args: {
    meetingId: v.id("meetings"),
    isOpen: v.boolean(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const { participant } = await requireWhiteboardEditorAccess(
      ctx,
      args.meetingId,
      identity.tokenIdentifier,
    );

    const existing = await ctx.db
      .query("meeting_whiteboards")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", args.meetingId))
      .unique();

    const payload = {
      isOpen: args.isOpen,
      updatedByTokenIdentifier: identity.tokenIdentifier,
      updatedByName: participant.name,
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return existing._id;
    }

    return await ctx.db.insert("meeting_whiteboards", {
      meetingId: args.meetingId,
      scene: undefined,
      ...payload,
    });
  },
});

export const saveWhiteboardScene = mutation({
  args: {
    meetingId: v.id("meetings"),
    scene: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const { participant } = await requireWhiteboardEditorAccess(
      ctx,
      args.meetingId,
      identity.tokenIdentifier,
    );

    if (args.scene.length > 900_000) {
      throw new Error("Whiteboard is too large to save. Please clear some items and try again.");
    }

    const existing = await ctx.db
      .query("meeting_whiteboards")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", args.meetingId))
      .unique();

    const payload = {
      scene: args.scene,
      isOpen: true,
      updatedByTokenIdentifier: identity.tokenIdentifier,
      updatedByName: participant.name,
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return existing._id;
    }

    return await ctx.db.insert("meeting_whiteboards", {
      meetingId: args.meetingId,
      ...payload,
    });
  },
});

const saveSummaryArgs = {
  meetingId: v.id("meetings"),
  summary: v.string(),
  key_points: v.optional(v.array(v.string())),
  decisions: v.optional(v.array(v.string())),
  action_items: v.optional(
    v.array(
      v.object({
        task: v.string(),
        assignee: v.union(v.string(), v.null()),
        due: v.union(v.string(), v.null()),
      }),
    ),
  ),
};

export type SummaryInput = ObjectType<typeof saveSummaryArgs> & {
  /** BCP-47 language of the text, when known (connector-generated summaries). */
  language?: string;
};

/**
 * Stores a summary and reports whether it DIFFERS from what was stored, plus
 * its version. A summary's version starts at 1 and increases only when the
 * saved content changes, so re-saving identical text does not create a new
 * version. (`updatedAt` is still refreshed, exactly as before.)
 */
export async function persistSummary(
  ctx: MutationCtx,
  actor: Actor,
  args: SummaryInput,
): Promise<{ version: number; changed: boolean; meeting: Doc<"meetings"> }> {
  const meeting = await assertMeetingAccess(ctx, actor.tokenIdentifier, args.meetingId);
  const billing = await getOrganizationPlanCore(ctx, actor, meeting.orgId);

  if (!billing.features.aiSummary) {
    throw new PlanLimitError(
      "AI summaries are only available on paid workspace plans",
      { feature: "aiSummary" },
    );
  }

  const existing = await ctx.db
    .query("meeting_assets")
    .withIndex("by_meetingId_and_type", (q) =>
      q.eq("meetingId", args.meetingId).eq("type", "summary"),
    )
    .unique();

  if (existing) {
    const changed =
      existing.content !== args.summary ||
      JSON.stringify(existing.key_points ?? null) !== JSON.stringify(args.key_points ?? null) ||
      JSON.stringify(existing.decisions ?? null) !== JSON.stringify(args.decisions ?? null) ||
      JSON.stringify(existing.action_items ?? null) !== JSON.stringify(args.action_items ?? null);
    const version = (existing.summaryVersion ?? 1) + (changed ? 1 : 0);

    await ctx.db.patch(existing._id, {
      content: args.summary,
      key_points: args.key_points,
      decisions: args.decisions,
      action_items: args.action_items,
      updatedAt: Date.now(),
      summaryVersion: version,
      // New text from a caller that does not know the language must not keep a stale one.
      ...(args.language !== undefined
        ? { language: args.language }
        : changed
          ? { language: undefined }
          : {}),
    });
    // Exactly once per summary version: only a DIFFERENT summary is a new version.
    if (changed) {
      await emitSummaryReady(ctx, actor, meeting, {
        version,
        summary: args.summary,
        key_points: args.key_points,
        decisions: args.decisions,
        action_items: args.action_items,
        language: args.language,
      });
    }
    return { version, changed, meeting };
  }

  await ctx.db.insert("meeting_assets", {
    meetingId: args.meetingId,
    type: "summary",
    content: args.summary,
    key_points: args.key_points,
    decisions: args.decisions,
    action_items: args.action_items,
    updatedAt: Date.now(),
    summaryVersion: 1,
    language: args.language,
  });
  await emitSummaryReady(ctx, actor, meeting, {
    version: 1,
    summary: args.summary,
    key_points: args.key_points,
    decisions: args.decisions,
    action_items: args.action_items,
    language: args.language,
  });
  return { version: 1, changed: true, meeting };
}

export async function saveSummaryCore(
  ctx: MutationCtx,
  actor: Actor,
  args: ObjectType<typeof saveSummaryArgs>,
) {
  await persistSummary(ctx, actor, args);
}

export const saveSummary = mutation({
  args: saveSummaryArgs,
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    return await saveSummaryCore(ctx, actorFromIdentity(identity), args);
  },
});

export const getByOrg = query({
  args: { orgId: v.string() },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    await assertOrgAccess(ctx, identity.tokenIdentifier, args.orgId);
    const meetings = await ctx.db
      .query("meetings")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(50);

    return meetings;
  },
});

export const getMinutesByOrg = query({
  args: { orgId: v.string() },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    await assertOrgAccess(ctx, identity.tokenIdentifier, args.orgId);

    const meetings = await ctx.db
      .query("meetings")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(200);

    const minutes: Array<{
      _id: Id<"meetings">;
      _creationTime: number;
      orgId: string;
      title: string;
      purpose: string;
      status: "scheduled" | "active" | "ended";
      scheduledFor: number | null;
      endedAt: number | null;
      summary: string;
      key_points: string[];
      decisions: string[];
      action_items: Array<{
        task: string;
        assignee: string | null;
        due: string | null;
      }>;
      summaryUpdatedAt: number;
    }> = [];

    for (const meeting of meetings) {
      const summaryAsset = await ctx.db
        .query("meeting_assets")
        .withIndex("by_meetingId_and_type", (q) =>
          q.eq("meetingId", meeting._id).eq("type", "summary"),
        )
        .unique();

      if (!summaryAsset?.content?.trim()) {
        continue;
      }

      minutes.push({
        _id: meeting._id,
        _creationTime: meeting._creationTime,
        orgId: meeting.orgId,
        title: meeting.title,
        purpose: meeting.purpose,
        status: meeting.status,
        scheduledFor: meeting.scheduledFor ?? null,
        endedAt: meeting.endedAt ?? null,
        summary: summaryAsset.content,
        key_points: summaryAsset.key_points ?? [],
        decisions: summaryAsset.decisions ?? [],
        action_items: summaryAsset.action_items ?? [],
        summaryUpdatedAt: summaryAsset.updatedAt,
      });
    }

    return minutes;
  },
});

export const getDashboardFeed = query({
  args: { orgId: v.string() },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    await assertOrgAccess(ctx, identity.tokenIdentifier, args.orgId);
    const meetings = await ctx.db
      .query("meetings")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(8);

    const totalMeetings = meetings.length;
    const activeMeetings = meetings.filter(
      (meeting) => meeting.status === "active",
    ).length;
    const scheduledMeetings = meetings.filter(
      (meeting) => meeting.status === "scheduled",
    ).length;
    const completedMeetings = meetings.filter(
      (meeting) => meeting.status === "ended",
    ).length;

    return {
      stats: {
        totalMeetings,
        activeMeetings,
        scheduledMeetings,
        completedMeetings,
      },
      meetings,
    };
  },
});
