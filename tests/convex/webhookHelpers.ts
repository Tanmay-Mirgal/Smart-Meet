import { expect, vi } from "vitest";
import { signWebhookPayload } from "../../convex/connector/crypto";
import { ALL_SCOPES } from "../../convex/connector/scopes";
import {
  setHostResolverForTests,
  setWebhookTransportForTests,
  type TransportRequest,
  type TransportResponse,
} from "../../convex/connector/webhookTransport";
import { connect, sendJson } from "./connect";
import { newConvex, seedWorld, type PlanSeed, type TestConvex } from "./fixtures";

export const EVERYTHING = ALL_SCOPES.join(" ");
export const HOOK_URL = "https://hub.example.com/hooks/meetup";

/** Replaces the outbound HTTP layer with a recorder (and DNS with a public address). */
export function installReceiver(
  handler: (request: TransportRequest, callNumber: number) => TransportResponse | Promise<TransportResponse> = () => ({
    status: 200,
    body: "ok",
  }),
) {
  const calls: TransportRequest[] = [];
  setWebhookTransportForTests(async (request) => {
    calls.push(request);
    return await handler(request, calls.length);
  });
  setHostResolverForTests(async () => ["93.184.216.34"]);
  return calls;
}

export function removeReceiver() {
  setWebhookTransportForTests(null);
  setHostResolverForTests(null);
}

/** Recomputes `X-CP-Signature` exactly as a consumer must (CP1 §5). */
export async function signatureIsValid(secret: string, request: TransportRequest) {
  const timestamp = Number(request.headers["X-CP-Timestamp"]);
  return (
    (await signWebhookPayload(secret, timestamp, request.body)) === request.headers["X-CP-Signature"]
  );
}

export const settle = (t: TestConvex) => t.finishAllScheduledFunctions(vi.runAllTimers);

export async function world(plan: PlanSeed = "pro", scope = EVERYTHING) {
  const t = newConvex();
  await seedWorld(t, plan);
  const { token } = await connect(t, { scope });
  return { t, token };
}

export async function registerHook(
  t: TestConvex,
  token: string,
  events: string[] = ["*.*"],
  url = HOOK_URL,
) {
  // "*.*" is not a valid pattern; expand to concrete prefixes.
  const patterns = events.flatMap((e) => (e === "*.*" ? ["meeting.*", "task.*", "recording.*", "invite.*"] : [e]));
  const res = await sendJson(t, token, "POST", "/webhooks", { url, events: patterns });
  expect(res.status, res.text).toBe(201);
  return { id: res.body!.id as string, secret: res.body!.secret as string };
}

export const bodyOf = (call: TransportRequest) => JSON.parse(call.body) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
