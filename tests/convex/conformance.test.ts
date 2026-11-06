/**
 * CP1 conformance suite (CP1 §9): C01–C22, black-box through the real HTTP
 * handler. Each `describe` is one item of the checklist, named by its id.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import { buildManifest } from "../../convex/connector/manifest";
import { buildOpenApi } from "../../convex/connector/openapi";
import { bytesToBase64Url, randomBytes, sha256Base64Url } from "../../convex/connector/crypto";
import { ACTIONS, EVENTS, RESOURCES } from "../../convex/connector/registry";
import { matchRoute } from "../../convex/connector/routes";
import { SCOPE_DEFINITIONS } from "../../convex/connector/scopes";
import { actorFromTokenIdentifier } from "../../convex/lib/actor";
import { createMeetingCore } from "../../convex/meetings/index";
import { act, connect, getJson, sendJson } from "./connect";
import { HOST, MEMBER, ORG, OTHER_ORG, OUTSIDER, as, newConvex, seedWorld, type TestConvex } from "./fixtures";
import {
  TEST_APP_URL,
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
  TEST_REDIRECT,
  enableConnector,
  warmModules,
} from "./helpers";
import {
  EVERYTHING,
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
  installReceiver();
});
afterEach(() => {
  removeReceiver();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const tick = (ms = 5) => vi.setSystemTime(Date.now() + ms);

async function codeFor(t: TestConvex, scope = "meetup:orgs:read meetup:meetings:read") {
  const verifier = bytesToBase64Url(randomBytes(32));
  const { redirectUrl } = await as(t, HOST).mutation(api.connector.consent.approve, {
    clientId: TEST_CLIENT_ID,
    redirectUri: TEST_REDIRECT,
    responseType: "code",
    scope,
    state: "s",
    codeChallenge: await sha256Base64Url(verifier),
    codeChallengeMethod: "S256",
    orgId: ORG,
  });
  return { code: new URL(redirectUrl).searchParams.get("code")!, verifier };
}

const tokenRequest = (t: TestConvex, params: Record<string, string>) =>
  t.fetch("/connect/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET, ...params }).toString(),
  });

const exchange = (t: TestConvex, code: string, verifier: string, redirectUri = TEST_REDIRECT) =>
  tokenRequest(t, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });

describe("C01 manifest valid and matches the registry", () => {
  it("serves exactly the registry, with usable JSON Schema 2020-12 and app-domain URLs", async () => {
    const t = newConvex();
    const response = await t.fetch("/connect/v1/manifest");
    expect(response.status).toBe(200);
    const manifest = await response.json();
    expect(manifest).toEqual(JSON.parse(JSON.stringify(buildManifest({ appUrl: TEST_APP_URL, docsUrl: `${TEST_APP_URL}/docs/CONNECTOR.md` }))));

    expect(manifest).toMatchObject({ protocol: "cp1", service: "meetup", tenantKind: "organization" });
    expect(manifest.actions.map((a: { name: string }) => a.name)).toEqual(ACTIONS.map((a) => a.name));
    expect(manifest.resources.map((r: { name: string }) => r.name)).toEqual(RESOURCES.map((r) => r.name));
    expect(manifest.events.map((e: { type: string }) => e.type)).toEqual(EVENTS.map((e) => e.type));
    expect(manifest.auth.scopes).toHaveLength(SCOPE_DEFINITIONS.length);

    // Every schema is a well-formed 2020-12 object schema, with titles/descriptions for form rendering.
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${path}[${i}]`));
      if (!node || typeof node !== "object") return;
      const schema = node as Record<string, unknown>;
      if ("type" in schema) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        for (const type of types) {
          expect(["string", "number", "integer", "boolean", "object", "array", "null"], `${path}.type`).toContain(type);
        }
      }
      if (schema.enum) expect(Array.isArray(schema.enum)).toBe(true);
      Object.entries(schema).forEach(([key, value]) => walk(value, `${path}.${key}`));
    };
    for (const action of manifest.actions) {
      expect(action.inputSchema.$schema).toContain("2020-12");
      expect(action.inputSchema.additionalProperties).toBe(false);
      walk(action.inputSchema, action.name);
      walk(action.outputSchema, `${action.name}:out`);
    }
    for (const resource of manifest.resources) walk(resource.outputSchema, resource.name);
    for (const event of manifest.events) walk(event.dataSchema, event.type);

    // The same registry validates requests at runtime.
    const create = ACTIONS.find((a) => a.name === "meetings.create")!;
    expect(create.input.safeParse({ title: "x", unknown: 1 }).success).toBe(false);

    const openapi = await (await t.fetch("/connect/v1/openapi.json")).json();
    expect(openapi).toEqual(JSON.parse(JSON.stringify(buildOpenApi({ appUrl: TEST_APP_URL }))));
    expect(openapi.openapi).toBe("3.1.0");
  });
});

describe("C02 PKCE is mandatory; a wrong verifier fails", () => {
  it("rejects authorize requests without S256 PKCE and exchanges with a wrong verifier", async () => {
    const { t } = await world();
    const params = {
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT,
      responseType: "code",
      scope: "meetup:orgs:read",
      state: "s",
    };
    const missing = await as(t, HOST).query(api.connector.consent.prepare, params);
    expect(missing.status).toBe("redirect");
    if (missing.status === "redirect") {
      expect(new URL(missing.redirectUrl).searchParams.get("error")).toBe("invalid_request");
    }
    const plain = await as(t, HOST).query(api.connector.consent.prepare, {
      ...params,
      codeChallenge: "a".repeat(43),
      codeChallengeMethod: "plain",
    });
    expect(plain.status).toBe("redirect");

    const { code } = await codeFor(t);
    const wrong = await exchange(t, code, "x".repeat(43));
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe("invalid_grant");
  });
});

describe("C03 an authorization code is single use", () => {
  it("fails the second exchange and revokes the tokens issued from the code", async () => {
    const { t } = await world();
    const { code, verifier } = await codeFor(t);
    const first = await exchange(t, code, verifier);
    expect(first.status).toBe(200);
    const { access_token } = await first.json();
    expect((await getJson(t, access_token, "/me")).status).toBe(200);

    expect((await exchange(t, code, verifier)).status).toBe(400);
    expect((await getJson(t, access_token, "/me")).status).toBe(401);
  });
});

describe("C04 redirect_uri must match exactly", () => {
  it("never redirects for an unregistered URI and rejects a different one at the token endpoint", async () => {
    const { t } = await world();
    for (const redirectUri of [`${TEST_REDIRECT}/`, `${TEST_REDIRECT}?x=1`, "https://evil.example.com/cb"]) {
      const result = await as(t, HOST).query(api.connector.consent.prepare, {
        clientId: TEST_CLIENT_ID,
        redirectUri,
        responseType: "code",
        scope: "meetup:orgs:read",
        state: "s",
        codeChallenge: await sha256Base64Url("v".repeat(43)),
        codeChallengeMethod: "S256",
      });
      expect(result.status).toBe("fatal");
    }
    const { code, verifier } = await codeFor(t);
    expect((await exchange(t, code, verifier, `${TEST_REDIRECT}/`)).status).toBe(400);
  });
});

describe("C05 refresh rotation and reuse detection", () => {
  it("rotates, and reusing a rotated token revokes the whole grant", async () => {
    const { t } = await world();
    const { code, verifier } = await codeFor(t);
    const first = await (await exchange(t, code, verifier)).json();
    const second = await (await tokenRequest(t, { grant_type: "refresh_token", refresh_token: first.refresh_token })).json();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await getJson(t, first.access_token, "/me")).status).toBe(401);
    expect((await getJson(t, second.access_token, "/me")).status).toBe(200);

    const replay = await tokenRequest(t, { grant_type: "refresh_token", refresh_token: first.refresh_token });
    expect((await replay.json()).error).toBe("invalid_grant");
    expect((await getJson(t, second.access_token, "/me")).status).toBe(401);
  });
});

describe("C06 revoke works immediately", () => {
  it("kills access and refresh tokens at once, and from the Meetup UI too", async () => {
    const { t, token } = await world();
    const revoke = (value: string) =>
      t.fetch("/connect/v1/oauth/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: value, client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET }).toString(),
      });
    expect((await getJson(t, token, "/me")).status).toBe(200);
    expect((await revoke(token)).status).toBe(200);
    expect((await getJson(t, token, "/me")).status).toBe(401);

    const second = await connect(t, { scope: EVERYTHING });
    const grant = (await t.run((ctx) => ctx.db.query("connector_grants").collect())).find((g) => g.revokedAt === undefined)!;
    await as(t, HOST).mutation(api.connector.grants.revoke, { grantId: grant._id });
    expect((await getJson(t, second.token, "/me")).status).toBe(401);
    expect((await revoke("cp1_meetup_unknown")).status).toBe(200);
  });
});

describe("C07 scope enforcement per endpoint", () => {
  it("names the missing scope for resources, actions, webhooks, events and operations", async () => {
    const { t } = await world();
    const { token } = await connect(t, { scope: "meetup:orgs:read" });
    const cases: Array<[string, "GET" | "POST", string, unknown, string]> = [
      ["resource", "GET", "/meetings", undefined, "meetup:meetings:read"],
      ["resource", "GET", "/tasks", undefined, "meetup:tasks:read"],
      ["action", "POST", "/actions/tasks.create", { input: { title: "x" } }, "meetup:tasks:write"],
      ["action", "POST", "/actions/notifications.create", { input: {} }, "meetup:notifications:write"],
      ["webhooks", "POST", "/webhooks", { url: HOOK_URL, events: ["meeting.*"] }, "meetup:webhooks:manage"],
      ["webhooks", "GET", "/webhooks", undefined, "meetup:webhooks:manage"],
      ["events", "GET", "/events", undefined, "meetup:events:read"],
    ];
    for (const [kind, method, path, body, scope] of cases) {
      const res = await sendJson(t, token, method, path, body);
      expect(res.status, `${kind} ${method} ${path}`).toBe(403);
      expect(res.body!.error).toMatchObject({ code: "insufficient_scope", requiredScope: scope });
    }
    expect((await getJson(t, token, "/orgs")).status).toBe(200);
    expect((await getJson(t, token, "/me")).status).toBe(200);
  });
});

describe("C08 cross-tenant ids return 404", () => {
  it("never 403 — across reads, actions and webhooks", async () => {
    const { t, token } = await world();
    const foreignMeeting = String(await as(t, OUTSIDER).mutation(api.meetings.index.create, { orgId: OTHER_ORG, title: "Theirs" }));
    const foreignTask = String(await as(t, OUTSIDER).mutation(api.tasks.index.create, { orgId: OTHER_ORG, title: "Theirs" }));

    for (const path of [`/meetings/${foreignMeeting}`, `/meetings/${foreignMeeting}/transcript`, `/meetings/${foreignMeeting}/summary`]) {
      expect((await getJson(t, token, path)).status, path).toBe(404);
    }
    for (const [name, input] of [
      ["meetings.end", { meetingId: foreignMeeting }],
      ["meetings.invite", { meetingId: foreignMeeting, emails: ["a@b.co"] }],
      ["meetings.generateSummary", { meetingId: foreignMeeting }],
      ["tasks.update", { taskId: foreignTask, status: "done" }],
      ["tasks.create", { title: "x", meetingId: foreignMeeting }],
    ] as const) {
      expect((await act(t, token, name, input)).status, name).toBe(404);
    }
    const { id } = await registerHook(t, token, ["meeting.*"]);
    const { token: foreign } = await connect(t, { who: OUTSIDER, orgId: OTHER_ORG, scope: EVERYTHING });
    expect((await getJson(t, foreign, `/webhooks/${id}`)).status).toBe(404);
    await settle(t);
  });
});

describe("C09 a role downgrade takes effect on the next call", () => {
  it("cuts off reads, writes and webhooks the moment membership is removed", async () => {
    const { t } = await world();
    const { token } = await connect(t, { who: MEMBER, scope: EVERYTHING });
    expect((await getJson(t, token, "/meetings")).status).toBe(200);
    expect((await act(t, token, "tasks.create", { title: "ok" })).status).toBe(200);

    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("user_org_memberships")
        .withIndex("by_userTokenIdentifier_and_orgId", (q) => q.eq("userTokenIdentifier", MEMBER.tokenIdentifier))
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
      const user = await ctx.db.query("users").withIndex("by_tokenIdentifier", (q) => q.eq("tokenIdentifier", MEMBER.tokenIdentifier)).unique();
      if (user) await ctx.db.patch(user._id, { orgIds: [] });
    });

    for (const res of [
      await getJson(t, token, "/meetings"),
      await act(t, token, "tasks.create", { title: "denied" }),
      await sendJson(t, token, "POST", "/webhooks", { url: HOOK_URL, events: ["meeting.*"] }),
      await getJson(t, token, "/events"),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body!.error.code).toBe("forbidden");
    }
  });

  it("host-only rules apply to the connected user, not to the connector", async () => {
    const { t, token } = await world();
    const hostMeeting = (await act(t, token, "meetings.create", { title: "Mine" })).body!.output.meeting.id;
    const { token: member } = await connect(t, { who: MEMBER, scope: EVERYTHING });
    const res = await act(t, member, "meetings.end", { meetingId: hostMeeting });
    expect(res.status).toBe(403);
    await settle(t);
  });
});

describe("C10 idempotent replay / conflict", () => {
  it("replays, conflicts on a different body, and runs once", async () => {
    const { t, token } = await world();
    const send = (title: string) => act(t, token, "meetings.create", { title }, { "idempotency-key": "same" });
    const first = await send("A");
    const replay = await send("A");
    expect(replay.text).toBe(first.text);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect((await send("B")).status).toBe(422);
    expect((await t.run((ctx) => ctx.db.query("meetings").collect())).length).toBe(1);
    await settle(t);
  });
});

describe("C11 error shape on every failure path", () => {
  it("is always { error: { code, message, retryable, requestId } } as JSON, with a request id", async () => {
    const { t, token } = await world();
    const hostMeeting = (await act(t, token, "meetings.create", { title: "Mine" })).body!.output.meeting.id;
    const { token: member } = await connect(t, { who: MEMBER, scope: EVERYTHING });
    const { token: narrow } = await connect(t, { scope: "meetup:orgs:read" });
    const foreignMeeting = String(await as(t, OUTSIDER).mutation(api.meetings.index.create, { orgId: OTHER_ORG, title: "T" }));

    const failures: Array<[string, number, Promise<{ status: number; body: Record<string, any> | null; headers: Headers; text: string }>]> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      ["no token", 401, getJson(t, "", "/me")],
      ["bad token", 401, getJson(t, "cp1_meetup_nope", "/me")],
      ["insufficient scope", 403, getJson(t, narrow, "/meetings")],
      ["forbidden (not host)", 403, act(t, member, "meetings.end", { meetingId: hostMeeting })],
      ["unknown route", 404, getJson(t, token, "/nope")],
      ["foreign id", 404, getJson(t, token, `/meetings/${foreignMeeting}`)],
      ["unknown action", 404, act(t, token, "meetings.explode", {})],
      ["validation", 400, act(t, token, "meetings.create", {})],
      ["bad cursor", 400, getJson(t, token, "/meetings?cursor=zzz")],
      ["method not allowed", 405, sendJson(t, token, "DELETE", "/me")],
      ["too large", 413, act(t, token, "meetings.create", { title: "x".repeat(1_100_000) })],
      ["precondition", 412, act(t, token, "meetings.create", { title: "x", scheduledFor: new Date(T0 + 3_600_000).toISOString(), syncWithGoogleCalendar: true })],
    ];
    for (const [label, status, pending] of failures) {
      const res = await pending;
      expect(res.status, label).toBe(status);
      expect(res.headers.get("content-type"), label).toContain("application/json");
      expect(res.headers.get("x-request-id"), label).toBeTruthy();
      const { error } = res.body!;
      expect(Object.keys(error).sort(), label).toEqual(expect.arrayContaining(["code", "message", "requestId", "retryable"]));
      expect(typeof error.message).toBe("string");
      expect(error.requestId).toBe(res.headers.get("x-request-id"));
      expect(error.retryable, label).toBe(false);
      expect(res.text.trimStart().startsWith("<"), `${label} must never be HTML`).toBe(false);
    }

    // 409 conflict, 422 idempotency, 402 plan limit, 429 rate limit.
    installReceiver();
    for (let i = 0; i < 5; i += 1) await registerHook(t, token, ["meeting.*"], `https://hub.example.com/${i}`);
    expect((await sendJson(t, token, "POST", "/webhooks", { url: HOOK_URL, events: ["meeting.*"] })).body!.error.code).toBe("conflict");
    await act(t, token, "tasks.create", { title: "k" }, { "idempotency-key": "k" });
    expect((await act(t, token, "tasks.create", { title: "other" }, { "idempotency-key": "k" })).body!.error.code).toBe("idempotency_conflict");

    const starter = await world({ maxMeetings: 1 });
    await act(starter.t, starter.token, "meetings.create", { title: "one" });
    expect((await act(starter.t, starter.token, "meetings.create", { title: "two" })).body!.error.code).toBe("plan_limit");

    const grant = (await t.run((ctx) => ctx.db.query("connector_grants").collect()))[0];
    const limited = await t.run(async (ctx) => {
      const rows = await ctx.db.query("connector_ratelimits").collect();
      for (const row of rows) if (row.grantId === grant._id) await ctx.db.patch(row._id, { count: 120 });
      return rows.length;
    });
    expect(limited).toBeGreaterThan(0);
    const throttled = await getJson(t, token, "/me");
    expect(throttled.status).toBe(429);
    expect(throttled.body!.error).toMatchObject({ code: "rate_limited", retryable: true });
    expect(Number(throttled.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    await settle(t);
  });

  it("reports misconfiguration as a retryable 500 naming only the variables", async () => {
    vi.stubEnv("CONNECTOR_TOKEN_PEPPER", "");
    const t = newConvex();
    const res = await t.fetch("/connect/v1/health");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatchObject({ code: "internal", retryable: true });
    expect(body.error.message).toContain("CONNECTOR_TOKEN_PEPPER");
  });
});

describe("C12 pagination cursors", () => {
  it("pages without gaps or repeats while data is inserted", async () => {
    const { t, token } = await world();
    for (let i = 0; i < 5; i += 1) {
      tick();
      await act(t, token, "tasks.create", { title: `t${i}` });
    }
    const first = await getJson(t, token, "/tasks?limit=2");
    tick();
    await act(t, token, "tasks.create", { title: "new" });
    const rest: string[] = [];
    let cursor: string | null = first.body!.nextCursor;
    while (cursor) {
      const page = await getJson(t, token, `/tasks?limit=2&cursor=${encodeURIComponent(cursor)}`);
      rest.push(...page.body!.items.map((x: { title: string }) => x.title));
      cursor = page.body!.nextCursor;
    }
    expect([...first.body!.items.map((x: { title: string }) => x.title), ...rest]).toEqual(["t4", "t3", "t2", "t1", "t0"]);
  });
});

describe("C13 rate-limit headers and 429", () => {
  it("sends X-RateLimit-* on every authenticated response", async () => {
    const { t, token } = await world();
    const res = await getJson(t, token, "/me");
    expect(res.headers.get("x-ratelimit-limit")).toBe("120");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("119");
    expect(Number(res.headers.get("x-ratelimit-reset"))).toBeGreaterThan(T0 / 1000);
    const post = await act(t, token, "tasks.create", { title: "x" });
    expect(post.headers.get("x-ratelimit-remaining")).toBe("118");
  });
});

describe("C14 async action → 202 + operation reaches a terminal state", () => {
  it("polls to success", async () => {
    vi.stubEnv("GROQ_API_KEY", "k");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "S", key_points: [], decisions: [], action_items: [] }) } }] }), { status: 200 }),
      ),
    );
    const { t, token } = await world();
    const meetingId = (await act(t, token, "meetings.create", { title: "M" })).body!.output.meeting.id;
    await as(t, HOST).mutation(api.transcripts.index.add, { meetingId, text: "hello", timestamp: 1 });
    const accepted = await act(t, token, "meetings.generateSummary", { meetingId });
    expect(accepted.status).toBe(202);
    await settle(t);
    const op = await getJson(t, token, `/operations/${accepted.body!.operation.id}`);
    expect(["succeeded", "failed"]).toContain(op.body!.status);
    expect(op.body!.status).toBe("succeeded");
  });
});

describe("C15 webhook registration returns the secret once; signatures verify", () => {
  it("signs `<timestamp>.<rawBody>` with HMAC-SHA256 and sends the timestamp", async () => {
    const calls = installReceiver();
    const { t, token } = await world();
    const created = await sendJson(t, token, "POST", "/webhooks", { url: HOOK_URL, events: ["meeting.*"] });
    expect(created.body!.secret).toMatch(/^whsec_/);
    expect((await getJson(t, token, `/webhooks/${created.body!.id}`)).text).not.toContain(created.body!.secret);

    await act(t, token, "meetings.create", { title: "M" });
    await settle(t);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers["X-CP-Timestamp"]).toMatch(/^\d{10}$/);
    expect(await signatureIsValid(created.body!.secret, calls[0])).toBe(true);
  });
});

describe("C16 retries with backoff; 410 disables", () => {
  it("retries a failing endpoint with the same delivery id, and disables on 410", async () => {
    let calls = installReceiver((_r, n) => (n === 1 ? { status: 500, body: "" } : { status: 200, body: "" }));
    const { t, token } = await world();
    await registerHook(t, token, ["meeting.*"]);
    await act(t, token, "meetings.create", { title: "A" });
    await settle(t);
    expect(calls).toHaveLength(2);
    expect(calls[0].headers["X-CP-Delivery"]).toBe(calls[1].headers["X-CP-Delivery"]);

    calls = installReceiver(() => ({ status: 410, body: "gone" }));
    await act(t, token, "meetings.create", { title: "B" });
    await settle(t);
    const hooks = await getJson(t, token, "/webhooks");
    expect(hooks.body!.items[0]).toMatchObject({ status: "disabled", disabledReason: "endpoint_gone" });
    expect(calls).toHaveLength(1);
  });
});

describe("C17 SSRF rejects private URLs", () => {
  it("at registration", async () => {
    const { t, token } = await world();
    for (const url of ["https://127.0.0.1/x", "https://10.1.1.1/x", "https://169.254.169.254/x", "https://[::1]/x", "https://localhost/x", "http://hub.example.com/x"]) {
      expect((await sendJson(t, token, "POST", "/webhooks", { url, events: ["meeting.*"] })).status, url).toBe(400);
    }
  });
});

describe("C18 events echo the externalRef set by the creating action", () => {
  it("on the entity's events and on its children's", async () => {
    const { t, token } = await world();
    const ref = { hubProjectId: "p", hubRunId: "r", hubStepId: "s" };
    const meetingId = (await act(t, token, "meetings.create", { title: "M", externalRef: ref })).body!.output.meeting.id;
    await act(t, token, "tasks.create", { title: "child", meetingId });
    await act(t, token, "meetings.end", { meetingId });
    const events = (await getJson(t, token, "/events?limit=200")).body!.items as Array<{ type: string; externalRef: unknown }>;
    expect(events.map((e) => e.type)).toEqual(["meeting.started", "task.created", "meeting.ended"]);
    for (const event of events) expect(event.externalRef, event.type).toEqual(ref);
    await settle(t);
  });
});

describe("C19 outbox: an event exists iff the change committed", () => {
  it("rolls back with the transaction and commits with it", async () => {
    const { t } = await world();
    const actor = (await t.run((ctx) => actorFromTokenIdentifier(ctx, HOST.tokenIdentifier)))!;
    await expect(
      t.run(async (ctx) => {
        await createMeetingCore(ctx, actor, { orgId: ORG, title: "x" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await t.run((ctx) => ctx.db.query("connector_events").collect())).toEqual([]);
    await t.run((ctx) => createMeetingCore(ctx, actor, { orgId: ORG, title: "y" }));
    expect((await t.run((ctx) => ctx.db.query("connector_events").collect())).length).toBe(1);
    await settle(t);
  });
});

describe("C20 GET /events replays what webhooks delivered", () => {
  it("returns the same envelopes", async () => {
    const calls = installReceiver();
    const { t, token } = await world();
    await registerHook(t, token, ["meeting.*", "task.*"]);
    const meetingId = (await act(t, token, "meetings.create", { title: "M" })).body!.output.meeting.id;
    await act(t, token, "tasks.create", { title: "T", meetingId });
    await settle(t);
    const polled = (await getJson(t, token, "/events?limit=200")).body!.items as Array<{ id: string }>;
    for (const call of calls) expect(polled.find((e) => e.id === bodyOf(call).id)).toEqual(bodyOf(call));
    expect(polled.length).toBe(calls.length);
  });
});

describe("C21 no secret material in any response", () => {
  it("across every endpoint, including errors", async () => {
    const { t, token } = await world();
    await t.run(async (ctx) => {
      await ctx.db.insert("user_integrations", {
        userTokenIdentifier: HOST.tokenIdentifier, provider: "google_calendar", accountEmail: "h@g.test",
        accessToken: "ya29.TOPSECRET", refreshToken: "1//TOPSECRET", scope: [], tokenExpiresAt: T0 + 1e6,
        status: "connected", connectedAt: T0, updatedAt: T0,
      });
      await ctx.db.insert("notion_integrations", {
        userTokenIdentifier: HOST.tokenIdentifier, orgId: ORG, botId: "b", accessToken: "secret_TOPSECRET",
        status: "connected", connectedAt: T0, updatedAt: T0,
      });
    });
    const meetingId = (await act(t, token, "meetings.create", { title: "M" })).body!.output.meeting.id;
    const { id } = await registerHook(t, token, ["meeting.*"]);

    const responses = [
      await t.fetch("/connect/v1/health"),
      await t.fetch("/connect/v1/manifest"),
      await t.fetch("/connect/v1/openapi.json"),
      ...(await Promise.all(
        ["/me", "/orgs", "/members", "/meetings", `/meetings/${meetingId}`, `/meetings/${meetingId}/participants`,
          `/meetings/${meetingId}/transcript`, `/meetings/${meetingId}/summary`, `/meetings/${meetingId}/recordings`,
          `/meetings/${meetingId}/whiteboard`, "/tasks", "/insights", "/events", "/webhooks", `/webhooks/${id}`,
          `/webhooks/${id}/deliveries`, "/nope", "/operations/x"].map((p) =>
          t.fetch(`/connect/v1${p}`, { headers: { authorization: `Bearer ${token}` } }),
        ),
      )),
    ];
    // A real token is its prefix plus >= 43 base64url characters; the bare prefix appears in docs.
    const forbidden = /TOPSECRET|cp1r?_meetup_[A-Za-z0-9_-]{20,}|whsec_[A-Za-z0-9_-]{20,}|enc:v\d|secretEnc|accessHash|refreshHash|codeHash|client_secret|accessToken|refreshToken|PEPPER|ENCRYPTION_KEY|signals/;
    for (const response of responses) {
      const text = await response.text();
      expect(text, response.url).not.toMatch(forbidden);
    }
    await settle(t);
  });
});

describe("C22 feature flag off ⇒ every connect route is 404", () => {
  it("for every route in the table and every method", async () => {
    vi.stubEnv("CONNECTOR_ENABLED", "false");
    const t = newConvex();
    await seedWorld(t);
    const probes: Array<[string, string]> = [
      ["GET", "/health"], ["GET", "/manifest"], ["GET", "/openapi.json"], ["POST", "/oauth/token"], ["POST", "/oauth/revoke"],
      ["GET", "/me"], ["POST", "/actions/meetings.create"], ["GET", "/operations/x"], ["POST", "/webhooks"], ["GET", "/webhooks"],
      ["GET", "/webhooks/x"], ["PATCH", "/webhooks/x"], ["DELETE", "/webhooks/x"], ["GET", "/webhooks/x/deliveries"],
      ["POST", "/webhooks/x/deliveries/y/redeliver"], ["GET", "/events"], ["GET", "/recordings/x/media"],
      ...RESOURCES.map((r): [string, string] => [r.method, r.path.replace("{id}", "x")]),
    ];
    for (const [method, path] of probes) {
      expect(matchRoute(method, path), `${method} ${path} is a real route`).not.toBeNull();
      const res = await t.fetch(`/connect/v1${path}`, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect((await res.json()).error.code).toBe("not_found");
    }
    // The consent screen's backend and the Connected-apps list are inert too.
    expect(await as(t, HOST).query(api.connector.grants.listForOrg, { orgId: ORG })).toMatchObject({ enabled: false });
  });
});
