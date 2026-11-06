import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { actorFromTokenIdentifier, type Actor } from "../lib/actor";
import { hasOrgAccess } from "../lib/auth";
import { TTL } from "./config";
import { generateToken, hashSecret } from "./crypto";
import { ConnectorError, toConvexError } from "./errors";

export const ACCESS_TOKEN_PREFIX = "cp1_meetup_";
export const REFRESH_TOKEN_PREFIX = "cp1r_meetup_";

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  accessHash: string;
  refreshHash: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
};

/** Mints an access + refresh token. Only the HMACs are ever persisted. */
export async function mintTokenPair(now: number): Promise<TokenPair> {
  const accessToken = generateToken(ACCESS_TOKEN_PREFIX);
  const refreshToken = generateToken(REFRESH_TOKEN_PREFIX);
  return {
    accessToken,
    refreshToken,
    accessHash: await hashSecret(accessToken),
    refreshHash: await hashSecret(refreshToken),
    accessExpiresAt: now + TTL.accessMs,
    refreshExpiresAt: now + TTL.refreshMs,
  };
}

/**
 * Revokes a grant immediately (CP1 §2.3). Every later request using one of its
 * tokens fails, and the webhook endpoints it created are disabled so nothing is
 * delivered on behalf of a connection the user has cut.
 */
export async function revokeGrantCore(
  ctx: MutationCtx,
  grant: Doc<"connector_grants">,
  reason: string,
  now: number,
) {
  if (grant.revokedAt === undefined) {
    await ctx.db.patch(grant._id, { revokedAt: now, revokedReason: reason });
  }

  const webhooks = await ctx.db
    .query("connector_webhooks")
    .withIndex("by_grantId", (q) => q.eq("grantId", grant._id))
    .take(50);

  for (const webhook of webhooks) {
    if (webhook.status === "active") {
      await ctx.db.patch(webhook._id, {
        status: "disabled",
        disabledReason: "grant_revoked",
        disabledAt: now,
        updatedAt: now,
      });
    }

    const pending = await ctx.db
      .query("connector_deliveries")
      .withIndex("by_webhookId", (q) => q.eq("webhookId", webhook._id))
      .take(200);
    for (const delivery of pending) {
      if (delivery.status === "pending") {
        await ctx.db.patch(delivery._id, { status: "cancelled", finishedAt: now });
      }
    }
  }
}

function reject(code: ConnectorError["code"], message: string): never {
  throw toConvexError(new ConnectorError(code, message));
}

/**
 * Every connector function starts here. It re-reads the grant and re-checks, on
 * EVERY request, that the consenting user is still allowed (CP1 §2.4): a token
 * can never outlive the user's membership or do more than the user could.
 *
 * Throws a ConvexError carrying a CP1 error, so callers inside a mutation roll
 * back and the router can turn it into the standard error response.
 */
export async function loadActiveGrant(
  ctx: QueryCtx | MutationCtx,
  grantId: Id<"connector_grants">,
  now: number,
  options: { ignoreAccessExpiry?: boolean } = {},
): Promise<{ grant: Doc<"connector_grants">; actor: Actor }> {
  const grant = await ctx.db.get(grantId);

  if (
    !grant ||
    grant.revokedAt !== undefined ||
    (!options.ignoreAccessExpiry && grant.accessExpiresAt <= now)
  ) {
    return reject("unauthorized", "Missing or invalid access token");
  }

  if (!(await hasOrgAccess(ctx, grant.userTokenIdentifier, grant.orgId))) {
    return reject(
      "forbidden",
      "The connected user no longer has access to this organization in Meetup.",
    );
  }

  const actor = await actorFromTokenIdentifier(ctx, grant.userTokenIdentifier);
  if (!actor) {
    return reject("forbidden", "The connected user no longer exists in Meetup.");
  }

  // Marked so events caused by this call carry actor.kind = "connector".
  return { grant, actor: { ...actor, via: "connector" } };
}

/** Looks up a grant row by its (hashed) access token. */
export async function findGrantByAccessToken(ctx: QueryCtx | MutationCtx, token: string) {
  const hash = await hashSecret(token);
  const grant = await ctx.db
    .query("connector_grants")
    .withIndex("by_accessHash", (q) => q.eq("accessHash", hash))
    .unique();
  return { hash, grant };
}
