import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { hasOrgAccess } from "../lib/auth";
import { writeAudit } from "./audit";
import { LIMITS, TTL } from "./config";
import { timingSafeEqualStrings } from "./crypto";
import { ACCESS_TOKEN_PREFIX, findGrantByAccessToken } from "./grantAccess";
import { consumeRateLimit } from "./rateLimit";

const rateValidator = v.object({
  limit: v.number(),
  remaining: v.number(),
  resetAt: v.number(),
  retryAfterSeconds: v.number(),
});

const subjectValidator = v.object({
  grantId: v.id("connector_grants"),
  orgId: v.string(),
  clientId: v.string(),
  userTokenIdentifier: v.string(),
});

const gateResult = v.union(
  v.object({
    ok: v.literal(true),
    grantId: v.id("connector_grants"),
    orgId: v.string(),
    clientId: v.string(),
    userTokenIdentifier: v.string(),
    scopes: v.array(v.string()),
    rate: rateValidator,
  }),
  v.object({
    ok: v.literal(false),
    status: v.number(),
    code: v.string(),
    message: v.string(),
    requiredScope: v.optional(v.string()),
    // Present once the token itself was valid, so the failure can be audited.
    grant: v.optional(subjectValidator),
    rate: v.optional(rateValidator),
  }),
);

function deny(
  status: number,
  code: string,
  message: string,
  extra: {
    requiredScope?: string;
    grant?: {
      grantId: import("../_generated/dataModel").Id<"connector_grants">;
      orgId: string;
      clientId: string;
      userTokenIdentifier: string;
    };
    rate?: { limit: number; remaining: number; resetAt: number; retryAfterSeconds: number };
  } = {},
) {
  return { ok: false as const, status, code, message, ...extra };
}

/**
 * CP1 §2.4 request-time authorisation for every `/api/connect/v1/*` call that
 * needs a bearer token:
 *   1. token → HMAC lookup, reject unknown/expired/revoked      → 401
 *   2. per-grant rate limit (shared via the database)            → 429
 *   3. required scope(s)                                         → 403 insufficient_scope
 *   4. the consenting user must STILL be in the pinned org       → 403 forbidden
 *   5. `lastUsedAt` is written at most once every 5 minutes
 *
 * Expected failures are returned (not thrown) so the rate-limit counter and
 * lastUsedAt writes made along the way still commit.
 */
export const authorize = internalMutation({
  args: {
    token: v.string(),
    requiredScopes: v.array(v.string()),
    now: v.number(),
  },
  returns: gateResult,
  handler: async (ctx, args) => {
    const { now } = args;
    const invalid = () => deny(401, "unauthorized", "Missing or invalid access token");

    if (!args.token.startsWith(ACCESS_TOKEN_PREFIX)) return invalid();

    const { hash, grant } = await findGrantByAccessToken(ctx, args.token);
    if (!grant || !timingSafeEqualStrings(grant.accessHash, hash)) return invalid();
    if (grant.revokedAt !== undefined || grant.accessExpiresAt <= now) return invalid();

    const subject = {
      grantId: grant._id,
      orgId: grant.orgId,
      clientId: grant.clientId,
      userTokenIdentifier: grant.userTokenIdentifier,
    };

    // C13
    const rate = await consumeRateLimit(ctx, grant._id, "rpm", LIMITS.requestsPerMinute, now);
    const rateInfo = {
      limit: rate.limit,
      remaining: rate.remaining,
      resetAt: rate.resetAt,
      retryAfterSeconds: rate.retryAfterSeconds,
    };
    if (!rate.allowed) {
      return deny(429, "rate_limited", "Rate limit exceeded. Retry after the indicated delay.", {
        grant: subject,
        rate: rateInfo,
      });
    }

    // C07
    const missing = args.requiredScopes.find((scope) => !grant.scopes.includes(scope));
    if (missing) {
      return deny(403, "insufficient_scope", `This connection was not granted the ${missing} scope.`, {
        requiredScope: missing,
        grant: subject,
        rate: rateInfo,
      });
    }

    // C09: the user's CURRENT standing is checked on every call.
    if (!(await hasOrgAccess(ctx, grant.userTokenIdentifier, grant.orgId))) {
      return deny(
        403,
        "forbidden",
        "The connected user no longer has access to this organization in Meetup.",
        { grant: subject, rate: rateInfo },
      );
    }

    if (grant.lastUsedAt === undefined || now - grant.lastUsedAt >= TTL.lastUsedWriteIntervalMs) {
      await ctx.db.patch(grant._id, { lastUsedAt: now });
    }

    return { ok: true as const, ...subject, scopes: grant.scopes, rate: rateInfo };
  },
});

/** Post-hoc audit row for a finished connector request (CP1 §6). */
export const recordAudit = internalMutation({
  args: {
    grantId: v.id("connector_grants"),
    action: v.string(),
    method: v.string(),
    status: v.number(),
    requestId: v.string(),
    errorCode: v.optional(v.string()),
    meetingId: v.optional(v.id("meetings")),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const grant = await ctx.db.get(args.grantId);
    if (!grant) return null;
    await writeAudit(
      ctx,
      {
        grant,
        action: args.action,
        method: args.method,
        status: args.status,
        requestId: args.requestId,
        errorCode: args.errorCode,
        meetingId: args.meetingId,
      },
      args.now,
    );
    return null;
  },
});
