import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { missing } from "./access";
import { LIMITS, isConnectorDevMode } from "./config";
import {
  decryptSecret,
  encryptSecret,
  generateWebhookSecret,
  sha256Hex,
} from "./crypto";
import { iso, isoOpt } from "./entities";
import { ConnectorError, normalizeError, toConvexError, validationFailed } from "./errors";
import { loadActiveGrant } from "./grantAccess";
import { canonicalJson } from "./httpUtil";
import { beginIdempotent, completeIdempotent } from "./idempotency";
import { MAX_TIME, decodeCursor, encodeCursor, isTimeCursor } from "./pagination";
import { EVENT_TYPES, getEventScopes, matchesEventPattern } from "./registry";
import { checkWebhookUrl } from "./ssrf";
import { webhookCreateInput, webhookPatchInput } from "./standard";

/**
 * Webhook endpoint management (CP1 §4). Endpoints belong to the grant that
 * created them: another grant — even the same user's — cannot see or change them.
 * Registration-time DNS checks happen in the HTTP layer (a Node action); the
 * static URL rules are re-applied here as defence in depth.
 */

const base = { grantId: v.id("connector_grants"), now: v.number() };
const result = v.object({ status: v.number(), response: v.string(), replayed: v.boolean() });

export function toWebhookEntity(webhook: Doc<"connector_webhooks">) {
  return {
    id: String(webhook._id),
    url: webhook.url,
    events: webhook.events,
    description: webhook.description,
    status: webhook.status,
    disabledReason: webhook.disabledReason,
    consecutiveFailures: webhook.consecutiveFailures,
    lastDeliveryAt: isoOpt(webhook.lastDeliveryAt),
    lastDeliveryStatus: webhook.lastDeliveryStatus,
    createdAt: iso(webhook._creationTime),
    updatedAt: iso(webhook.updatedAt),
  };
}

function toDeliveryEntity(delivery: Doc<"connector_deliveries">, eventId: string, eventType: string) {
  return {
    id: String(delivery._id),
    eventId,
    eventType,
    status: delivery.status,
    attempts: delivery.attempts,
    nextAttemptAt: delivery.status === "pending" ? iso(delivery.nextAttemptAt) : undefined,
    lastAttemptAt: isoOpt(delivery.lastAttemptAt),
    lastResponseCode: delivery.lastResponseCode,
    lastResponseBody: delivery.lastResponseBody,
    lastError: delivery.lastError,
    createdAt: iso(delivery.createdAt),
    finishedAt: isoOpt(delivery.finishedAt),
  };
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    // Typed so the transaction rolls back and the router can answer precisely.
    throw toConvexError(normalizeError(error));
  }
}

async function loadOwnedWebhook(
  ctx: MutationCtx | import("../_generated/server").QueryCtx,
  grant: Doc<"connector_grants">,
  rawId: string,
) {
  const id = ctx.db.normalizeId("connector_webhooks", rawId);
  const webhook = id ? await ctx.db.get(id) : null;
  if (!webhook || webhook.grantId !== grant._id) return missing("Webhook");
  return webhook;
}

/** A subscription is only useful if the grant may read at least one matching event. */
function assertReadable(patterns: string[], grant: Doc<"connector_grants">) {
  const readable = EVENT_TYPES.filter(
    (type) =>
      patterns.some((pattern) => matchesEventPattern(pattern, type)) &&
      getEventScopes(type).every((scope) => grant.scopes.includes(scope)),
  );
  if (readable.length === 0) {
    const needed = Array.from(
      new Set(
        EVENT_TYPES.filter((type) => patterns.some((pattern) => matchesEventPattern(pattern, type))).flatMap(
          (type) => getEventScopes(type),
        ),
      ),
    );
    throw validationFailed("This connection cannot read any of the subscribed events.", [
      { path: "events", message: `Needs one of: ${needed.join(", ")}` },
    ]);
  }
}

function assertStaticUrl(url: string) {
  const check = checkWebhookUrl(url, { devMode: isConnectorDevMode() });
  if (!check.ok) throw validationFailed("Webhook URL rejected", [{ path: "url", message: check.reason }]);
}

export const create = internalMutation({
  args: { ...base, idempotencyKey: v.optional(v.string()), input: v.any() },
  returns: result,
  handler: (ctx, args) =>
    guarded(async () => {
      const { grant } = await loadActiveGrant(ctx, args.grantId, args.now);
      const input = webhookCreateInput.parse(args.input);

      // The stored response contains the signing secret, so it is encrypted at rest.
      let requestHash = "";
      if (args.idempotencyKey) {
        requestHash = await sha256Hex(`webhooks.create\n${canonicalJson(args.input)}`);
        const begin = await beginIdempotent(ctx, grant._id, args.idempotencyKey, requestHash, args.now);
        if (begin.kind === "replay") {
          return {
            status: begin.status,
            response: await decryptSecret(begin.response),
            replayed: true,
          };
        }
        if (begin.kind === "conflict") {
          throw new ConnectorError(
            "idempotency_conflict",
            "This Idempotency-Key was already used with a different request body.",
          );
        }
      }

      assertStaticUrl(input.url);
      assertReadable(input.events, grant);

      const existing = await ctx.db
        .query("connector_webhooks")
        .withIndex("by_grantId", (q) => q.eq("grantId", grant._id))
        .take(LIMITS.webhookMaxEndpoints + 1);
      if (existing.length >= LIMITS.webhookMaxEndpoints) {
        throw new ConnectorError(
          "conflict",
          `A connection can have at most ${LIMITS.webhookMaxEndpoints} webhook endpoints. Delete one first.`,
        );
      }

      const secret = generateWebhookSecret();
      const id = await ctx.db.insert("connector_webhooks", {
        grantId: grant._id,
        orgId: grant.orgId,
        url: input.url,
        events: input.events,
        description: input.description,
        secretEnc: await encryptSecret(secret),
        status: "active",
        consecutiveFailures: 0,
        createdAt: args.now,
        updatedAt: args.now,
      });

      const webhook = (await ctx.db.get(id))!;
      // The secret is returned exactly once (here, or in an idempotent replay of this call).
      const response = JSON.stringify({ ...toWebhookEntity(webhook), secret });
      if (args.idempotencyKey) {
        await completeIdempotent(
          ctx,
          grant._id,
          args.idempotencyKey,
          requestHash,
          201,
          await encryptSecret(response),
          args.now,
        );
      }
      return { status: 201, response, replayed: false };
    }),
});

export const list = internalQuery({
  args: base,
  returns: v.any(),
  handler: (ctx, args) =>
    guarded(async () => {
      const { grant } = await loadActiveGrant(ctx, args.grantId, args.now);
      const rows = await ctx.db
        .query("connector_webhooks")
        .withIndex("by_grantId", (q) => q.eq("grantId", grant._id))
        .take(LIMITS.webhookMaxEndpoints + 1);
      return { items: rows.map(toWebhookEntity), nextCursor: null };
    }),
});

export const get = internalQuery({
  args: { ...base, id: v.string() },
  returns: v.any(),
  handler: (ctx, args) =>
    guarded(async () => {
      const { grant } = await loadActiveGrant(ctx, args.grantId, args.now);
      return toWebhookEntity(await loadOwnedWebhook(ctx, grant, args.id));
    }),
});

export const update = internalMutation({
  args: { ...base, id: v.string(), input: v.any() },
  returns: v.any(),
  handler: (ctx, args) =>
    guarded(async () => {
      const { grant } = await loadActiveGrant(ctx, args.grantId, args.now);
      const webhook = await loadOwnedWebhook(ctx, grant, args.id);
      const input = webhookPatchInput.parse(args.input);

      const patch: Partial<Doc<"connector_webhooks">> = { updatedAt: args.now };
      if (input.url !== undefined) {
        assertStaticUrl(input.url);
        patch.url = input.url;
      }
      if (input.events !== undefined) {
        assertReadable(input.events, grant);
        patch.events = input.events;
      }
      if (input.description !== undefined) patch.description = input.description;

      if (input.status === "active" && webhook.status === "disabled") {
        // Re-enabling starts the failure accounting afresh.
        patch.status = "active";
        patch.disabledReason = undefined;
        patch.disabledAt = undefined;
        patch.consecutiveFailures = 0;
        patch.firstFailureAt = undefined;
      } else if (input.status === "disabled" && webhook.status === "active") {
        patch.status = "disabled";
        patch.disabledReason = "disabled_by_user";
        patch.disabledAt = args.now;
      }

      await ctx.db.patch(webhook._id, patch);
      return toWebhookEntity((await ctx.db.get(webhook._id))!);
    }),
});

export const remove = internalMutation({
  args: { ...base, id: v.string() },
  returns: v.null(),
  handler: (ctx, args) =>
    guarded(async () => {
      const { grant } = await loadActiveGrant(ctx, args.grantId, args.now);
      const webhook = await loadOwnedWebhook(ctx, grant, args.id);

      const deliveries = await ctx.db
        .query("connector_deliveries")
        .withIndex("by_webhookId", (q) => q.eq("webhookId", webhook._id))
        .take(200);
      for (const delivery of deliveries) await ctx.db.delete(delivery._id);
      await ctx.db.delete(webhook._id);
      return null;
    }),
});

export const deliveries = internalQuery({
  args: { ...base, id: v.string(), limit: v.number(), cursor: v.optional(v.string()) },
  returns: v.any(),
  handler: (ctx, args) =>
    guarded(async () => {
      const { grant } = await loadActiveGrant(ctx, args.grantId, args.now);
      const webhook = await loadOwnedWebhook(ctx, grant, args.id);
      const before = decodeCursor(args.cursor, isTimeCursor);

      const rows = await ctx.db
        .query("connector_deliveries")
        .withIndex("by_webhookId", (q) =>
          q.eq("webhookId", webhook._id).lt("_creationTime", before?.t ?? MAX_TIME),
        )
        .order("desc")
        .take(args.limit + 1);
      const page = rows.slice(0, args.limit);

      const items = [];
      for (const delivery of page) {
        const event = await ctx.db.get(delivery.eventId);
        items.push(toDeliveryEntity(delivery, event?.eventId ?? "", event?.type ?? "unknown"));
      }
      const last = page[page.length - 1];
      return {
        items,
        nextCursor:
          rows.length > args.limit && last ? encodeCursor({ t: last._creationTime }) : null,
      };
    }),
});

/** Manual replay: queues a NEW delivery (new `X-CP-Delivery`) of the same event. */
export const redeliver = internalMutation({
  args: { ...base, id: v.string(), deliveryId: v.string() },
  returns: v.any(),
  handler: (ctx, args) =>
    guarded(async () => {
      const { grant } = await loadActiveGrant(ctx, args.grantId, args.now);
      const webhook = await loadOwnedWebhook(ctx, grant, args.id);

      const deliveryId = ctx.db.normalizeId("connector_deliveries", args.deliveryId);
      const original = deliveryId ? await ctx.db.get(deliveryId) : null;
      if (!original || original.webhookId !== webhook._id) return missing("Delivery");
      if (webhook.status !== "active") {
        throw new ConnectorError(
          "conflict",
          "This webhook endpoint is disabled. Re-enable it before redelivering.",
        );
      }
      const event = await ctx.db.get(original.eventId);
      if (!event) return missing("Event");

      const id = await ctx.db.insert("connector_deliveries", {
        eventId: event._id,
        webhookId: webhook._id,
        orgId: webhook.orgId,
        deliveryUuid: crypto.randomUUID(),
        status: "pending",
        attempts: 0,
        nextAttemptAt: args.now,
        createdAt: args.now,
      });
      await ctx.scheduler.runAfter(0, internal.connector.dispatch.deliverPending, {
        deliveryIds: [id],
      });
      return toDeliveryEntity((await ctx.db.get(id))!, event.eventId, event.type);
    }),
});
