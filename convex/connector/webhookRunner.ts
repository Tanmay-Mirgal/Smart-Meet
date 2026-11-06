import { z } from "zod";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { validationFailed } from "./errors";
import { isValidEventPattern, paginationQuery } from "./registry";
import type { Route } from "./routes";
import { eventsQuery, webhookCreateInput, webhookPatchInput } from "./standard";
import { parseInput, readIdempotencyKey, readJsonBody, wantsIgnoreUnknown } from "./validate";

type WebhookRoute = Extract<
  Route,
  | { kind: "webhooks.create" }
  | { kind: "webhooks.list" }
  | { kind: "webhooks.get" }
  | { kind: "webhooks.update" }
  | { kind: "webhooks.delete" }
  | { kind: "webhooks.deliveries" }
  | { kind: "webhooks.redeliver" }
  | { kind: "events" }
>;

export type WebhookOutcome = {
  status: number;
  /** JSON to serialize. */
  body?: unknown;
  /** Already-serialized JSON (a stored idempotent replay). */
  text?: string;
  replayed?: boolean;
};

const deliveriesQuery = z.strictObject({ ...paginationQuery });

/**
 * Registration/update-time SSRF check (CP1 §4): static URL rules, then DNS —
 * every resolved address must be public. Done in a Node action because the
 * default runtime has no DNS. Delivery re-validates at connect time.
 */
async function assertTargetAllowed(ctx: ActionCtx, url: string) {
  const verdict = await ctx.runAction(internal.connector.deliveryNode.validateTarget, { url });
  if (!verdict.ok) {
    throw validationFailed("Webhook URL rejected", [
      { path: "url", message: verdict.reason ?? "This URL cannot be used as a webhook target." },
    ]);
  }
}

export async function runWebhookRoute(
  ctx: ActionCtx,
  route: WebhookRoute,
  request: Request,
  grantId: Id<"connector_grants">,
  now: number,
): Promise<WebhookOutcome> {
  const common = { grantId, now };
  const ignoreUnknown = wantsIgnoreUnknown(request);
  const query = () => Object.fromEntries(new URL(request.url).searchParams.entries());

  switch (route.kind) {
    case "webhooks.create": {
      const idempotencyKey = readIdempotencyKey(request);
      const input = parseInput(webhookCreateInput, await readJsonBody(request), ignoreUnknown);
      await assertTargetAllowed(ctx, input.url);
      const created = await ctx.runMutation(internal.connector.webhooks.create, {
        ...common,
        idempotencyKey,
        input,
      });
      return { status: created.status, text: created.response, replayed: created.replayed };
    }
    case "webhooks.list":
      return { status: 200, body: await ctx.runQuery(internal.connector.webhooks.list, common) };
    case "webhooks.get":
      return {
        status: 200,
        body: await ctx.runQuery(internal.connector.webhooks.get, { ...common, id: route.params.id }),
      };
    case "webhooks.update": {
      const input = parseInput(webhookPatchInput, await readJsonBody(request), ignoreUnknown);
      if (input.url !== undefined) await assertTargetAllowed(ctx, input.url);
      return {
        status: 200,
        body: await ctx.runMutation(internal.connector.webhooks.update, {
          ...common,
          id: route.params.id,
          input,
        }),
      };
    }
    case "webhooks.delete":
      await ctx.runMutation(internal.connector.webhooks.remove, { ...common, id: route.params.id });
      return { status: 204 };
    case "webhooks.deliveries": {
      const { limit, cursor } = parseInput(deliveriesQuery, query(), ignoreUnknown);
      return {
        status: 200,
        body: await ctx.runQuery(internal.connector.webhooks.deliveries, {
          ...common,
          id: route.params.id,
          limit,
          cursor,
        }),
      };
    }
    case "webhooks.redeliver":
      return {
        status: 202,
        body: await ctx.runMutation(internal.connector.webhooks.redeliver, {
          ...common,
          id: route.params.id,
          deliveryId: route.params.deliveryId,
        }),
      };
    case "events": {
      const { limit, cursor, types } = parseInput(eventsQuery, query(), ignoreUnknown);
      const patterns = types
        ? types
            .split(",")
            .map((type) => type.trim())
            .filter(Boolean)
        : undefined;
      const invalid = patterns?.filter((pattern) => !isValidEventPattern(pattern));
      if (invalid && invalid.length > 0) {
        throw validationFailed("Unknown event type in `types`", [
          { path: "types", message: `Not an event type or pattern: ${invalid.join(", ")}` },
        ]);
      }
      return {
        status: 200,
        body: await ctx.runQuery(internal.connector.exec.eventsList, {
          ...common,
          limit,
          cursor,
          types: patterns,
        }),
      };
    }
  }
}
