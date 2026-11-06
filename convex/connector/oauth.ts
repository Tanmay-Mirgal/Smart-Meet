import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { actorFromTokenIdentifier } from "../lib/actor";
import { hasOrgAccess } from "../lib/auth";
import { hashSecret, timingSafeEqualStrings, verifyPkceS256 } from "./crypto";
import { parseScopeParam } from "./scopes";
import { mintTokenPair, revokeGrantCore } from "./grantAccess";
import { getTenantInfo, getUserInfo } from "./subject";

/**
 * OAuth 2.0 token endpoint logic (CP1 §2.2, §2.3). Called by the httpAction in
 * router.ts after it has authenticated the client.
 *
 * These mutations RETURN failures instead of throwing: several rejections must
 * still commit a write (burning a used code, revoking a grant on token reuse),
 * and a thrown error would roll that write back.
 */

const tokenSuccess = v.object({
  ok: v.literal(true),
  access_token: v.string(),
  refresh_token: v.string(),
  expires_in: v.number(),
  scope: v.string(),
  tenant: v.object({
    id: v.string(),
    name: v.string(),
    kind: v.literal("organization"),
  }),
  user: v.object({
    id: v.string(),
    email: v.union(v.string(), v.null()),
    name: v.string(),
  }),
});

const tokenFailure = v.object({
  ok: v.literal(false),
  error: v.string(),
  description: v.string(),
});

const tokenResult = v.union(tokenSuccess, tokenFailure);

function fail(error: string, description: string) {
  return { ok: false as const, error, description };
}

const INVALID_CODE = "The authorization code is invalid, expired or already used.";
const INVALID_REFRESH = "The refresh token is invalid, expired or already used.";

export const exchangeCode = internalMutation({
  args: {
    clientId: v.string(),
    code: v.string(),
    redirectUri: v.string(),
    codeVerifier: v.string(),
    now: v.number(),
  },
  returns: tokenResult,
  handler: async (ctx, args) => {
    const { now } = args;
    const codeHash = await hashSecret(args.code);
    const code = await ctx.db
      .query("connector_codes")
      .withIndex("by_codeHash", (q) => q.eq("codeHash", codeHash))
      .unique();

    if (!code) {
      return fail("invalid_grant", INVALID_CODE);
    }

    if (code.usedAt !== undefined) {
      // C03: a code is single use. Presenting it again means it may have been
      // stolen, so revoke whatever was issued from it (RFC 6749 §4.1.2).
      if (code.grantId) {
        const issued = await ctx.db.get(code.grantId);
        if (issued) await revokeGrantCore(ctx, issued, "authorization_code_reuse", now);
      }
      return fail("invalid_grant", INVALID_CODE);
    }

    // Burn the code before any further check: whatever happens next, it can
    // never be tried again (also stops verifier brute-forcing).
    await ctx.db.patch(code._id, { usedAt: now });

    if (code.expiresAt <= now) return fail("invalid_grant", INVALID_CODE);
    if (code.clientId !== args.clientId) return fail("invalid_grant", INVALID_CODE);

    // C04: the redirect_uri must be byte-identical to the one authorized.
    if (!timingSafeEqualStrings(code.redirectUri, args.redirectUri)) {
      return fail("invalid_grant", "redirect_uri does not match the authorization request.");
    }

    // C02: PKCE is mandatory; a wrong verifier fails.
    if (!(await verifyPkceS256(args.codeVerifier, code.codeChallenge))) {
      return fail("invalid_grant", "code_verifier does not match the code_challenge.");
    }

    if (!(await hasOrgAccess(ctx, code.userTokenIdentifier, code.orgId))) {
      return fail("invalid_grant", "The user no longer belongs to the organization.");
    }
    const actor = await actorFromTokenIdentifier(ctx, code.userTokenIdentifier);
    if (!actor) {
      return fail("invalid_grant", "The user no longer exists.");
    }

    const tokens = await mintTokenPair(now);
    const grantId = await ctx.db.insert("connector_grants", {
      clientId: code.clientId,
      userTokenIdentifier: code.userTokenIdentifier,
      orgId: code.orgId,
      scopes: code.scopes,
      accessHash: tokens.accessHash,
      accessExpiresAt: tokens.accessExpiresAt,
      refreshHash: tokens.refreshHash,
      refreshExpiresAt: tokens.refreshExpiresAt,
      refreshFamilyId: crypto.randomUUID(),
      createdAt: now,
    });
    await ctx.db.patch(code._id, { grantId });

    return {
      ok: true as const,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_in: Math.floor((tokens.accessExpiresAt - now) / 1000),
      scope: code.scopes.join(" "),
      tenant: await getTenantInfo(ctx, code.orgId),
      user: await getUserInfo(ctx, code.userTokenIdentifier),
    };
  },
});

export const refresh = internalMutation({
  args: {
    clientId: v.string(),
    refreshToken: v.string(),
    scope: v.optional(v.string()),
    now: v.number(),
  },
  returns: tokenResult,
  handler: async (ctx, args) => {
    const { now } = args;
    const refreshHash = await hashSecret(args.refreshToken);
    const grant = await ctx.db
      .query("connector_grants")
      .withIndex("by_refreshHash", (q) => q.eq("refreshHash", refreshHash))
      .unique();

    if (!grant) {
      // C05: a refresh token that was already rotated away is being replayed.
      // Treat it as theft of the token family and revoke the whole grant.
      const retired = await ctx.db
        .query("connector_refresh_history")
        .withIndex("by_refreshHash", (q) => q.eq("refreshHash", refreshHash))
        .unique();
      if (retired) {
        const family = await ctx.db.get(retired.grantId);
        if (family) await revokeGrantCore(ctx, family, "refresh_token_reuse", now);
      }
      return fail("invalid_grant", INVALID_REFRESH);
    }

    if (
      grant.clientId !== args.clientId ||
      grant.revokedAt !== undefined ||
      grant.refreshExpiresAt <= now
    ) {
      return fail("invalid_grant", INVALID_REFRESH);
    }

    if (!(await hasOrgAccess(ctx, grant.userTokenIdentifier, grant.orgId))) {
      await revokeGrantCore(ctx, grant, "membership_lost", now);
      return fail("invalid_grant", "The user no longer belongs to the organization.");
    }

    if (args.scope) {
      const { scopes, unknown } = parseScopeParam(args.scope);
      const allowed = new Set(grant.scopes);
      if (unknown.length > 0 || scopes.some((scope) => !allowed.has(scope))) {
        return fail("invalid_scope", "Requested scope exceeds the scope granted by the user.");
      }
    }

    // Rotate: the old refresh token is retired (kept as a tombstone) and the
    // old access token stops working because its hash is overwritten.
    const tokens = await mintTokenPair(now);
    await ctx.db.insert("connector_refresh_history", {
      refreshHash: grant.refreshHash,
      grantId: grant._id,
      retiredAt: now,
    });
    await ctx.db.patch(grant._id, {
      accessHash: tokens.accessHash,
      accessExpiresAt: tokens.accessExpiresAt,
      refreshHash: tokens.refreshHash,
      refreshExpiresAt: tokens.refreshExpiresAt,
    });

    return {
      ok: true as const,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_in: Math.floor((tokens.accessExpiresAt - now) / 1000),
      scope: grant.scopes.join(" "),
      tenant: await getTenantInfo(ctx, grant.orgId),
      user: await getUserInfo(ctx, grant.userTokenIdentifier),
    };
  },
});

/** RFC 7009: unknown tokens are not an error; the caller always answers 200. */
export const revokeToken = internalMutation({
  args: {
    token: v.string(),
    // Set only when the caller proved it is the registered client.
    clientId: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const hash = await hashSecret(args.token);
    const grant =
      (await ctx.db
        .query("connector_grants")
        .withIndex("by_accessHash", (q) => q.eq("accessHash", hash))
        .unique()) ??
      (await ctx.db
        .query("connector_grants")
        .withIndex("by_refreshHash", (q) => q.eq("refreshHash", hash))
        .unique());

    if (grant && (args.clientId === undefined || grant.clientId === args.clientId)) {
      await revokeGrantCore(ctx, grant, "revoked_by_client", args.now);
    }
    return null;
  },
});
