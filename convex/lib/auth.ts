import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { getMeetingPageAccess } from "./meetingPermissions";
import { getMeetingParticipant } from "./meetinghelpers";
import { normalizeInviteEmail, resolveInviteStatus } from "./invitations";

type ConvexCtx = QueryCtx | MutationCtx;

export async function requireIdentity(ctx: ConvexCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Unauthenticated");
  }
  return identity;
}

export function getIdentityName(
  identity: Awaited<ReturnType<typeof requireIdentity>>,
) {
  return identity.name ?? identity.email ?? "Meetup User";
}

export async function getCurrentUserRecord(
  ctx: ConvexCtx,
  tokenIdentifier: string,
) {
  const user = await ctx.db
    .query("users")
    .withIndex("by_tokenIdentifier", (q) =>
      q.eq("tokenIdentifier", tokenIdentifier),
    )
    .unique();

  if (user) return user;

  // Fallback: If user hasn't signed in yet to run syncUser, their record
  // is keyed only by their clerkId from the webhook.
  const clerkId = tokenIdentifier.includes("|")
    ? tokenIdentifier.split("|")[1]
    : tokenIdentifier;

  return await ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId))
    .unique();
}

export async function getUserRecordByEmail(
  ctx: ConvexCtx,
  email: string | null | undefined,
) {
  if (!email) {
    return null;
  }

  return await ctx.db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", normalizeInviteEmail(email)))
    .unique();
}

export async function assertOrgAccess(
  ctx: ConvexCtx,
  tokenIdentifier: string,
  orgId: string,
) {
  const hasAccess = await hasOrgAccess(ctx, tokenIdentifier, orgId);
  const user = await getCurrentUserRecord(ctx, tokenIdentifier);

  if (!hasAccess) {
    throw new Error("Forbidden");
  }

  return user;
}

export async function hasOrgAccess(
  ctx: ConvexCtx,
  tokenIdentifier: string,
  orgId: string,
) {
  // Use the indexed join table instead of the orgIds array field.
  // This is O(1), correctly tracked by Convex for reactive invalidation,
  // and works even if the user record has not been fully synced yet
  // (the membership row is written by syncUser on every sign-in).
  let membership = await ctx.db
    .query("user_org_memberships")
    .withIndex("by_userTokenIdentifier_and_orgId", (q) =>
      q.eq("userTokenIdentifier", tokenIdentifier).eq("orgId", orgId),
    )
    .unique();

  if (!membership) {
    // Fallback: If the user was just added via webhook and their token hasn't been
    // upgraded by syncUser yet, their membership is keyed by the raw clerkId.
    const clerkId = tokenIdentifier.includes("|")
      ? tokenIdentifier.split("|")[1]
      : tokenIdentifier;

    membership = await ctx.db
      .query("user_org_memberships")
      .withIndex("by_userTokenIdentifier_and_orgId", (q) =>
        q.eq("userTokenIdentifier", clerkId).eq("orgId", orgId),
      )
      .unique();
  }

  if (!membership) {
    // Legacy fallback: for users created before the `user_org_memberships`
    // table was introduced, check their `orgIds` array directly.
    const user = await getCurrentUserRecord(ctx, tokenIdentifier);
    if (user && user.orgIds.includes(orgId)) {
      return true;
    }
    return false;
  }

  return true;
}

export async function hasMeetingInvite(
  ctx: ConvexCtx,
  meetingId: Id<"meetings">,
  email: string | null | undefined,
  tokenIdentifier?: string | null,
) {
  if (tokenIdentifier) {
    const inviteByUser = await ctx.db
      .query("meeting_invites")
      .withIndex("by_invitedUserTokenIdentifier_and_meetingId", (q) =>
        q.eq("invitedUserTokenIdentifier", tokenIdentifier).eq("meetingId", meetingId),
      )
      .unique();

    if (inviteByUser) {
      const status = resolveInviteStatus(inviteByUser);
      if (status === "pending" || status === "accepted") {
        return true;
      }
    }
  }

  if (!email) {
    return false;
  }

  const normalizedEmail = normalizeInviteEmail(email);
  const invite = await ctx.db
    .query("meeting_invites")
    .withIndex("by_meetingId_and_email", (q) =>
      q.eq("meetingId", meetingId).eq("email", normalizedEmail),
    )
    .unique();

  if (!invite) {
    return false;
  }

  const status = resolveInviteStatus(invite);
  return status === "pending" || status === "accepted";
}

export async function assertMeetingAccess(
  ctx: ConvexCtx,
  tokenIdentifier: string,
  meetingId: Id<"meetings">,
) {
  const meeting = await ctx.db.get(meetingId);
  if (!meeting) {
    throw new Error("Meeting not found");
  }

  const user = await getCurrentUserRecord(ctx, tokenIdentifier);
  const participant = await getMeetingParticipant(ctx, meetingId, tokenIdentifier);
  const isOrgMember = await hasOrgAccess(ctx, tokenIdentifier, meeting.orgId);
  const isInvited = await hasMeetingInvite(ctx, meetingId, user?.email ?? null, tokenIdentifier);

  if (
    !getMeetingPageAccess({
      meeting,
      isOrgMember,
      isInvited,
      participant,
    })
  ) {
    throw new Error("Forbidden");
  }

  return meeting;
}

export function assertMeetingHost(
  participant: Pick<Doc<"meeting_participants">, "role"> | null,
) {
  if (!participant || participant.role !== "host") {
    throw new Error("Only the host can perform this action");
  }
}
