import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { computeOrganizationPlan } from "../billing/index";
import { loadActiveGrant } from "./grantAccess";
import { getTenantInfo, getUserInfo } from "./subject";

/**
 * Connector read/execute functions. Each one starts with `loadActiveGrant`,
 * which re-verifies the grant and the user's live membership inside the same
 * transaction as the data access (CP1 §2.4, C08/C09).
 */

export const me = internalQuery({
  args: { grantId: v.id("connector_grants"), now: v.number() },
  returns: v.object({
    user: v.object({
      id: v.string(),
      email: v.union(v.string(), v.null()),
      name: v.string(),
    }),
    tenant: v.object({
      id: v.string(),
      name: v.string(),
      kind: v.literal("organization"),
    }),
    scopes: v.array(v.string()),
    grantId: v.string(),
    plan: v.object({
      name: v.string(),
      limits: v.object({ maxMeetings: v.union(v.number(), v.null()) }),
      usage: v.object({
        meetingsUsed: v.number(),
        meetingsRemaining: v.union(v.number(), v.null()),
      }),
    }),
    capabilities: v.object({
      aiSummary: v.boolean(),
      recording: v.boolean(),
      notionExport: v.boolean(),
      googleCalendarSync: v.boolean(),
      meetingsUsed: v.number(),
      meetingsCap: v.union(v.number(), v.null()),
    }),
  }),
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
