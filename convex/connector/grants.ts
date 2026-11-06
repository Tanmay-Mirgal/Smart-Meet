import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { assertOrgAccess, getIdentityName, requireIdentity } from "../lib/auth";
import { getConnectorConfig, getMissingConfig, isConnectorEnabled } from "./config";
import { revokeGrantCore } from "./grantAccess";

/**
 * "Connected apps" (CP1 §7.2): what the signed-in user has connected, the
 * health of the webhooks those connections registered, and their recent
 * activity. Users only ever see — and can only revoke — their OWN grants.
 */

const grantView = v.object({
  id: v.id("connector_grants"),
  clientName: v.string(),
  clientId: v.string(),
  orgId: v.string(),
  scopes: v.array(v.string()),
  connectedBy: v.string(),
  createdAt: v.number(),
  lastUsedAt: v.union(v.number(), v.null()),
  webhooks: v.array(
    v.object({
      id: v.id("connector_webhooks"),
      url: v.string(),
      status: v.union(v.literal("active"), v.literal("disabled")),
      disabledReason: v.union(v.string(), v.null()),
      consecutiveFailures: v.number(),
      lastDeliveryStatus: v.union(v.literal("succeeded"), v.literal("failed"), v.null()),
      lastDeliveryAt: v.union(v.number(), v.null()),
    }),
  ),
});

const activityView = v.object({
  grantId: v.id("connector_grants"),
  action: v.string(),
  method: v.string(),
  status: v.number(),
  ok: v.boolean(),
  errorCode: v.union(v.string(), v.null()),
  createdAt: v.number(),
});

export const listForOrg = query({
  args: { orgId: v.string() },
  returns: v.object({
    enabled: v.boolean(),
    hubName: v.string(),
    grants: v.array(grantView),
    activity: v.array(activityView),
  }),
  handler: async (ctx, args) => {
    // With the flag off this is a pure env check: no identity, no reads.
    if (!isConnectorEnabled()) {
      return { enabled: false, hubName: "", grants: [], activity: [] };
    }

    const identity = await requireIdentity(ctx);
    await assertOrgAccess(ctx, identity.tokenIdentifier, args.orgId);

    const hubName =
      getMissingConfig().length === 0 ? getConnectorConfig().hubName : "Connected app";

    const rows = await ctx.db
      .query("connector_grants")
      .withIndex("by_userTokenIdentifier_and_orgId", (q) =>
        q.eq("userTokenIdentifier", identity.tokenIdentifier).eq("orgId", args.orgId),
      )
      .order("desc")
      .take(50);
    const active = rows.filter((grant) => grant.revokedAt === undefined).slice(0, 20);

    const grants = [];
    const activity = [];
    for (const grant of active) {
      const webhooks = await ctx.db
        .query("connector_webhooks")
        .withIndex("by_grantId", (q) => q.eq("grantId", grant._id))
        .take(10);

      grants.push({
        id: grant._id,
        clientName: hubName,
        clientId: grant.clientId,
        orgId: grant.orgId,
        scopes: grant.scopes,
        connectedBy: getIdentityName(identity),
        createdAt: grant.createdAt,
        lastUsedAt: grant.lastUsedAt ?? null,
        webhooks: webhooks.map((webhook) => ({
          id: webhook._id,
          url: webhook.url,
          status: webhook.status,
          disabledReason: webhook.disabledReason ?? null,
          consecutiveFailures: webhook.consecutiveFailures,
          lastDeliveryStatus: webhook.lastDeliveryStatus ?? null,
          lastDeliveryAt: webhook.lastDeliveryAt ?? null,
        })),
      });

      const recent = await ctx.db
        .query("connector_audit")
        .withIndex("by_grantId_and_createdAt", (q) => q.eq("grantId", grant._id))
        .order("desc")
        .take(20);
      for (const entry of recent) {
        activity.push({
          grantId: entry.grantId,
          action: entry.action,
          method: entry.method,
          status: entry.status,
          ok: entry.ok,
          errorCode: entry.errorCode ?? null,
          createdAt: entry.createdAt,
        });
      }
    }

    activity.sort((a, b) => b.createdAt - a.createdAt);
    return { enabled: true, hubName, grants, activity: activity.slice(0, 20) };
  },
});

/**
 * Name shown in "Created via <Hub>" tags. Env-only (no table reads), and only
 * mounted by the tag, which only renders for things created through the connector.
 */
export const hubInfo = query({
  args: {},
  returns: v.object({ enabled: v.boolean(), hubName: v.string() }),
  handler: async (ctx) => {
    await requireIdentity(ctx);
    const enabled = isConnectorEnabled() && getMissingConfig().length === 0;
    return { enabled, hubName: enabled ? getConnectorConfig().hubName : "" };
  },
});

export const revoke = mutation({
  args: { grantId: v.id("connector_grants") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const grant = await ctx.db.get(args.grantId);
    // Someone else's grant is indistinguishable from a missing one.
    if (!grant || grant.userTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Connection not found");
    }
    await revokeGrantCore(ctx, grant, "revoked_by_user", Date.now());
    return null;
  },
});
