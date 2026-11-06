import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  BACKOFF_MS,
  MAX_ATTEMPTS,
  MAX_CONSECUTIVE_FAILURES,
} from "../../convex/connector/dispatch";
import { EVENTS } from "../../convex/connector/registry";
import { eventEnvelope } from "../../convex/connector/standard";
import { act, connect, getJson, sendJson } from "./connect";
import { OUTSIDER, OTHER_ORG, type TestConvex } from "./fixtures";
import { enableConnector, warmModules } from "./helpers";
import {
  HOOK_URL,
  bodyOf,
  installReceiver,
  registerHook,
  removeReceiver,
  settle,
  signatureIsValid,
  world,
} from "./webhookHelpers";

const T0 = new Date("2026-03-01T10:00:00.000Z").getTime();

beforeAll(warmModules, 60_000);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  enableConnector();
});
afterEach(() => {
  removeReceiver();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const deliveries = (t: TestConvex) => t.run((ctx) => ctx.db.query("connector_deliveries").collect());
const webhooks = (t: TestConvex) => t.run((ctx) => ctx.db.query("connector_webhooks").collect());

async function createMeeting(t: TestConvex, token: string, extra: Record<string, unknown> = {}) {
  return await act(t, token, "meetings.create", { title: "Standup", ...extra });
}

describe("registration (C15)", () => {
  it("returns the signing secret exactly once and stores it encrypted", async () => {
    installReceiver();
    const { t, token } = await world();
    const res = await sendJson(t, token, "POST", "/webhooks", {
      url: HOOK_URL,
      events: ["meeting.*", "task.completed"],
      description: "Hub",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      url: HOOK_URL,
      events: ["meeting.*", "task.completed"],
      description: "Hub",
      status: "active",
      consecutiveFailures: 0,
    });
    const secret: string = res.body!.secret;
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43,}$/);

    // Never again: not on GET, not on the list, not in the DB.
    for (const path of [`/webhooks/${res.body!.id}`, "/webhooks"]) {
      const read = await getJson(t, token, path);
      expect(read.status).toBe(200);
      expect(read.text).not.toContain(secret);
      expect(read.text).not.toMatch(/secret/i);
    }
    const [row] = await webhooks(t);
    expect(row.secretEnc.startsWith("enc:v1:")).toBe(true);
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it("validates the body strictly", async () => {
    installReceiver();
    const { t, token } = await world();
    const post = (body: unknown) => sendJson(t, token, "POST", "/webhooks", body);
    expect((await post({ events: ["meeting.*"] })).status).toBe(400);
    expect((await post({ url: HOOK_URL })).status).toBe(400);
    expect((await post({ url: HOOK_URL, events: [] })).status).toBe(400);
    expect((await post({ url: HOOK_URL, events: ["nope.*"] })).status).toBe(400);
    expect((await post({ url: HOOK_URL, events: ["meeting.*"], extra: 1 })).status).toBe(400);
    expect((await post({ url: "not a url", events: ["meeting.*"] })).body!.error.details[0].path).toBe("url");
    expect(await webhooks(t)).toHaveLength(0);
  });

  it("C17: rejects private, loopback, metadata, credential and non-https targets", async () => {
    installReceiver();
    const { t, token } = await world();
    for (const url of [
      "http://hub.example.com/hook",
      "https://localhost/hook",
      "https://127.0.0.1/hook",
      "https://10.0.0.5/hook",
      "https://192.168.1.10/hook",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/hook",
      "https://[fd00:ec2::254]/hook",
      "https://2130706433/hook",
      "https://metadata.google.internal/hook",
      "https://user:pw@hub.example.com/hook",
    ]) {
      const res = await sendJson(t, token, "POST", "/webhooks", { url, events: ["meeting.*"] });
      expect(res.status, url).toBe(400);
      expect(res.body!.error).toMatchObject({ code: "validation_failed" });
      expect(res.body!.error.details[0].path).toBe("url");
    }
    expect(await webhooks(t)).toHaveLength(0);
  });

  it("C17: rejects host names that RESOLVE to private addresses, even if only one record does", async () => {
    const { t, token } = await world();
    for (const records of [["10.0.0.5"], ["93.184.216.34", "127.0.0.1"], ["::1"], ["169.254.169.254"]]) {
      installReceiver();
      const { setHostResolverForTests } = await import("../../convex/connector/webhookTransport");
      setHostResolverForTests(async () => records);
      const res = await sendJson(t, token, "POST", "/webhooks", { url: HOOK_URL, events: ["meeting.*"] });
      expect(res.status, records.join()).toBe(400);
      expect(res.body!.error.details[0].message).toMatch(/private|loopback|link-local/);
    }

    installReceiver();
    const { setHostResolverForTests } = await import("../../convex/connector/webhookTransport");
    setHostResolverForTests(async () => {
      throw new Error("ENOTFOUND");
    });
    const unresolved = await sendJson(t, token, "POST", "/webhooks", { url: HOOK_URL, events: ["meeting.*"] });
    expect(unresolved.status).toBe(400);
    expect(unresolved.body!.error.details[0].message).toMatch(/resolved/);
  });

  it("allows at most 5 endpoints per connection", async () => {
    installReceiver();
    const { t, token } = await world();
    for (let i = 0; i < 5; i += 1) await registerHook(t, token, ["meeting.*"], `https://hub.example.com/h/${i}`);
    const sixth = await sendJson(t, token, "POST", "/webhooks", { url: HOOK_URL, events: ["meeting.*"] });
    expect(sixth.status).toBe(409);
    expect(sixth.body!.error.code).toBe("conflict");
  });

  it("refuses subscriptions the connection could never read", async () => {
    installReceiver();
    const { t, token } = await world("pro", "meetup:webhooks:manage meetup:meetings:read");
    const res = await sendJson(t, token, "POST", "/webhooks", { url: HOOK_URL, events: ["meeting.summary.*"] });
    expect(res.status).toBe(400);
    expect(res.body!.error.details[0].message).toContain("meetup:summaries:read");
    // Overlapping patterns are fine as long as something readable matches.
    expect((await sendJson(t, token, "POST", "/webhooks", { url: HOOK_URL, events: ["meeting.*"] })).status).toBe(201);
  });

  it("needs webhooks:manage, which brings events:read with it", async () => {
    installReceiver();
    const { t, token: manager } = await world("pro", "meetup:webhooks:manage");
    expect((await getJson(t, manager, "/events")).status).toBe(200);

    const { token: noScope } = await connect(t, { scope: "meetup:meetings:read" });
    const denied = await sendJson(t, noScope, "POST", "/webhooks", { url: HOOK_URL, events: ["meeting.*"] });
    expect(denied.status).toBe(403);
    expect(denied.body!.error).toMatchObject({ code: "insufficient_scope", requiredScope: "meetup:webhooks:manage" });
    expect((await getJson(t, noScope, "/events")).body!.error.requiredScope).toBe("meetup:events:read");
  });

  it("belongs to the connection that created it", async () => {
    installReceiver();
    const { t, token } = await world();
    const { id } = await registerHook(t, token, ["meeting.*"]);
    const { token: sibling } = await connect(t, { scope: EVERYTHING_SCOPE });
    expect((await getJson(t, sibling, `/webhooks/${id}`)).status).toBe(404);
    expect((await getJson(t, sibling, "/webhooks")).body!.items).toEqual([]);
    expect((await sendJson(t, sibling, "DELETE", `/webhooks/${id}`)).status).toBe(404);

    const { token: foreign } = await connect(t, { who: OUTSIDER, orgId: OTHER_ORG, scope: EVERYTHING_SCOPE });
    expect((await getJson(t, foreign, `/webhooks/${id}`)).status).toBe(404);
    expect((await getJson(t, token, `/webhooks/${id}`)).status).toBe(200);
  });

  it("updates, disables and re-enables an endpoint, and deletes it", async () => {
    installReceiver();
    const { t, token } = await world();
    const { id } = await registerHook(t, token, ["meeting.*"]);

    const patched = await sendJson(t, token, "PATCH", `/webhooks/${id}`, {
      url: "https://hub2.example.com/hook",
      events: ["task.*"],
      description: "renamed",
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ url: "https://hub2.example.com/hook", events: ["task.*"], description: "renamed" });
    expect((await sendJson(t, token, "PATCH", `/webhooks/${id}`, { url: "https://10.0.0.1/x" })).status).toBe(400);

    const off = await sendJson(t, token, "PATCH", `/webhooks/${id}`, { status: "disabled" });
    expect(off.body).toMatchObject({ status: "disabled", disabledReason: "disabled_by_user" });

    await t.run(async (ctx) => {
      const [row] = await ctx.db.query("connector_webhooks").collect();
      await ctx.db.patch(row._id, { consecutiveFailures: 7, firstFailureAt: T0 });
    });
    const on = await sendJson(t, token, "PATCH", `/webhooks/${id}`, { status: "active" });
    expect(on.body).toMatchObject({ status: "active", consecutiveFailures: 0 });
    expect(on.body!.disabledReason).toBeUndefined();

    expect((await sendJson(t, token, "DELETE", `/webhooks/${id}`)).status).toBe(204);
    expect((await getJson(t, token, `/webhooks/${id}`)).status).toBe(404);
    expect(await webhooks(t)).toHaveLength(0);
  });

  it("C10: an idempotent create replays the same secret and never stores it in plaintext", async () => {
    installReceiver();
    const { t, token } = await world();
    const body = { url: HOOK_URL, events: ["meeting.*"] };
    const first = await sendJson(t, token, "POST", "/webhooks", body, { "idempotency-key": "wh-1" });
    const second = await sendJson(t, token, "POST", "/webhooks", body, { "idempotency-key": "wh-1" });
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replay")).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(await webhooks(t)).toHaveLength(1);

    const stored = await t.run((ctx) => ctx.db.query("connector_idempotency").collect());
    expect(stored).toHaveLength(1);
    expect(stored[0].response.startsWith("enc:v1:")).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(first.body!.secret);

    const conflict = await sendJson(t, token, "POST", "/webhooks", { ...body, events: ["task.*"] }, { "idempotency-key": "wh-1" });
    expect(conflict.status).toBe(422);
    expect(conflict.body!.error.code).toBe("idempotency_conflict");
  });
});

const EVERYTHING_SCOPE = (await import("./webhookHelpers")).EVERYTHING;

describe("delivery (C15, C16, C18)", () => {
  it("is asynchronous, signed, and uses the CP1 envelope and headers", async () => {
    const calls = installReceiver();
    const { t, token } = await world();
    const { secret } = await registerHook(t, token, ["meeting.*"]);

    const created = await createMeeting(t, token, {
      externalRef: { hubProjectId: "prj_1", hubRunId: "run_1", hubStepId: "step_1" },
    });
    // Never inline in the user-facing request.
    expect(calls).toHaveLength(0);

    await settle(t);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    const envelope = bodyOf(call);

    expect(call.url).toBe(HOOK_URL);
    expect(call.headers["Content-Type"]).toBe("application/json");
    expect(call.headers["User-Agent"]).toBe("Meetup-Connector/1.0");
    expect(call.headers["X-CP-Event"]).toBe("meeting.started");
    expect(call.headers["X-CP-Delivery"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number(call.headers["X-CP-Timestamp"])).toBe(Math.floor(Date.now() / 1000));
    expect(call.headers["X-CP-Signature"]).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(await signatureIsValid(secret, call)).toBe(true);
    expect(await signatureIsValid("whsec_wrong", call)).toBe(false);
    expect(await signatureIsValid(secret, { ...call, body: `${call.body} ` })).toBe(false);

    expect(eventEnvelope.safeParse(envelope).success).toBe(true);
    expect(envelope).toMatchObject({
      type: "meeting.started",
      apiVersion: "cp1",
      service: "meetup",
      tenantId: expect.any(String),
      actor: { kind: "connector", name: "Hana Host" },
      // C18: the creating action's correlation ids come back on the event.
      externalRef: { hubProjectId: "prj_1", hubRunId: "run_1", hubStepId: "step_1" },
      data: { meeting: { id: created.body!.output.meeting.id, title: "Standup", status: "active" } },
    });
    expect(envelope.id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    const definition = EVENTS.find((e) => e.type === "meeting.started")!;
    expect(definition.data.safeParse(envelope.data).success).toBe(true);
  });

  it("only delivers events matching the subscription (exact and prefix)", async () => {
    const calls = installReceiver();
    const { t, token } = await world();
    await registerHook(t, token, ["task.completed"]);
    await createMeeting(t, token);
    const task = await act(t, token, "tasks.create", { title: "T" });
    await act(t, token, "tasks.update", { taskId: task.body!.output.task.id, status: "in_progress" });
    await settle(t);
    expect(calls).toHaveLength(0);

    await act(t, token, "tasks.update", { taskId: task.body!.output.task.id, status: "done" });
    await settle(t);
    expect(calls.map((c) => c.headers["X-CP-Event"])).toEqual(["task.completed"]);
  });

  it("C16: retries with backoff using the SAME delivery id and body, then succeeds", async () => {
    const calls = installReceiver((_req, n) => (n < 3 ? { status: 503, body: "later" } : { status: 200, body: "ok" }));
    const { t, token } = await world();
    const { id, secret } = await registerHook(t, token, ["meeting.*"]);
    await createMeeting(t, token);
    await settle(t);

    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.headers["X-CP-Delivery"])).size).toBe(1);
    expect(new Set(calls.map((c) => c.body)).size).toBe(1);
    // Each attempt is freshly timestamped and signed.
    expect(new Set(calls.map((c) => c.headers["X-CP-Timestamp"])).size).toBe(3);
    for (const call of calls) expect(await signatureIsValid(secret, call)).toBe(true);

    const [row] = await deliveries(t);
    expect(row).toMatchObject({ status: "succeeded", attempts: 3, lastResponseCode: 200 });

    const log = await getJson(t, token, `/webhooks/${id}/deliveries`);
    expect(log.status).toBe(200);
    expect(log.body!.items[0]).toMatchObject({
      eventType: "meeting.started",
      status: "succeeded",
      attempts: 3,
      lastResponseCode: 200,
    });
    expect((await webhooks(t))[0]).toMatchObject({ consecutiveFailures: 0, lastDeliveryStatus: "succeeded" });
  });

  it("C16: waits 10 s, 30 s, 2 m, 10 m, 30 m, 1 h, 3 h, 6 h (±20 %) then gives up after 9 attempts", async () => {
    const calls = installReceiver(() => ({ status: 500, body: "x".repeat(900) }));
    const { t, token } = await world();
    await registerHook(t, token, ["meeting.*"]);
    await createMeeting(t, token);

    const step = async () => {
      const [row] = await deliveries(t);
      vi.advanceTimersByTime(Math.max(1, row.nextAttemptAt - Date.now()));
      await t.finishInProgressScheduledFunctions();
      return (await deliveries(t))[0];
    };

    let row = await step();
    for (let attempt = 1; attempt <= BACKOFF_MS.length; attempt += 1) {
      expect(row.status, `after attempt ${attempt}`).toBe("pending");
      expect(row.attempts).toBe(attempt);
      const wait = row.nextAttemptAt - row.lastAttemptAt!;
      expect(wait).toBeGreaterThanOrEqual(BACKOFF_MS[attempt - 1] * 0.8 - 1);
      expect(wait).toBeLessThanOrEqual(BACKOFF_MS[attempt - 1] * 1.2 + 1);
      row = await step();
    }
    expect(row).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS, lastResponseCode: 500 });
    expect(MAX_ATTEMPTS).toBe(9);
    expect(calls).toHaveLength(MAX_ATTEMPTS);
    // The response body kept in the log is truncated.
    expect(row.lastResponseBody!.length).toBeLessThanOrEqual(512);

    // Total elapsed ≈ 11 h.
    const total = BACKOFF_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(10.5 * 3_600_000);
    expect(total).toBeLessThan(11 * 3_600_000);
  });

  it("retries network failures and records the reason", async () => {
    const calls = installReceiver((_req, n) => {
      if (n === 1) throw new Error("socket hang up");
      return { status: 204, body: "" };
    });
    const { t, token } = await world();
    await registerHook(t, token, ["meeting.*"]);
    await createMeeting(t, token);
    await settle(t);
    expect(calls).toHaveLength(2);
    expect((await deliveries(t))[0]).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("C16: 410 Gone disables the endpoint immediately and stops retrying", async () => {
    const calls = installReceiver(() => ({ status: 410, body: "gone" }));
    const { t, token } = await world();
    const { id } = await registerHook(t, token, ["meeting.*"]);
    await createMeeting(t, token);
    await createMeeting(t, token, { title: "Second" });
    await settle(t);

    expect(calls.length).toBeLessThanOrEqual(2); // one attempt per delivery, no retries
    const hook = await getJson(t, token, `/webhooks/${id}`);
    expect(hook.body).toMatchObject({ status: "disabled", disabledReason: "endpoint_gone" });
    expect((await deliveries(t)).every((d) => d.status === "failed" || d.status === "cancelled")).toBe(true);

    // Nothing more is queued for a disabled endpoint.
    const before = (await deliveries(t)).length;
    await createMeeting(t, token, { title: "Third" });
    await settle(t);
    expect((await deliveries(t)).length).toBe(before);
  });

  it("disables after 50 consecutive failed deliveries, after 3 days of failures, and resets on success", async () => {
    installReceiver();
    const { t, token } = await world();
    const { id } = await registerHook(t, token, ["meeting.*"]);

    const makePending = async () => {
      await createMeeting(t, token, { title: `m${Math.random()}` });
      await t.finishInProgressScheduledFunctions().catch(() => undefined);
      const rows = await deliveries(t);
      return rows[rows.length - 1];
    };
    const hookRow = async () => (await webhooks(t))[0];
    const fail = async (deliveryId: Id<"connector_deliveries">, attempts: number) => {
      await t.run((ctx) => ctx.db.patch(deliveryId, { status: "pending", attempts, nextAttemptAt: Date.now() }));
      await t.mutation(internal.connector.dispatch.recordAttempt, {
        deliveryId,
        outcome: { kind: "error", message: "boom" },
        now: Date.now(),
      });
    };

    // Streak of 49 exhausted deliveries, then the 50th disables it.
    let delivery = await makePending();
    await t.run(async (ctx) => ctx.db.patch((await ctx.db.query("connector_webhooks").first())!._id, { consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1 }));
    await fail(delivery._id, MAX_ATTEMPTS - 1);
    expect(await hookRow()).toMatchObject({ status: "disabled", disabledReason: "too_many_failures", consecutiveFailures: 50 });

    // 3 days of failures (fresh endpoint).
    await sendJson(t, token, "PATCH", `/webhooks/${id}`, { status: "active" });
    delivery = await makePending();
    await t.run(async (ctx) => ctx.db.patch((await ctx.db.query("connector_webhooks").first())!._id, { firstFailureAt: Date.now() - 3 * 86_400_000 - 1 }));
    await fail(delivery._id, 1);
    expect(await hookRow()).toMatchObject({ status: "disabled", disabledReason: "failing_for_3_days" });

    // A success resets the accounting.
    await sendJson(t, token, "PATCH", `/webhooks/${id}`, { status: "active" });
    delivery = await makePending();
    await t.run(async (ctx) => ctx.db.patch((await ctx.db.query("connector_webhooks").first())!._id, { consecutiveFailures: 12, firstFailureAt: Date.now() - 1000 }));
    await t.run((ctx) => ctx.db.patch(delivery._id, { status: "pending", attempts: 0, nextAttemptAt: Date.now() }));
    await t.mutation(internal.connector.dispatch.recordAttempt, {
      deliveryId: delivery._id,
      outcome: { kind: "response", status: 200, body: "ok" },
      now: Date.now(),
    });
    expect(await hookRow()).toMatchObject({ status: "active", consecutiveFailures: 0, lastDeliveryStatus: "succeeded" });
    expect((await hookRow()).firstFailureAt).toBeUndefined();
    await settle(t);
  });

  it("claims a delivery with a lease so two runners never send it twice", async () => {
    installReceiver();
    const { t, token } = await world();
    await registerHook(t, token, ["meeting.*"]);
    await createMeeting(t, token);
    const [row] = await deliveries(t);

    const claim = () =>
      t.mutation(internal.connector.dispatch.loadForDelivery, { deliveryId: row._id, now: Date.now() });
    expect((await claim()).kind).toBe("send");
    expect((await claim()).kind).toBe("skip");

    // If the runner dies, the sweep notices the overdue delivery and re-queues it.
    vi.setSystemTime(Date.now() + 5 * 60_000);
    expect(await t.mutation(internal.connector.dispatch.sweep, {})).toBe(1);
    await settle(t);
    expect((await deliveries(t))[0].status).toBe("succeeded");
  });

  it("cancels deliveries when the connection is revoked", async () => {
    const calls = installReceiver();
    const { t, token } = await world();
    await registerHook(t, token, ["meeting.*"]);
    await createMeeting(t, token);
    const grant = (await t.run((ctx) => ctx.db.query("connector_grants").collect()))[0];
    await t.run(async (ctx) => {
      const { revokeGrantCore } = await import("../../convex/connector/grantAccess");
      await revokeGrantCore(ctx, grant, "revoked_by_user", Date.now());
    });
    await settle(t);
    expect(calls).toHaveLength(0);
    expect((await deliveries(t)).every((d) => d.status === "cancelled")).toBe(true);
  });

  it("C17: re-validates the stored URL at delivery time and never calls out to a private target", async () => {
    const calls = installReceiver();
    const { t, token } = await world();
    await registerHook(t, token, ["meeting.*"]);
    // Tampered or stale data: the URL now points inside the network.
    await t.run(async (ctx) => {
      const [row] = await ctx.db.query("connector_webhooks").collect();
      await ctx.db.patch(row._id, { url: "https://169.254.169.254/latest/meta-data/" });
    });
    await createMeeting(t, token);
    await t.finishInProgressScheduledFunctions();
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();

    expect(calls).toHaveLength(0);
    const [row] = await deliveries(t);
    expect(row.lastError).toMatch(/private|loopback|link-local/);
    await settle(t);
  });

  it("redelivers on demand as a new delivery of the same event", async () => {
    const calls = installReceiver();
    const { t, token } = await world();
    const { id, secret } = await registerHook(t, token, ["meeting.*"]);
    await createMeeting(t, token);
    await settle(t);
    expect(calls).toHaveLength(1);

    const [original] = await deliveries(t);
    const res = await sendJson(t, token, "POST", `/webhooks/${id}/deliveries/${original._id}/redeliver`);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "pending", attempts: 0, eventType: "meeting.started" });
    await settle(t);

    expect(calls).toHaveLength(2);
    expect(calls[1].headers["X-CP-Delivery"]).not.toBe(calls[0].headers["X-CP-Delivery"]);
    expect(bodyOf(calls[1]).id).toBe(bodyOf(calls[0]).id); // same event id: consumers dedupe on it
    expect(await signatureIsValid(secret, calls[1])).toBe(true);

    const log = await getJson(t, token, `/webhooks/${id}/deliveries?limit=1`);
    expect(log.body!.items).toHaveLength(1);
    expect(log.body!.nextCursor).toBeTruthy();

    // A disabled endpoint refuses to redeliver; unknown ids are 404.
    await sendJson(t, token, "PATCH", `/webhooks/${id}`, { status: "disabled" });
    const refused = await sendJson(t, token, "POST", `/webhooks/${id}/deliveries/${original._id}/redeliver`);
    expect(refused.status).toBe(409);
    expect((await sendJson(t, token, "POST", `/webhooks/${id}/deliveries/nope/redeliver`)).status).toBe(404);
  });
});
