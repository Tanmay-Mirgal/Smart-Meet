import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { getIdentityName, hasOrgAccess, requireIdentity } from "../lib/auth";
import { buildRedirectUrl, validateAuthorizeParams } from "./authorize";
import {
  TTL,
  getConnectorConfig,
  getMissingConfig,
  isConnectorEnabled,
} from "./config";
import { generateToken, hashSecret } from "./crypto";
import { scopeDescription, withImpliedScopes } from "./scopes";

/**
 * Server side of the consent screen (`app/connect/authorize`). The page calls
 * these as the signed-in Clerk user. ALL validation lives here, so the page
 * can never talk the backend into issuing a code for an unvetted request.
 */

const authorizeArgs = {
  clientId: v.optional(v.string()),
  redirectUri: v.optional(v.string()),
  responseType: v.optional(v.string()),
  scope: v.optional(v.string()),
  state: v.optional(v.string()),
  codeChallenge: v.optional(v.string()),
  codeChallengeMethod: v.optional(v.string()),
};

const prepareResult = v.union(
  v.object({ status: v.literal("disabled") }),
  // Client or redirect URI untrusted: show an error page, never redirect.
  v.object({ status: v.literal("fatal"), reason: v.string(), message: v.string() }),
  // Registered redirect URI, bad request: report the error back to the client.
  v.object({ status: v.literal("redirect"), redirectUrl: v.string() }),
  v.object({
    status: v.literal("ready"),
    hubName: v.string(),
    user: v.object({ name: v.string(), email: v.union(v.string(), v.null()) }),
    scopes: v.array(v.object({ name: v.string(), description: v.string() })),
    organizations: v.array(
      v.object({
        id: v.string(),
        name: v.string(),
        imageUrl: v.optional(v.union(v.string(), v.null())),
      }),
    ),
    cancelUrl: v.string(),
  }),
);

export const prepare = query({
  args: authorizeArgs,
  returns: prepareResult,
  handler: async (ctx, args) => {
    if (!isConnectorEnabled()) {
      return { status: "disabled" as const };
    }
    if (getMissingConfig().length > 0) {
      return {
        status: "fatal" as const,
        reason: "misconfigured",
        message: "Connecting apps is not available right now. Please contact your administrator.",
      };
    }

    const config = getConnectorConfig();
    const result = validateAuthorizeParams(args, {
      clientId: config.clientId,
      redirectUris: config.redirectUris,
    });

    if (!result.ok) {
      if (result.kind === "fatal") {
        return { status: "fatal" as const, reason: result.reason, message: result.message };
      }
      return {
        status: "redirect" as const,
        redirectUrl: buildRedirectUrl(result.redirectUri, {
          error: result.error,
          error_description: result.description,
          state: result.state,
        }),
      };
    }

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return {
        status: "fatal" as const,
        reason: "unauthenticated",
        message: "Please sign in to Meetup to continue.",
      };
    }

    // Eligible tenants: the organizations this user belongs to. (Meetup stores
    // membership, not Clerk roles, so every membership can satisfy every scope;
    // meeting-level rights are still enforced on each call.)
    const orgIds = new Set<string>();
    for (const key of new Set([identity.tokenIdentifier, identity.subject])) {
      const memberships = await ctx.db
        .query("user_org_memberships")
        .withIndex("by_userTokenIdentifier_and_orgId", (q) => q.eq("userTokenIdentifier", key))
        .take(50);
      for (const membership of memberships) orgIds.add(membership.orgId);
    }

    const organizations = [];
    for (const orgId of orgIds) {
      const organization = await ctx.db
        .query("organizations")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", orgId))
        .unique();
      organizations.push({
        id: orgId,
        name: organization?.name ?? "Workspace",
        imageUrl: organization?.imageUrl ?? undefined,
      });
    }

    if (organizations.length === 0) {
      const userName = getIdentityName(identity);
      organizations.push({
        id: identity.subject,
        name: `${userName}'s Workspace`,
      });
    }

    organizations.sort((a, b) => a.name.localeCompare(b.name));

    return {
      status: "ready" as const,
      hubName: config.hubName,
      user: { name: getIdentityName(identity), email: identity.email ?? null },
      scopes: withImpliedScopes(result.scopes).map((name) => ({
        name,
        description: scopeDescription(name),
      })),
      organizations,
      cancelUrl: buildRedirectUrl(result.redirectUri, {
        error: "access_denied",
        error_description: "The user denied the request.",
        state: result.state,
      }),
    };
  },
});

export const approve = mutation({
  args: { ...authorizeArgs, orgId: v.string() },
  returns: v.object({ redirectUrl: v.string() }),
  handler: async (ctx, args) => {
    if (!isConnectorEnabled() || getMissingConfig().length > 0) {
      throw new Error("Connecting apps is not available");
    }

    const config = getConnectorConfig();
    const { orgId, ...params } = args;
    const result = validateAuthorizeParams(params, {
      clientId: config.clientId,
      redirectUris: config.redirectUris,
    });
    if (!result.ok) {
      throw new Error("Invalid authorization request");
    }

    const identity = await requireIdentity(ctx);
    // A grant is pinned to exactly one tenant, and only one the user belongs to.
    const isPersonal = orgId === identity.subject || orgId === identity.tokenIdentifier;
    if (!isPersonal && !(await hasOrgAccess(ctx, identity.tokenIdentifier, orgId))) {
      throw new Error("Forbidden");
    }

    // ≥ 32 random bytes, single use, 60 s, bound to client/user/tenant/scopes/
    // redirect_uri/code_challenge. Only its HMAC is stored.
    const code = generateToken("cp1c_meetup_", 32);
    await ctx.db.insert("connector_codes", {
      codeHash: await hashSecret(code),
      clientId: result.clientId,
      userTokenIdentifier: identity.tokenIdentifier,
      orgId,
      scopes: withImpliedScopes(result.scopes),
      redirectUri: result.redirectUri,
      codeChallenge: result.codeChallenge,
      expiresAt: Date.now() + TTL.codeMs,
    });

    return {
      redirectUrl: buildRedirectUrl(result.redirectUri, { code, state: result.state }),
    };
  },
});
