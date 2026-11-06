import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { isConnectorEnabled } from "./config";
import { toEnvelope } from "./eventEnvelope";

/**
 * Webhook delivery bookkeeping (CP1 §5). The HTTP call itself is made by the
 * Node action in deliveryNode.ts; everything that touches the database lives here.
 *
 *  - At-least-once: a delivery is retried until it succeeds or is exhausted, and
 *    a sweep re-queues deliveries whose scheduled run was lost.
 *  - Backoff: 10 s, 30 s, 2 m, 10 m, 30 m, 1 h, 3 h, 6 h (8 retries after the
 *    first attempt ≈ 10 h 43 m), each with ±20 % jitter.
 *  - 410 Gone disables the endpoint immediately; 50 consecutive failed
 *    deliveries, or 3 days of failures, disable it with a recorded reason.
 */

export const BACKOFF_MS = [10_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000];
/** The first attempt plus one per backoff step. */
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
export const MAX_CONSECUTIVE_FAILURES = 50;
export const MAX_FAILING_MS = 3 * 24 * 60 * 60 * 1000;
/** A claimed delivery is invisible to other runners for this long (crash safety). */
export const LEASE_MS = 30_000;
const SNIPPET_CHARS = 512;

/** ±20 % jitter so a recovering endpoint is not hit by every retry at once. */
export function withJitter(delayMs: number): number {
  return Math.round(delayMs * (0.8 + Math.random() * 0.4));
}

const sendJob = v.union(
  v.object({ kind: v.literal("skip") }),
  v.object({
    kind: v.literal("send"),
    url: v.string(),
    secretEnc: v.string(),
    deliveryUuid: v.string(),
    attempt: v.number(),
    eventType: v.string(),
    body: v.string(),
  }),
);

type SendJob =
  | { kind: "skip" }
  | {
      kind: "send";
      url: string;
      secretEnc: string;
      deliveryUuid: string;
      attempt: number;
      eventType: string;
      body: string;
    };

export const dueDeliveries = internalQuery({
  args: {
    eventId: v.optional(v.id("connector_events")),
    deliveryIds: v.optional(v.array(v.id("connector_deliveries"))),
    now: v.number(),
  },
  returns: v.array(v.id("connector_deliveries")),
  handler: async (ctx, args) => {
    const rows = args.deliveryIds
      ? (await Promise.all(args.deliveryIds.map((id) => ctx.db.get(id)))).filter((row) => row !== null)
      : args.eventId
        ? await ctx.db
            .query("connector_deliveries")
            .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId!))
            .take(60)
        : [];
    return rows
      .filter((row) => row.status === "pending" && row.nextAttemptAt <= args.now)
      .map((row) => row._id);
  },
});

/**
 * Claims one delivery: re-validates that it should still be sent (endpoint
 * active, connection not revoked) and takes a short lease so a second runner
 * cannot send it at the same time.
 */
export const loadForDelivery = internalMutation({
  args: { deliveryId: v.id("connector_deliveries"), now: v.number() },
  returns: sendJob,
  handler: async (ctx, args): Promise<SendJob> => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery || delivery.status !== "pending" || delivery.nextAttemptAt > args.now) {
      return { kind: "skip" };
    }

    const cancel = async () => {
      await ctx.db.patch(delivery._id, { status: "cancelled", finishedAt: args.now });
      return { kind: "skip" } as const;
    };

    const webhook = await ctx.db.get(delivery.webhookId);
    if (!webhook || webhook.status !== "active") return await cancel();
    const grant = await ctx.db.get(webhook.grantId);
    if (!grant || grant.revokedAt !== undefined) return await cancel();
    const event = await ctx.db.get(delivery.eventId);
    if (!event) return await cancel();

    await ctx.db.patch(delivery._id, {
      nextAttemptAt: args.now + LEASE_MS,
      lastAttemptAt: args.now,
    });

    return {
      kind: "send",
      url: webhook.url,
      secretEnc: webhook.secretEnc,
      deliveryUuid: delivery.deliveryUuid,
      attempt: delivery.attempts + 1,
      eventType: event.type,
      body: JSON.stringify(toEnvelope(event)),
    };
  },
});

export const recordAttempt = internalMutation({
  args: {
    deliveryId: v.id("connector_deliveries"),
    outcome: v.union(
      v.object({ kind: v.literal("response"), status: v.number(), body: v.string() }),
      v.object({ kind: v.literal("error"), message: v.string() }),
    ),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { now, outcome } = args;
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery || delivery.status !== "pending") return null;

    const webhook = await ctx.db.get(delivery.webhookId);
    const attempts = delivery.attempts + 1;

    // Success: any 2xx.
    if (outcome.kind === "response" && outcome.status >= 200 && outcome.status < 300) {
      await ctx.db.patch(delivery._id, {
        status: "succeeded",
        attempts,
        lastAttemptAt: now,
        lastResponseCode: outcome.status,
        lastResponseBody: outcome.body.slice(0, SNIPPET_CHARS),
        lastError: undefined,
        finishedAt: now,
      });
      if (webhook) {
        await ctx.db.patch(webhook._id, {
          consecutiveFailures: 0,
          firstFailureAt: undefined,
          lastDeliveryAt: now,
          lastDeliveryStatus: "succeeded",
          updatedAt: now,
        });
      }
      return null;
    }

    const gone = outcome.kind === "response" && outcome.status === 410;
    const isFinal = gone || attempts >= MAX_ATTEMPTS;
    const failure = {
      attempts,
      lastAttemptAt: now,
      lastResponseCode: outcome.kind === "response" ? outcome.status : undefined,
      lastResponseBody: outcome.kind === "response" ? outcome.body.slice(0, SNIPPET_CHARS) : undefined,
      lastError:
        outcome.kind === "error" ? outcome.message.slice(0, 300) : `HTTP ${outcome.status}`,
    };

    if (isFinal) {
      await ctx.db.patch(delivery._id, { ...failure, status: "failed", finishedAt: now });
    } else {
      const delay = withJitter(BACKOFF_MS[attempts - 1]);
      await ctx.db.patch(delivery._id, { ...failure, nextAttemptAt: now + delay });
      await ctx.scheduler.runAfter(delay, internal.connector.dispatch.deliverPending, {
        deliveryIds: [delivery._id],
      });
    }

    if (webhook && webhook.status === "active") {
      const firstFailureAt = webhook.firstFailureAt ?? now;
      // "Consecutive failed deliveries" = deliveries that exhausted every retry.
      const consecutiveFailures = webhook.consecutiveFailures + (isFinal ? 1 : 0);
      const disabledReason = gone
        ? "endpoint_gone"
        : consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
          ? "too_many_failures"
          : now - firstFailureAt >= MAX_FAILING_MS
            ? "failing_for_3_days"
            : undefined;

      await ctx.db.patch(webhook._id, {
        consecutiveFailures,
        firstFailureAt,
        lastDeliveryAt: now,
        lastDeliveryStatus: "failed",
        updatedAt: now,
        ...(disabledReason
          ? { status: "disabled" as const, disabledReason, disabledAt: now }
          : {}),
      });

      if (disabledReason) {
        const pending = await ctx.db
          .query("connector_deliveries")
          .withIndex("by_webhookId", (q) => q.eq("webhookId", webhook._id))
          .take(200);
        for (const other of pending) {
          if (other.status === "pending") {
            await ctx.db.patch(other._id, { status: "cancelled", finishedAt: now });
          }
        }
      }
    }
    return null;
  },
});

/**
 * Entry point used by the outbox and by retries: delivers whatever is due for an
 * event (or an explicit list of deliveries). Never runs inline in a user request.
 */
export const deliverPending = internalAction({
  args: {
    eventId: v.optional(v.id("connector_events")),
    deliveryIds: v.optional(v.array(v.id("connector_deliveries"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const due: Id<"connector_deliveries">[] = await ctx.runQuery(
      internal.connector.dispatch.dueDeliveries,
      { eventId: args.eventId, deliveryIds: args.deliveryIds, now: Date.now() },
    );
    // One bad endpoint must not hold up the others.
    await Promise.allSettled(
      due.map((deliveryId) =>
        ctx.runAction(internal.connector.deliveryNode.deliverOne, { deliveryId }),
      ),
    );
    return null;
  },
});

/**
 * Safety net for at-least-once delivery: re-queues deliveries that are overdue
 * (their scheduled run was lost, or a runner crashed holding the lease).
 */
export const sweep = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    if (!isConnectorEnabled()) return 0;
    const now = Date.now();
    const overdue = await ctx.db
      .query("connector_deliveries")
      .withIndex("by_status_and_nextAttemptAt", (q) =>
        q.eq("status", "pending").lt("nextAttemptAt", now - 60_000),
      )
      .take(50);
    if (overdue.length > 0) {
      await ctx.scheduler.runAfter(0, internal.connector.dispatch.deliverPending, {
        deliveryIds: overdue.map((row) => row._id),
      });
    }
    return overdue.length;
  },
});
