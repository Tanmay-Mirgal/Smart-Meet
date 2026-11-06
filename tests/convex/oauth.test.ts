import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { bytesToBase64Url, randomBytes, sha256Base64Url } from "../../convex/connector/crypto";
import {
  HOST,
  MEMBER,
  ORG,
  OUTSIDER,
  as,
  newConvex,
  seedWorld,
  type TestConvex,
  type TestUser,
} from "./fixtures";
import {
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
  TEST_REDIRECT,
  enableConnector,
} from "./helpers";

const T0 = new Date("2026-03-01T10:00:00.000Z");
const ALL = "meetup:orgs:read meetup:meetings:read meetup:tasks:write";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  enableConnector();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function world() {
  const t = newConvex();
  await seedWorld(t);
  return t;
}

/** Runs the real consent flow as `who` and returns the authorization code. */
async function authorize(
  t: TestConvex,
  who: TestUser = HOST,
  options: { scope?: string; orgId?: string } = {},
) {
  const verifier = bytesToBase64Url(randomBytes(32));
  const params = {
    clientId: TEST_CLIENT_ID,
    redirectUri: TEST_REDIRECT,
    responseType: "code",
    scope: options.scope ?? ALL,
    state: "st4te",
    codeChallenge: await sha256Base64Url(verifier),
    codeChallengeMethod: "S256",
  };
  const { redirectUrl } = await as(t, who).mutation(api.connector.consent.approve, {
    ...params,
    orgId: options.orgId ?? ORG,
  });
  const url = new URL(redirectUrl);
  return { code: url.searchParams.get("code")!, verifier, params, url };
}

function postToken(t: TestConvex, body: Record<string, string>, headers: Record<string, string> = {}) {
  return t.fetch("/connect/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });
}

const client = { client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET };

type Tokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
  tenant: { id: string; name: string; kind: string };
  user: { id: string; email: string | null; name: string };
};

async function connect(t: TestConvex, who: TestUser = HOST, scope?: string) {
  const { code, verifier } = await authorize(t, who, { scope });
  const response = await postToken(t, {
    ...client,
    grant_type: "authorization_code",
    code,
    redirect_uri: TEST_REDIRECT,
    code_verifier: verifier,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Tokens;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const me = (t: TestConvex, token: string) => t.fetch("/connect/v1/me", { headers: bearer(token) });

function refreshWith(t: TestConvex, refreshToken: string, extra: Record<string, string> = {}) {
  return postToken(t, { ...client, grant_type: "refresh_token", refresh_token: refreshToken, ...extra });
}

describe("consent screen backend", () => {
  const baseParams = async () => ({
    clientId: TEST_CLIENT_ID,
    redirectUri: TEST_REDIRECT,
    responseType: "code",
    scope: "meetup:meetings:read meetup:webhooks:manage",
    state: "abc",
    codeChallenge: await sha256Base64Url("v".repeat(43)),
    codeChallengeMethod: "S256",
  });

  it("reports disabled when the flag is off", async () => {
    vi.stubEnv("CONNECTOR_ENABLED", "false");
    const t = await world();
    expect(await as(t, HOST).query(api.connector.consent.prepare, await baseParams())).toEqual({
      status: "disabled",
    });
  });

  it("is ready with plain-language scopes (incl. implied events scope) and only the user's orgs", async () => {
    const t = await world();
    const hostView = await as(t, HOST).query(api.connector.consent.prepare, await baseParams());
    expect(hostView).toMatchObject({
      status: "ready",
      hubName: "Orbit Hub",
      user: { name: "Hana Host", email: "hana@example.com" },
      organizations: [{ id: ORG, name: "Acme" }],
    });
    if (hostView.status !== "ready") throw new Error("unreachable");
    expect(hostView.scopes.map((s) => s.name)).toEqual([
      "meetup:meetings:read",
      "meetup:webhooks:manage",
      "meetup:events:read",
    ]);
    expect(hostView.scopes.every((s) => s.description.length > 10)).toBe(true);
    expect(new URL(hostView.cancelUrl).searchParams.get("error")).toBe("access_denied");
    expect(new URL(hostView.cancelUrl).searchParams.get("state")).toBe("abc");

    const outsiderView = await as(t, OUTSIDER).query(api.connector.consent.prepare, await baseParams());
    expect(outsiderView).toMatchObject({ status: "ready", organizations: [{ id: "org_other" }] });
  });

  it("C04: never redirects for an unknown client or a non-exact redirect_uri", async () => {
    const t = await world();
    const params = await baseParams();
    for (const bad of [
      { clientId: "someone-else" },
      { redirectUri: `${TEST_REDIRECT}/` },
      { redirectUri: "https://evil.example.com/callback" },
      { redirectUri: `${TEST_REDIRECT}?x=1` },
      { redirectUri: undefined },
    ]) {
      const result = await as(t, HOST).query(api.connector.consent.prepare, { ...params, ...bad });
      expect(result.status).toBe("fatal");
      expect(JSON.stringify(result)).not.toContain("redirectUrl");
    }
  });

  it.each([
    ["wrong response_type", { responseType: "token" }, "unsupported_response_type", "abc"],
    ["missing PKCE method", { codeChallengeMethod: undefined }, "invalid_request", "abc"],
    ["plain PKCE method", { codeChallengeMethod: "plain" }, "invalid_request", "abc"],
    ["missing challenge", { codeChallenge: undefined }, "invalid_request", "abc"],
    ["malformed challenge", { codeChallenge: "short" }, "invalid_request", "abc"],
    ["unknown scope", { scope: "meetup:meetings:read root:all" }, "invalid_scope", "abc"],
    ["no scope", { scope: "" }, "invalid_scope", "abc"],
    ["missing state", { state: undefined }, "invalid_request", null],
  ])("redirects %s back with error and state", async (_label, change, error, state) => {
    const t = await world();
    const result = await as(t, HOST).query(api.connector.consent.prepare, {
      ...(await baseParams()),
      ...change,
    });
    expect(result.status).toBe("redirect");
    if (result.status !== "redirect") throw new Error("unreachable");
    const url = new URL(result.redirectUrl);
    expect(url.origin + url.pathname).toBe(TEST_REDIRECT);
    expect(url.searchParams.get("error")).toBe(error);
    expect(url.searchParams.get("state")).toBe(state);
  });

  it("only issues codes for orgs the user belongs to, and never anonymously", async () => {
    const t = await world();
    await expect(authorize(t, OUTSIDER, { orgId: ORG })).rejects.toThrow("Forbidden");
    await expect(
      t.mutation(api.connector.consent.approve, {
        ...(await baseParams()),
        orgId: ORG,
      }),
    ).rejects.toThrow("Unauthenticated");
  });

  it("issues a 60 s single-use code and stores only its hash", async () => {
    const t = await world();
    const { code, url } = await authorize(t);
    expect(url.origin + url.pathname).toBe(TEST_REDIRECT);
    expect(url.searchParams.get("state")).toBe("st4te");
    expect(code.length).toBeGreaterThanOrEqual(43);

    const rows = await t.run((ctx) => ctx.db.query("connector_codes").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain(code);
    expect(rows[0]).toMatchObject({
      orgId: ORG,
      userTokenIdentifier: HOST.tokenIdentifier,
      expiresAt: T0.getTime() + 60_000,
    });
    expect(rows[0].scopes).toEqual(ALL.split(" "));
  });
});

describe("token endpoint", () => {
  it("exchanges a code for tokens (response shape, no-store, hashes only)", async () => {
    const t = await world();
    const tokens = await connect(t);

    expect(tokens).toMatchObject({
      token_type: "Bearer",
      expires_in: 3600,
      scope: ALL,
      tenant: { id: ORG, name: "Acme", kind: "organization" },
      user: { email: "hana@example.com", name: "Hana Host" },
    });
    expect(tokens.access_token.startsWith("cp1_meetup_")).toBe(true);
    expect(tokens.refresh_token.startsWith("cp1r_meetup_")).toBe(true);
    expect(tokens.access_token.length).toBeGreaterThanOrEqual("cp1_meetup_".length + 43);
    expect(tokens.user.id).toBeTruthy();

    // No table may contain a plaintext token or code.
    const dump = await t.run(async (ctx) =>
      JSON.stringify({
        grants: await ctx.db.query("connector_grants").collect(),
        codes: await ctx.db.query("connector_codes").collect(),
        history: await ctx.db.query("connector_refresh_history").collect(),
      }),
    );
    expect(dump).not.toContain(tokens.access_token);
    expect(dump).not.toContain(tokens.refresh_token);
  });

  it("sets Cache-Control: no-store and Pragma: no-cache", async () => {
    const t = await world();
    const { code, verifier } = await authorize(t);
    const response = await postToken(t, {
      ...client,
      grant_type: "authorization_code",
      code,
      redirect_uri: TEST_REDIRECT,
      code_verifier: verifier,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
  });

  it("C02: PKCE is required and a wrong verifier fails — and burns the code", async () => {
    const t = await world();
    const { code, verifier } = await authorize(t);
    const wrong = await postToken(t, {
      ...client,
      grant_type: "authorization_code",
      code,
      redirect_uri: TEST_REDIRECT,
      code_verifier: "x".repeat(43),
    });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe("invalid_grant");

    // The right verifier no longer helps: the code was consumed by the failed try.
    const retry = await postToken(t, {
      ...client,
      grant_type: "authorization_code",
      code,
      redirect_uri: TEST_REDIRECT,
      code_verifier: verifier,
    });
    expect((await retry.json()).error).toBe("invalid_grant");

    const noVerifier = await postToken(t, {
      ...client,
      grant_type: "authorization_code",
      code,
      redirect_uri: TEST_REDIRECT,
    });
    expect(noVerifier.status).toBe(400);
    expect((await noVerifier.json()).error).toBe("invalid_request");
  });

  it("C03: a code is single use; reuse revokes the tokens issued from it", async () => {
    const t = await world();
    const { code, verifier } = await authorize(t);
    const body = {
      ...client,
      grant_type: "authorization_code",
      code,
      redirect_uri: TEST_REDIRECT,
      code_verifier: verifier,
    };
    const first = await postToken(t, body);
    expect(first.status).toBe(200);
    const tokens = (await first.json()) as Tokens;
    expect((await me(t, tokens.access_token)).status).toBe(200);

    const replay = await postToken(t, body);
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("invalid_grant");
    expect((await me(t, tokens.access_token)).status).toBe(401);
    expect((await refreshWith(t, tokens.refresh_token)).status).toBe(400);
  });

  it("C04: redirect_uri must match the authorization request exactly", async () => {
    const t = await world();
    const { code, verifier } = await authorize(t);
    const response = await postToken(t, {
      ...client,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${TEST_REDIRECT}/`,
      code_verifier: verifier,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_grant");
  });

  it("rejects codes after 60 seconds", async () => {
    const t = await world();
    const { code, verifier } = await authorize(t);
    vi.setSystemTime(new Date(T0.getTime() + 61_000));
    const response = await postToken(t, {
      ...client,
      grant_type: "authorization_code",
      code,
      redirect_uri: TEST_REDIRECT,
      code_verifier: verifier,
    });
    expect((await response.json()).error).toBe("invalid_grant");
  });

  it("authenticates the client (body, Basic) and rejects bad credentials", async () => {
    const t = await world();
    const attempt = async (headers: Record<string, string>, body: Record<string, string>) => {
      const { code, verifier } = await authorize(t);
      return postToken(
        t,
        { grant_type: "authorization_code", code, redirect_uri: TEST_REDIRECT, code_verifier: verifier, ...body },
        headers,
      );
    };

    const basic = `Basic ${btoa(`${encodeURIComponent(TEST_CLIENT_ID)}:${encodeURIComponent(TEST_CLIENT_SECRET)}`)}`;
    expect((await attempt({ authorization: basic }, {})).status).toBe(200);
    expect((await attempt({}, client)).status).toBe(200);

    const wrongSecret = await attempt({}, { client_id: TEST_CLIENT_ID, client_secret: "nope" });
    expect(wrongSecret.status).toBe(401);
    expect((await wrongSecret.json()).error).toBe("invalid_client");
    expect(wrongSecret.headers.get("www-authenticate")).toContain("Basic");
    expect((await attempt({}, {})).status).toBe(401);
    expect((await attempt({ authorization: "Basic !!!" }, {})).status).toBe(401);
  });

  it("accepts JSON bodies and rejects unknown grant types", async () => {
    const t = await world();
    const { code, verifier } = await authorize(t);
    const json = await t.fetch("/connect/v1/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...client,
        grant_type: "authorization_code",
        code,
        redirect_uri: TEST_REDIRECT,
        code_verifier: verifier,
      }),
    });
    expect(json.status).toBe(200);

    const other = await postToken(t, { ...client, grant_type: "password" });
    expect(other.status).toBe(400);
    expect((await other.json()).error).toBe("unsupported_grant_type");
  });

  it("C05: refresh rotates tokens; reusing a rotated refresh token revokes the family", async () => {
    const t = await world();
    const first = await connect(t);

    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    const rotated = await refreshWith(t, first.refresh_token);
    expect(rotated.status).toBe(200);
    const second = (await rotated.json()) as Tokens;
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.scope).toBe(ALL);

    // The old access token died with the rotation; the new one works.
    expect((await me(t, first.access_token)).status).toBe(401);
    expect((await me(t, second.access_token)).status).toBe(200);

    // Replaying the already-rotated refresh token is theft: whole grant revoked.
    const replay = await refreshWith(t, first.refresh_token);
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("invalid_grant");
    expect((await me(t, second.access_token)).status).toBe(401);
    expect((await refreshWith(t, second.refresh_token)).status).toBe(400);

    const grant = (await t.run((ctx) => ctx.db.query("connector_grants").collect()))[0];
    expect(grant.revokedReason).toBe("refresh_token_reuse");
  });

  it("refresh cannot widen scope and respects the 90-day lifetime", async () => {
    const t = await world();
    const tokens = await connect(t);

    const widen = await refreshWith(t, tokens.refresh_token, { scope: `${ALL} meetup:webhooks:manage` });
    expect(widen.status).toBe(400);
    expect((await widen.json()).error).toBe("invalid_scope");

    vi.setSystemTime(new Date(T0.getTime() + 91 * 86_400_000));
    const expired = await refreshWith(t, tokens.refresh_token);
    expect((await expired.json()).error).toBe("invalid_grant");
  });

  it("revokes the grant when the user left the organization", async () => {
    const t = await world();
    const tokens = await connect(t);
    await removeMembership(t, HOST);
    const response = await refreshWith(t, tokens.refresh_token);
    expect((await response.json()).error).toBe("invalid_grant");
    const grant = (await t.run((ctx) => ctx.db.query("connector_grants").collect()))[0];
    expect(grant.revokedReason).toBe("membership_lost");
  });
});

async function removeMembership(t: TestConvex, who: TestUser) {
  await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("user_org_memberships")
      .withIndex("by_userTokenIdentifier_and_orgId", (q) =>
        q.eq("userTokenIdentifier", who.tokenIdentifier),
      )
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    const user = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) => q.eq("tokenIdentifier", who.tokenIdentifier))
      .unique();
    if (user) await ctx.db.patch(user._id, { orgIds: [] });
  });
}

describe("revocation (C06)", () => {
  const revokeToken = (t: TestConvex, token: string, headers: Record<string, string> = {}, withClient = true) =>
    t.fetch("/connect/v1/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ token, ...(withClient ? client : {}) }).toString(),
    });

  it("kills the access token immediately", async () => {
    const t = await world();
    const tokens = await connect(t);
    expect((await me(t, tokens.access_token)).status).toBe(200);
    expect((await revokeToken(t, tokens.access_token)).status).toBe(200);
    expect((await me(t, tokens.access_token)).status).toBe(401);
    expect((await refreshWith(t, tokens.refresh_token)).status).toBe(400);
  });

  it("works with the refresh token too", async () => {
    const t = await world();
    const tokens = await connect(t);
    await revokeToken(t, tokens.refresh_token);
    expect((await me(t, tokens.access_token)).status).toBe(401);
  });

  it("always answers 200 — unknown tokens, bad client, no token", async () => {
    const t = await world();
    const tokens = await connect(t);
    expect((await revokeToken(t, "cp1_meetup_doesnotexist")).status).toBe(200);
    expect((await t.fetch("/connect/v1/oauth/revoke", { method: "POST", body: "" })).status).toBe(200);

    // Wrong client secret: 200, but nothing is revoked.
    const bad = await t.fetch("/connect/v1/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.access_token, client_id: TEST_CLIENT_ID, client_secret: "bad" }).toString(),
    });
    expect(bad.status).toBe(200);
    expect((await me(t, tokens.access_token)).status).toBe(200);
  });

  it("can be done by the user from Meetup, but only for their own grants", async () => {
    const t = await world();
    const tokens = await connect(t, HOST);
    const grantId = (await t.run((ctx) => ctx.db.query("connector_grants").collect()))[0]._id;

    await expect(as(t, MEMBER).mutation(api.connector.grants.revoke, { grantId })).rejects.toThrow(
      "Connection not found",
    );
    expect((await me(t, tokens.access_token)).status).toBe(200);

    await as(t, HOST).mutation(api.connector.grants.revoke, { grantId });
    expect((await me(t, tokens.access_token)).status).toBe(401);
  });

  it("disables the grant's webhook endpoints and cancels pending deliveries", async () => {
    const t = await world();
    const tokens = await connect(t);
    const grantId = (await t.run((ctx) => ctx.db.query("connector_grants").collect()))[0]._id;
    const webhookId = await insertWebhook(t, grantId);

    await revokeToken(t, tokens.access_token);
    const webhook = await t.run((ctx) => ctx.db.get(webhookId));
    expect(webhook).toMatchObject({ status: "disabled", disabledReason: "grant_revoked" });
  });
});

async function insertWebhook(t: TestConvex, grantId: Id<"connector_grants">) {
  return await t.run((ctx) =>
    ctx.db.insert("connector_webhooks", {
      grantId,
      orgId: ORG,
      url: "https://hub.example.com/hook",
      events: ["meeting.*"],
      secretEnc: "enc:v1:x:y",
      status: "active",
      consecutiveFailures: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

describe("bearer gate (CP1 §2.4)", () => {
  it("answers missing, malformed and unknown tokens with the standard 401", async () => {
    const t = await world();
    for (const headers of [
      {},
      { authorization: "Bearer" },
      { authorization: "Basic abc" },
      bearer("not-a-token"),
      bearer("cp1_meetup_" + "A".repeat(43)),
    ]) {
      const response = await t.fetch("/connect/v1/me", { headers });
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toMatchObject({ code: "unauthorized", retryable: false });
      expect(body.error.requestId).toBeTruthy();
    }
  });

  it("serves /me with user, tenant, scopes, plan and capabilities", async () => {
    const t = await world();
    const tokens = await connect(t);
    const response = await me(t, tokens.access_token);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      user: { email: "hana@example.com", name: "Hana Host" },
      tenant: { id: ORG, name: "Acme", kind: "organization" },
      scopes: ALL.split(" "),
      plan: {
        name: "Starter",
        limits: { maxMeetings: 10 },
        usage: { meetingsUsed: 0, meetingsRemaining: 10 },
      },
      capabilities: {
        aiSummary: false,
        recording: false,
        notionExport: false,
        googleCalendarSync: false,
        meetingsUsed: 0,
        meetingsCap: 10,
      },
    });
    expect(body.grantId).toBeTruthy();
    // C21: nothing secret in the response.
    expect(JSON.stringify(body)).not.toMatch(/cp1r?_meetup_|SECRET|secret|pepper/);
  });

  it("C07: enforces scopes per endpoint and names the missing one", async () => {
    const t = await world();
    const tokens = await connect(t, HOST, "meetup:orgs:read");
    const response = await t.fetch("/connect/v1/meetings", { headers: bearer(tokens.access_token) });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatchObject({
      code: "insufficient_scope",
      requiredScope: "meetup:meetings:read",
    });
    // /me needs no scope.
    expect((await me(t, tokens.access_token)).status).toBe(200);
  });

  it("C09: a user who loses org membership is cut off on the very next call", async () => {
    const t = await world();
    const tokens = await connect(t, MEMBER);
    expect((await me(t, tokens.access_token)).status).toBe(200);

    await removeMembership(t, MEMBER);
    const response = await me(t, tokens.access_token);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  });

  it("C13: sends rate-limit headers and answers 429 with Retry-After at the limit", async () => {
    const t = await world();
    const tokens = await connect(t);
    const first = await me(t, tokens.access_token);
    expect(first.headers.get("x-ratelimit-limit")).toBe("120");
    expect(first.headers.get("x-ratelimit-remaining")).toBe("119");
    expect(Number(first.headers.get("x-ratelimit-reset"))).toBeGreaterThan(T0.getTime() / 1000);

    const grantId = (await t.run((ctx) => ctx.db.query("connector_grants").collect()))[0]._id;
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("connector_ratelimits").collect())[0];
      await ctx.db.patch(row._id, { count: 120 });
      void grantId;
    });

    const limited = await me(t, tokens.access_token);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
    expect((await limited.json()).error).toMatchObject({ code: "rate_limited", retryable: true });

    // A new minute starts a new window.
    vi.setSystemTime(new Date(T0.getTime() + 61_000));
    expect((await me(t, tokens.access_token)).status).toBe(200);
  });

  it("expires access tokens after one hour", async () => {
    const t = await world();
    const tokens = await connect(t);
    vi.setSystemTime(new Date(T0.getTime() + 59 * 60_000));
    expect((await me(t, tokens.access_token)).status).toBe(200);
    vi.setSystemTime(new Date(T0.getTime() + 61 * 60_000));
    expect((await me(t, tokens.access_token)).status).toBe(401);
  });

  it("writes lastUsedAt at most once per 5 minutes", async () => {
    const t = await world();
    const tokens = await connect(t);
    const lastUsed = async () =>
      (await t.run((ctx) => ctx.db.query("connector_grants").collect()))[0].lastUsedAt;

    await me(t, tokens.access_token);
    expect(await lastUsed()).toBe(T0.getTime());
    vi.setSystemTime(new Date(T0.getTime() + 4 * 60_000));
    await me(t, tokens.access_token);
    expect(await lastUsed()).toBe(T0.getTime());
    vi.setSystemTime(new Date(T0.getTime() + 6 * 60_000));
    await me(t, tokens.access_token);
    expect(await lastUsed()).toBe(T0.getTime() + 6 * 60_000);
  });

  it("audits every authenticated call as via=connector, including failures", async () => {
    const t = await world();
    const tokens = await connect(t, HOST, "meetup:orgs:read");
    await me(t, tokens.access_token);
    await t.fetch("/connect/v1/meetings", { headers: { ...bearer(tokens.access_token), "x-request-id": "trace-77" } });

    const rows = await t.run((ctx) => ctx.db.query("connector_audit").collect());
    expect(rows.map((r) => [r.action, r.status, r.ok])).toEqual([
      ["me", 200, true],
      ["meetings.list", 403, false],
    ]);
    expect(rows[1]).toMatchObject({
      via: "connector",
      clientId: TEST_CLIENT_ID,
      orgId: ORG,
      errorCode: "insufficient_scope",
      requestId: "trace-77",
    });
  });
});

describe("Connected apps", () => {
  it("lists the user's own active grants with webhook health and recent activity", async () => {
    const t = await world();
    const tokens = await connect(t, HOST);
    await me(t, tokens.access_token);
    const grantId = (await t.run((ctx) => ctx.db.query("connector_grants").collect()))[0]._id;
    await insertWebhook(t, grantId);

    const view = await as(t, HOST).query(api.connector.grants.listForOrg, { orgId: ORG });
    expect(view.enabled).toBe(true);
    expect(view.hubName).toBe("Orbit Hub");
    expect(view.grants).toHaveLength(1);
    expect(view.grants[0]).toMatchObject({
      id: grantId,
      scopes: ALL.split(" "),
      connectedBy: "Hana Host",
      lastUsedAt: T0.getTime(),
      webhooks: [{ url: "https://hub.example.com/hook", status: "active" }],
    });
    expect(view.activity.map((a) => a.action)).toEqual(["me"]);

    // Other users see none of it.
    const other = await as(t, MEMBER).query(api.connector.grants.listForOrg, { orgId: ORG });
    expect(other.grants).toEqual([]);
    expect(other.activity).toEqual([]);

    await as(t, HOST).mutation(api.connector.grants.revoke, { grantId });
    expect((await as(t, HOST).query(api.connector.grants.listForOrg, { orgId: ORG })).grants).toEqual([]);
  });

  it("is a no-op with the flag off", async () => {
    vi.stubEnv("CONNECTOR_ENABLED", "false");
    const t = await world();
    expect(await as(t, HOST).query(api.connector.grants.listForOrg, { orgId: ORG })).toEqual({
      enabled: false,
      hubName: "",
      grants: [],
      activity: [],
    });
  });
});
