import { query, mutation } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { v } from "convex/values";
import { actorFromIdentity, type Actor } from "../lib/actor";
import { assertOrgAccess, requireIdentity } from "../lib/auth";

const DEFAULT_STARTER_BILLING = {
  planKey: "starter" as const,
  planName: "Starter",
  maxMeetings: 10,
  features: {
    unlimitedMeetings: false,
    aiSummary: false,
    notionExport: false,
    recording: false,
    googleCalendarSync: false,
  },
};

function resolveBillingPlan(
  snapshot?: {
    planKey: "starter" | "custom" | "pro";
    planName: string;
    maxMeetings: number | null;
    features: {
      unlimitedMeetings: boolean;
      aiSummary: boolean;
      notionExport: boolean;
      recording: boolean;
      googleCalendarSync: boolean;
    };
    expiresAt?: number;
  } | null,
) {
  if (!snapshot || (snapshot.expiresAt !== undefined && snapshot.expiresAt < Date.now())) {
    return DEFAULT_STARTER_BILLING;
  }

  return {
    planKey: snapshot.planKey,
    planName: snapshot.planName,
    maxMeetings: snapshot.maxMeetings,
    features: {
      ...DEFAULT_STARTER_BILLING.features,
      ...snapshot.features,
    },
  };
}

export const syncOrganizationBillingSnapshot = mutation({
  args: {
    orgId: v.string(),
    planKey: v.union(
      v.literal("starter"),
      v.literal("custom"),
      v.literal("pro"),
    ),
    planName: v.string(),
    maxMeetings: v.union(v.number(), v.null()),
    features: v.object({
      unlimitedMeetings: v.boolean(),
      aiSummary: v.boolean(),
      notionExport: v.boolean(),
      recording: v.boolean(),
      googleCalendarSync: v.boolean(),
    }),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    await assertOrgAccess(ctx, identity.tokenIdentifier, args.orgId);

    const existing = await ctx.db
      .query("organization_billing_snapshots")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .unique();

    const payload = {
      planKey: args.planKey,
      planName: args.planName,
      maxMeetings: args.maxMeetings,
      features: args.features,
      syncedAt: Date.now(),
      expiresAt: args.planKey === "pro" ? (Date.now() + 30 * 24 * 60 * 60 * 1000) : undefined,
      updatedByTokenIdentifier: identity.tokenIdentifier,
    };

    if (existing) {
      // Prevent Clerk sync from downgrading an active Razorpay Pro plan
      if (existing.planKey === "pro" && args.planKey === "starter") {
        const isNotExpired = existing.expiresAt === undefined || existing.expiresAt > Date.now();
        if (isNotExpired) {
          // Keep the existing pro plan, just update the syncedAt
          await ctx.db.patch(existing._id, { syncedAt: Date.now() });
          return existing._id;
        }
      }

      await ctx.db.patch(existing._id, payload);
      return existing._id;
    }

    return await ctx.db.insert("organization_billing_snapshots", {
      orgId: args.orgId,
      ...payload,
    });
  },
});

export type OrganizationPlan = {
  planKey: "starter" | "custom" | "pro";
  planName: string;
  maxMeetings: number | null;
  features: {
    unlimitedMeetings: boolean;
    aiSummary: boolean;
    notionExport: boolean;
    recording: boolean;
    googleCalendarSync: boolean;
  };
  usage: {
    meetingsUsed: number;
    meetingsRemaining: number | null;
    meetingsLimitReached: boolean;
  };
  syncedAt: number | null;
  expiresAt: number | null;
};

/** Plan + usage for an org. Performs NO access check — callers must have done so. */
export async function computeOrganizationPlan(
  ctx: QueryCtx | MutationCtx,
  orgId: string,
): Promise<OrganizationPlan> {
  const snapshot = await ctx.db
    .query("organization_billing_snapshots")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .unique();

  const billing = resolveBillingPlan(snapshot);
  const usageProbeLimit =
    typeof billing.maxMeetings === "number"
      ? billing.maxMeetings + 1
      : 1;
  const meetings = await ctx.db
    .query("meetings")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .take(usageProbeLimit);

  const meetingsUsed =
    typeof billing.maxMeetings === "number"
      ? Math.min(meetings.length, billing.maxMeetings)
      : 0;
  const meetingsLimitReached =
    typeof billing.maxMeetings === "number"
    && meetings.length >= billing.maxMeetings;

  return {
    ...billing,
    usage: {
      meetingsUsed,
      meetingsRemaining:
        typeof billing.maxMeetings === "number"
          ? Math.max(0, billing.maxMeetings - meetingsUsed)
          : null,
      meetingsLimitReached,
    },
    syncedAt: snapshot?.syncedAt ?? null,
    expiresAt: snapshot?.expiresAt ?? null,
  };
}

export async function getOrganizationPlanCore(
  ctx: QueryCtx | MutationCtx,
  actor: Actor,
  orgId: string,
): Promise<OrganizationPlan> {
  await assertOrgAccess(ctx, actor.tokenIdentifier, orgId);
  return await computeOrganizationPlan(ctx, orgId);
}

export const getOrganizationPlan = query({
  args: {
    orgId: v.string(),
  },
  handler: async (ctx, args): Promise<OrganizationPlan> => {
    const identity = await requireIdentity(ctx);
    return await getOrganizationPlanCore(ctx, actorFromIdentity(identity), args.orgId);
  },
});
