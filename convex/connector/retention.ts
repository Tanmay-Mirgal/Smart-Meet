import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { TTL } from "./config";

/**
 * Daily retention (CP1 §4.4), always in bounded batches:
 *   events 7 d · deliveries 14 d · operations 7 d · idempotency 24 h ·
 *   authorization codes right after expiry · audit 90 d · rate-limit windows ·
 *   rotated-refresh tombstones once the refresh token itself could have expired.
 * A full batch re-schedules the job so a backlog drains without one huge transaction.
 */

const DAY = 24 * 60 * 60 * 1000;
const BATCH = 200;

export const run = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    let backlog = false;

    const purge = async (rows: Array<{ _id: never } | { _id: unknown }>) => {
      for (const row of rows) await ctx.db.delete(row._id as never);
      if (rows.length === BATCH) backlog = true;
    };

    // Rows come back oldest-first, so the expired ones are always at the front.
    // (A fully expired batch of BATCH rows sets `backlog` in `purge`, so the job re-runs.)
    const expired = <T extends { _creationTime: number }>(rows: T[], cutoff: number) =>
      rows.filter((row) => row._creationTime < cutoff);
    const oldestEvents = await ctx.db.query("connector_events").order("asc").take(BATCH);
    await purge(expired(oldestEvents, now - 7 * DAY));
    const oldestDeliveries = await ctx.db.query("connector_deliveries").order("asc").take(BATCH);
    await purge(expired(oldestDeliveries, now - 14 * DAY));
    const oldestOperations = await ctx.db.query("connector_operations").order("asc").take(BATCH);
    await purge(expired(oldestOperations, now - 7 * DAY));
    await purge(
      await ctx.db
        .query("connector_idempotency")
        .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
        .take(BATCH),
    );
    await purge(
      await ctx.db
        .query("connector_codes")
        .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
        .take(BATCH),
    );
    await purge(
      await ctx.db
        .query("connector_audit")
        .withIndex("by_createdAt", (q) => q.lt("createdAt", now - 90 * DAY))
        .take(BATCH),
    );
    await purge(
      await ctx.db
        .query("connector_ratelimits")
        .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
        .take(BATCH),
    );
    await purge(
      await ctx.db
        .query("connector_refresh_history")
        .withIndex("by_retiredAt", (q) => q.lt("retiredAt", now - TTL.refreshMs - DAY))
        .take(BATCH),
    );

    if (backlog) {
      await ctx.scheduler.runAfter(0, internal.connector.retention.run, {});
    }
    return null;
  },
});
