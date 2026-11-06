import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { TTL } from "./config";

export type IdempotencyBegin =
  | { kind: "fresh" }
  | { kind: "replay"; status: number; response: string }
  | { kind: "conflict" };

/**
 * Idempotency for POST actions (CP1 §3).
 *
 * `begin` and `complete` run inside the SAME Convex mutation as the action
 * they protect, so they are atomic with it: either the action committed and
 * its response is stored, or neither happened. Two simultaneous requests with
 * one key are serialised by Convex's optimistic concurrency control — the
 * loser retries, finds the stored response and replays it.
 */
export async function beginIdempotent(
  ctx: MutationCtx,
  grantId: Id<"connector_grants">,
  key: string,
  requestHash: string,
  now: number,
): Promise<IdempotencyBegin> {
  const existing = await ctx.db
    .query("connector_idempotency")
    .withIndex("by_grantId_and_key", (q) =>
      q.eq("grantId", grantId).eq("key", key),
    )
    .unique();

  if (!existing) return { kind: "fresh" };

  if (existing.expiresAt <= now) {
    await ctx.db.delete(existing._id);
    return { kind: "fresh" };
  }

  if (existing.requestHash !== requestHash) {
    return { kind: "conflict" };
  }

  return { kind: "replay", status: existing.status, response: existing.response };
}

export async function completeIdempotent(
  ctx: MutationCtx,
  grantId: Id<"connector_grants">,
  key: string,
  requestHash: string,
  status: number,
  response: string,
  now: number,
) {
  await ctx.db.insert("connector_idempotency", {
    grantId,
    key,
    requestHash,
    status,
    response,
    createdAt: now,
    expiresAt: now + TTL.idempotencyMs,
  });
}
