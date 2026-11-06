import { z } from "zod";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { ConnectorError } from "./errors";
import { getAction } from "./registry";
import type { Route } from "./routes";
import { parseInput, readIdempotencyKey, readJsonBody, wantsIgnoreUnknown } from "./validate";

type ActionRoute = Extract<Route, { kind: "action" }>;

export type ActionOutcome = { status: number; response: string; replayed: boolean };

const envelopes = new Map<string, z.ZodType>();

/** `{ "input": { … } }` — strict, so a stray top-level key is a 400 like any other unknown field. */
function envelopeFor(name: string): z.ZodType {
  let schema = envelopes.get(name);
  if (!schema) {
    const definition = getAction(name);
    if (!definition) throw new ConnectorError("not_found", "Unknown action");
    schema = z.strictObject({ input: definition.input });
    envelopes.set(name, schema);
  }
  return schema;
}

/**
 * `POST /actions/{name}`: validates the body against the registry schema (the one
 * that generated the manifest), then runs the matching mutation — which re-checks
 * the grant and applies idempotency atomically with the change.
 */
export async function runAction(
  ctx: ActionCtx,
  route: ActionRoute,
  request: Request,
  grantId: Id<"connector_grants">,
  now: number,
): Promise<ActionOutcome> {
  const definition = getAction(route.params.name);
  if (!definition) throw new ConnectorError("not_found", "Unknown action");

  const idempotencyKey = readIdempotencyKey(request);
  const raw = await readJsonBody(request);

  const { input } = parseInput(envelopeFor(definition.name), raw, wantsIgnoreUnknown(request)) as {
    input: unknown;
  };
  const args = { grantId, now, idempotencyKey, input };

  switch (definition.name) {
    case "meetings.create":
      return await ctx.runMutation(internal.connector.actions.meetingsCreate, args);
    case "meetings.end":
      return await ctx.runMutation(internal.connector.actions.meetingsEnd, args);
    case "meetings.invite":
      return await ctx.runMutation(internal.connector.actions.meetingsInvite, args);
    case "meetings.generateSummary":
      return await ctx.runMutation(internal.connector.actions.meetingsGenerateSummary, args);
    case "tasks.create":
      return await ctx.runMutation(internal.connector.actions.tasksCreate, args);
    case "tasks.createFromSummary":
      return await ctx.runMutation(internal.connector.actions.tasksCreateFromSummary, args);
    case "tasks.update":
      return await ctx.runMutation(internal.connector.actions.tasksUpdate, args);
    case "notifications.create":
      return await ctx.runMutation(internal.connector.actions.notificationsCreate, args);
  }
}
