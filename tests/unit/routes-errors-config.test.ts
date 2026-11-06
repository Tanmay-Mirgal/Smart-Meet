import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import {
  getMissingConfig,
  isRedirectSchemeAllowed,
  isRegisteredRedirectUri,
  parseRedirectUris,
} from "../../convex/connector/config";
import {
  buildErrorBody,
  ConnectorError,
  isRetryableStatus,
  normalizeError,
  toConvexError,
} from "../../convex/connector/errors";
import { canonicalJson, getRequestId } from "../../convex/connector/httpUtil";
import { isPublicRoute, matchRoute, pathExistsForOtherMethod } from "../../convex/connector/routes";
import { InputError, PlanLimitError, PreconditionError } from "../../convex/lib/errors";

afterEach(() => vi.unstubAllEnvs());

describe("routes", () => {
  it("matches public endpoints", () => {
    expect(matchRoute("GET", "/health")?.kind).toBe("health");
    expect(matchRoute("GET", "/manifest")?.kind).toBe("manifest");
    expect(matchRoute("GET", "/openapi.json")?.kind).toBe("openapi");
    expect(matchRoute("POST", "/oauth/token")?.kind).toBe("oauth.token");
    expect(matchRoute("POST", "/oauth/revoke")?.kind).toBe("oauth.revoke");
    expect(isPublicRoute(matchRoute("GET", "/health")!)).toBe(true);
    expect(isPublicRoute(matchRoute("GET", "/me")!)).toBe(false);
  });

  it("extracts path params", () => {
    expect(matchRoute("GET", "/meetings/abc123/transcript")).toEqual({
      kind: "resource",
      name: "meetings.transcript",
      params: { id: "abc123" },
    });
    expect(matchRoute("POST", "/actions/meetings.create")).toEqual({
      kind: "action",
      params: { name: "meetings.create" },
    });
    expect(matchRoute("POST", "/webhooks/w1/deliveries/d1/redeliver")).toEqual({
      kind: "webhooks.redeliver",
      params: { id: "w1", deliveryId: "d1" },
    });
  });

  it("does not let '/meetings/x' swallow longer or shorter paths", () => {
    expect(matchRoute("GET", "/meetings")?.kind).toBe("resource");
    expect(matchRoute("GET", "/meetings/a/b/c")).toBeNull();
    expect(matchRoute("GET", "/nope")).toBeNull();
  });

  it("reports method mismatches", () => {
    expect(matchRoute("DELETE", "/health")).toBeNull();
    expect(pathExistsForOtherMethod("DELETE", "/health")).toBe(true);
    expect(pathExistsForOtherMethod("GET", "/nope")).toBe(false);
  });
});

describe("error shape (C11)", () => {
  it("builds the CP1 error body", () => {
    const body = buildErrorBody(
      new ConnectorError("validation_failed", "Bad input", {
        details: [{ path: "title", message: "Required" }],
      }),
      "req_1",
    );
    expect(body).toEqual({
      error: {
        code: "validation_failed",
        message: "Bad input",
        details: [{ path: "title", message: "Required" }],
        retryable: false,
        requestId: "req_1",
      },
    });
  });

  it("maps every code to the documented status", () => {
    const expected = {
      unauthorized: 401,
      insufficient_scope: 403,
      forbidden: 403,
      not_found: 404,
      validation_failed: 400,
      conflict: 409,
      idempotency_conflict: 422,
      plan_limit: 402,
      precondition_failed: 412,
      rate_limited: 429,
      upstream_failed: 502,
      unavailable: 503,
      internal: 500,
    } as const;
    for (const [code, status] of Object.entries(expected)) {
      expect(new ConnectorError(code as keyof typeof expected, "m").status).toBe(status);
    }
  });

  it("flags retryable only for 429/5xx", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(412)).toBe(false);
  });

  it("includes requiredScope / limit / fixUrl extras but not retryAfterSeconds", () => {
    const body = buildErrorBody(
      new ConnectorError("insufficient_scope", "no", { extras: { requiredScope: "meetup:tasks:write" } }),
      "r",
    );
    expect(body.error.requiredScope).toBe("meetup:tasks:write");
    const rl = buildErrorBody(
      new ConnectorError("rate_limited", "slow", { extras: { retryAfterSeconds: 7 } }),
      "r",
    );
    expect(rl.error).not.toHaveProperty("retryAfterSeconds");
  });

  it("survives a ConvexError round trip (rolled-back mutation)", () => {
    const original = new ConnectorError("plan_limit", "cap", { extras: { limit: 10, feature: "aiSummary" } });
    const restored = normalizeError(toConvexError(original));
    expect(restored.code).toBe("plan_limit");
    expect(restored.status).toBe(402);
    expect(restored.extras).toEqual({ limit: 10, feature: "aiSummary" });
  });
});

describe("normalizeError maps core errors", () => {
  it("typed errors", () => {
    expect(normalizeError(new PlanLimitError("cap", { limit: 10 })).code).toBe("plan_limit");
    const pre = normalizeError(new PreconditionError("connect google", "/integrations"));
    expect(pre.code).toBe("precondition_failed");
    expect(pre.extras?.fixUrl).toBe("/integrations");
    expect(normalizeError(new InputError("bad", "scheduledFor")).details).toEqual([
      { path: "scheduledFor", message: "bad" },
    ]);
  });

  it("legacy messages", () => {
    expect(normalizeError(new Error("Forbidden")).code).toBe("forbidden");
    expect(normalizeError(new Error("Meeting not found")).code).toBe("not_found");
    expect(normalizeError(new Error("Task not found")).code).toBe("not_found");
    const host = normalizeError(new Error("Only the host can perform this action"));
    expect(host.code).toBe("forbidden");
    expect(host.message).toMatch(/host/i);
    expect(normalizeError(new Error("You do not have permission to invite people")).code).toBe("forbidden");
  });

  it("never leaks unknown messages", () => {
    const err = normalizeError(new Error("secret db path /var/x"));
    expect(err.code).toBe("internal");
    expect(err.message).toBe("Internal error");
    expect(normalizeError(new ConvexError("plain")).code).toBe("internal");
  });
});

describe("request ids & canonical json", () => {
  it("echoes a sane X-Request-Id and generates one otherwise", () => {
    expect(getRequestId(new Request("https://x", { headers: { "x-request-id": "abc-123" } }))).toBe("abc-123");
    expect(getRequestId(new Request("https://x", { headers: { "x-request-id": "bad id!" } }))).toMatch(/^req_/);
    expect(getRequestId(new Request("https://x"))).toMatch(/^req_[0-9a-f]{24}$/);
  });

  it("canonicalises key order and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: undefined }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"z":1}]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});

describe("config & redirect URIs (C04)", () => {
  it("lists missing settings by name only", () => {
    const missing = getMissingConfig();
    expect(missing).toContain("CONNECTOR_HUB_CLIENT_SECRET");
    expect(missing.join(" ")).not.toMatch(/=/);
  });

  it("validates pepper and key shape", () => {
    vi.stubEnv("CONNECTOR_TOKEN_PEPPER", "short");
    vi.stubEnv("CONNECTOR_ENCRYPTION_KEY", "zz");
    const missing = getMissingConfig().join(" ");
    expect(missing).toMatch(/PEPPER \(must be at least 32/);
    expect(missing).toMatch(/ENCRYPTION_KEY \(must be 64 hex/);
  });

  it("parses the redirect list", () => {
    expect(parseRedirectUris(" https://a/cb , https://b/cb ,, ")).toEqual(["https://a/cb", "https://b/cb"]);
  });

  it("requires an EXACT match and https", () => {
    const list = ["https://hub.example.com/callback"];
    expect(isRegisteredRedirectUri("https://hub.example.com/callback", list)).toBe(true);
    expect(isRegisteredRedirectUri("https://hub.example.com/callback/", list)).toBe(false);
    expect(isRegisteredRedirectUri("https://hub.example.com/callback?x=1", list)).toBe(false);
    expect(isRegisteredRedirectUri("https://evil.example.com/callback", list)).toBe(false);
    expect(isRegisteredRedirectUri("http://hub.example.com/callback", ["http://hub.example.com/callback"])).toBe(false);
  });

  it("allows http://localhost only in dev mode", () => {
    expect(isRedirectSchemeAllowed("http://localhost:4000/cb")).toBe(false);
    vi.stubEnv("CONNECTOR_DEV_MODE", "true");
    expect(isRedirectSchemeAllowed("http://localhost:4000/cb")).toBe(true);
    expect(isRedirectSchemeAllowed("http://example.com/cb")).toBe(false);
    expect(isRedirectSchemeAllowed("https://hub.example.com/cb#frag")).toBe(false);
  });
});
