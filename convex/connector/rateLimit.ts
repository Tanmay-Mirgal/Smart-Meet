import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export type RateLimitBucket = "rpm" | "notif";

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds when the current window resets. */
  resetAt: number;
  retryAfterSeconds: number;
};

const WINDOW_MS = 60_000;

/**
 * Fixed-window counter per (grant, bucket), stored in the database so every
 * serverless instance shares it (CP1 §3). Over-limit calls do not increment.
 */
export async function consumeRateLimit(
  ctx: MutationCtx,
  grantId: Id<"connector_grants">,
  bucket: RateLimitBucket,
  limit: number,
  now: number,
): Promise<RateLimitResult> {
  const window = Math.floor(now / WINDOW_MS);
  const key = `${bucket}:${window}`;
  const resetAtMs = (window + 1) * WINDOW_MS;
  const resetAt = Math.ceil(resetAtMs / 1000);

  const row = await ctx.db
    .query("connector_ratelimits")
    .withIndex("by_grantId_and_bucket", (q) =>
      q.eq("grantId", grantId).eq("bucket", key),
    )
    .unique();

  const used = row?.count ?? 0;
  if (used >= limit) {
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - now) / 1000)),
    };
  }

  if (row) {
    await ctx.db.patch(row._id, { count: used + 1 });
  } else {
    await ctx.db.insert("connector_ratelimits", {
      grantId,
      bucket: key,
      count: 1,
      expiresAt: resetAtMs + WINDOW_MS,
    });
  }

  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - used - 1),
    resetAt,
    retryAfterSeconds: 0,
  };
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(result.resetAt),
  };
  if (!result.allowed) {
    headers["Retry-After"] = String(result.retryAfterSeconds);
  }
  return headers;
}
