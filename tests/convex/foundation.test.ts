import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../../convex/schema";
import { writeAudit } from "../../convex/connector/audit";
import { beginIdempotent, completeIdempotent } from "../../convex/connector/idempotency";
import { consumeRateLimit, rateLimitHeaders } from "../../convex/connector/rateLimit";
import { enableConnector, modules } from "./helpers";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function seedGrant(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("connector_grants", {
      clientId: "hub",
      userTokenIdentifier: "https://clerk.test|user_1",
      orgId: "org_1",
      scopes: ["meetup:meetings:read"],
      accessHash: "a".repeat(64),
      accessExpiresAt: Date.now() + 3_600_000,
      refreshHash: "b".repeat(64),
      refreshExpiresAt: Date.now() + 90 * 86_400_000,
      refreshFamilyId: "fam_1",
      createdAt: Date.now(),
    }),
  );
}

describe("feature flag (C22)", () => {
  it("answers every connect route with a JSON 404 when disabled", async () => {
    const t = convexTest(schema, modules);
    for (const [method, path] of [
      ["GET", "/connect/v1/health"],
      ["GET", "/connect/v1/manifest"],
      ["GET", "/connect/v1/openapi.json"],
      ["POST", "/connect/v1/oauth/token"],
      ["POST", "/connect/v1/oauth/revoke"],
      ["GET", "/connect/v1/me"],
      ["POST", "/connect/v1/actions/meetings.create"],
      ["GET", "/connect/v1/meetings"],
    ] as const) {
      const response = await t.fetch(path, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
      const body = await response.json();
      expect(body.error.code).toBe("not_found");
      expect(body.error.requestId).toBeTruthy();
      expect(response.headers.get("content-type")).toContain("application/json");
    }
  });

  it("treats anything but the literal string 'true' as off", async () => {
    vi.stubEnv("CONNECTOR_ENABLED", "1");
    const t = convexTest(schema, modules);
    expect((await t.fetch("/connect/v1/health")).status).toBe(404);
  });
});

describe("public endpoints when enabled", () => {
  it("serves health without auth", async () => {
    enableConnector();
    const t = convexTest(schema, modules);
    const response = await t.fetch("/connect/v1/health", {
      headers: { "x-request-id": "trace-42" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("trace-42");
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBe("1.0.0");
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
    // health must not leak configuration
    expect(JSON.stringify(body)).not.toMatch(/secret|pepper|client/i);
  });

  it("serves the manifest with app-domain URLs and 5 minute caching", async () => {
    enableConnector();
    const t = convexTest(schema, modules);
    const response = await t.fetch("/connect/v1/manifest");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    const manifest = await response.json();
    expect(manifest.protocol).toBe("cp1");
    expect(manifest.baseUrl).toBe("https://meetup.example.com");
    expect(manifest.auth.tokenUrl).toBe("https://meetup.example.com/api/connect/v1/oauth/token");
    expect(JSON.stringify(manifest)).not.toContain("convex.site");
  });

  it("serves OpenAPI 3.1", async () => {
    enableConnector();
    const t = convexTest(schema, modules);
    const response = await t.fetch("/connect/v1/openapi.json");
    expect(response.status).toBe(200);
    expect((await response.json()).openapi).toBe("3.1.0");
  });

  it("never sends CORS headers (server-to-server only)", async () => {
    enableConnector();
    const t = convexTest(schema, modules);
    const response = await t.fetch("/connect/v1/health", {
      headers: { origin: "https://evil.example" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("returns the standard error shape for unknown routes, bad methods and missing tokens (C11)", async () => {
    enableConnector();
    const t = convexTest(schema, modules);

    const unknown = await t.fetch("/connect/v1/does-not-exist");
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toMatchObject({ code: "not_found", retryable: false });

    const wrongMethod = await t.fetch("/connect/v1/health", { method: "POST" });
    expect(wrongMethod.status).toBe(405);
    expect((await wrongMethod.json()).error.requestId).toBeTruthy();

    const noToken = await t.fetch("/connect/v1/me");
    expect(noToken.status).toBe(401);
    expect((await noToken.json()).error.code).toBe("unauthorized");
  });

  it("fails fast, naming only the missing variables, when misconfigured", async () => {
    enableConnector();
    vi.stubEnv("CONNECTOR_HUB_CLIENT_SECRET", "");
    vi.stubEnv("CONNECTOR_TOKEN_PEPPER", "");
    const t = convexTest(schema, modules);
    const response = await t.fetch("/connect/v1/health");
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.message).toContain("CONNECTOR_HUB_CLIENT_SECRET");
    expect(body.error.message).toContain("CONNECTOR_TOKEN_PEPPER");
    expect(body.error.message).not.toContain("s3cret");
  });
});

describe("rate limiting (C13)", () => {
  it("allows up to the limit, then blocks with Retry-After, shared via the database", async () => {
    const t = convexTest(schema, modules);
    const grantId = await seedGrant(t);
    const now = 1_700_000_010_000;

    const results = await t.run(async (ctx) => {
      const out = [];
      for (let i = 0; i < 4; i += 1) {
        out.push(await consumeRateLimit(ctx, grantId, "rpm", 3, now + i));
      }
      return out;
    });

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3].retryAfterSeconds).toBeGreaterThanOrEqual(1);

    const headers = rateLimitHeaders(results[3]);
    expect(headers["X-RateLimit-Limit"]).toBe("3");
    expect(headers["X-RateLimit-Remaining"]).toBe("0");
    expect(Number(headers["X-RateLimit-Reset"])).toBeGreaterThan(now / 1000);
    expect(headers["Retry-After"]).toBeDefined();
    expect(rateLimitHeaders(results[0])["Retry-After"]).toBeUndefined();
  });

  it("resets in the next window and keeps buckets separate", async () => {
    const t = convexTest(schema, modules);
    const grantId = await seedGrant(t);
    const now = 1_700_000_010_000;

    const out = await t.run(async (ctx) => {
      await consumeRateLimit(ctx, grantId, "rpm", 1, now);
      const blocked = await consumeRateLimit(ctx, grantId, "rpm", 1, now + 100);
      const otherBucket = await consumeRateLimit(ctx, grantId, "notif", 1, now + 100);
      const nextWindow = await consumeRateLimit(ctx, grantId, "rpm", 1, now + 61_000);
      return { blocked, otherBucket, nextWindow };
    });

    expect(out.blocked.allowed).toBe(false);
    expect(out.otherBucket.allowed).toBe(true);
    expect(out.nextWindow.allowed).toBe(true);
  });

  it("does not count over-limit calls", async () => {
    const t = convexTest(schema, modules);
    const grantId = await seedGrant(t);
    const now = 1_700_000_010_000;
    const rows = await t.run(async (ctx) => {
      for (let i = 0; i < 10; i += 1) await consumeRateLimit(ctx, grantId, "rpm", 2, now);
      return await ctx.db.query("connector_ratelimits").collect();
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(2);
  });
});

describe("idempotency (C10)", () => {
  it("replays the stored response for the same key and body", async () => {
    const t = convexTest(schema, modules);
    const grantId = await seedGrant(t);
    const out = await t.run(async (ctx) => {
      const now = Date.now();
      const first = await beginIdempotent(ctx, grantId, "key-1", "hash-a", now);
      await completeIdempotent(ctx, grantId, "key-1", "hash-a", 200, '{"output":{"ok":true}}', now);
      const second = await beginIdempotent(ctx, grantId, "key-1", "hash-a", now + 1000);
      return { first, second };
    });
    expect(out.first).toEqual({ kind: "fresh" });
    expect(out.second).toEqual({ kind: "replay", status: 200, response: '{"output":{"ok":true}}' });
  });

  it("flags the same key with a different body as a conflict", async () => {
    const t = convexTest(schema, modules);
    const grantId = await seedGrant(t);
    const kind = await t.run(async (ctx) => {
      const now = Date.now();
      await completeIdempotent(ctx, grantId, "key-1", "hash-a", 200, "{}", now);
      return (await beginIdempotent(ctx, grantId, "key-1", "hash-b", now)).kind;
    });
    expect(kind).toBe("conflict");
  });

  it("scopes keys per grant", async () => {
    const t = convexTest(schema, modules);
    const grantA = await seedGrant(t);
    const grantB = await seedGrant(t);
    const kind = await t.run(async (ctx) => {
      const now = Date.now();
      await completeIdempotent(ctx, grantA, "same", "h", 200, "{}", now);
      return (await beginIdempotent(ctx, grantB, "same", "h", now)).kind;
    });
    expect(kind).toBe("fresh");
  });

  it("forgets keys after 24 hours", async () => {
    const t = convexTest(schema, modules);
    const grantId = await seedGrant(t);
    const kind = await t.run(async (ctx) => {
      const now = Date.now();
      await completeIdempotent(ctx, grantId, "key-1", "hash-a", 200, "{}", now);
      return (await beginIdempotent(ctx, grantId, "key-1", "different", now + 24 * 3_600_000 + 1)).kind;
    });
    expect(kind).toBe("fresh");
  });
});

describe("audit", () => {
  it("records via=connector with client, grant, action and request id — and no payload", async () => {
    const t = convexTest(schema, modules);
    const grantId = await seedGrant(t);
    const rows = await t.run(async (ctx) => {
      const grant = (await ctx.db.get(grantId))!;
      await writeAudit(ctx, { grant, action: "meetings.create", method: "POST", status: 200, requestId: "req_1" }, 1000);
      await writeAudit(ctx, { grant, action: "meetings.end", method: "POST", status: 403, requestId: "req_2", errorCode: "forbidden" }, 2000);
      return await ctx.db.query("connector_audit").collect();
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      via: "connector",
      clientId: "hub",
      grantId,
      action: "meetings.create",
      requestId: "req_1",
      ok: true,
      orgId: "org_1",
    });
    expect(rows[1]).toMatchObject({ ok: false, errorCode: "forbidden", status: 403 });
    expect(Object.keys(rows[0])).not.toContain("body");
    expect(Object.keys(rows[0])).not.toContain("payload");
  });
});
