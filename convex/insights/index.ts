import { query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import { v, type ObjectType } from "convex/values";
import { actorFromIdentity, type Actor } from "../lib/actor";
import { assertOrgAccess, requireIdentity } from "../lib/auth";

const getInsightsArgs = {
  orgId: v.string(),
};

export async function getInsightsCore(
  ctx: QueryCtx,
  actor: Actor,
  args: ObjectType<typeof getInsightsArgs>,
) {
  await assertOrgAccess(ctx, actor.tokenIdentifier, args.orgId);
  const meetings = await ctx.db
    .query("meetings")
    .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
    .order("desc")
    .take(50);

  const activeCount = meetings.filter(
    (meeting) => meeting.status === "active",
  ).length;
  const endedCount = meetings.filter(
    (meeting) => meeting.status === "ended",
  ).length;

  return {
    totals: {
      meetings: meetings.length,
      active: activeCount,
      ended: endedCount,
    },
    timeline: meetings.map((meeting) => ({
      id: meeting._id,
      title: meeting.title,
      status: meeting.status,
      createdAt: meeting._creationTime,
    })),
  };
}

export const get = query({
  args: getInsightsArgs,
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    return await getInsightsCore(ctx, actorFromIdentity(identity), args);
  },
});
