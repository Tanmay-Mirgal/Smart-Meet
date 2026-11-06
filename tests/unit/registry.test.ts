import { describe, expect, it } from "vitest";
import { buildManifest } from "../../convex/connector/manifest";
import { buildOpenApi } from "../../convex/connector/openapi";
import {
  ACTIONS,
  EVENTS,
  RESOURCES,
  isValidEventPattern,
  matchesEventPattern,
  stripUnknownFields,
  toJsonSchema,
} from "../../convex/connector/registry";
import { ALL_SCOPES, SCOPE_DEFINITIONS } from "../../convex/connector/scopes";

const APP = "https://meetup.example.com";

describe("manifest (C01)", () => {
  const manifest = buildManifest({ appUrl: APP });

  it("has the CP1 envelope", () => {
    expect(manifest).toMatchObject({
      protocol: "cp1",
      service: "meetup",
      displayName: "Meetup",
      version: "1.0.0",
      baseUrl: APP,
      tenantKind: "organization",
      limits: { requestsPerMinute: 120, maxBodyBytes: 1048576, webhookMaxEndpoints: 5 },
    });
    expect(manifest.links.openapi).toBe("/api/connect/v1/openapi.json");
  });

  it("advertises app-domain URLs only, never the convex.site origin", () => {
    const text = JSON.stringify(manifest);
    expect(manifest.auth.authorizeUrl).toBe(`${APP}/connect/authorize`);
    expect(manifest.auth.tokenUrl).toBe(`${APP}/api/connect/v1/oauth/token`);
    expect(manifest.auth.revokeUrl).toBe(`${APP}/api/connect/v1/oauth/revoke`);
    expect(text).not.toContain("convex.site");
    expect(manifest.auth.type).toBe("oauth2_code_pkce");
  });

  it("lists exactly the registry actions, resources and events", () => {
    expect(manifest.actions.map((a) => a.name)).toEqual(ACTIONS.map((a) => a.name));
    expect(manifest.resources.map((r) => r.name)).toEqual(RESOURCES.map((r) => r.name));
    expect(manifest.events.map((e) => e.type)).toEqual(EVENTS.map((e) => e.type));
  });

  it("only references declared scopes", () => {
    const known = new Set<string>(ALL_SCOPES);
    for (const entry of [...manifest.actions, ...manifest.resources, ...manifest.events]) {
      for (const scope of entry.scopes) expect(known.has(scope)).toBe(true);
    }
    expect(manifest.auth.scopes).toHaveLength(SCOPE_DEFINITIONS.length);
  });

  it("emits JSON Schema 2020-12 input schemas a form builder can render", () => {
    for (const action of manifest.actions) {
      const schema = action.inputSchema as {
        $schema?: string;
        type?: string;
        properties?: Record<string, { description?: string; title?: string }>;
        additionalProperties?: unknown;
      };
      expect(schema.$schema).toContain("2020-12");
      expect(schema.type).toBe("object");
      // Strict: unknown fields are rejected unless the caller opts in.
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(0);
      for (const [name, prop] of Object.entries(schema.properties ?? {})) {
        expect(
          Boolean(prop.description ?? prop.title),
          `${action.name}.${name} needs a description`,
        ).toBe(true);
      }
    }
  });

  it("documents enum, default, length limits and examples on meetings.create", () => {
    const create = manifest.actions.find((a) => a.name === "meetings.create")!;
    const props = (create.inputSchema as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(props.title.minLength).toBe(1);
    expect(props.title.maxLength).toBe(200);
    expect(props.title.examples).toBeDefined();
    expect(props.syncWithGoogleCalendar.default).toBe(false);
    const settings = props.settings as { properties: Record<string, { enum?: string[] }> };
    expect(settings.properties.joinMode.enum).toContain("organization_only");
  });

  it("marks only generateSummary as async", () => {
    const asyncActions = manifest.actions.filter((a) => a.async).map((a) => a.name);
    expect(asyncActions).toEqual(["meetings.generateSummary"]);
    expect(manifest.actions.every((a) => a.idempotent)).toBe(true);
  });

  it("requires both scopes for generateSummary", () => {
    const action = manifest.actions.find((a) => a.name === "meetings.generateSummary")!;
    expect(action.scopes).toEqual(["meetup:summaries:read", "meetup:meetings:write"]);
  });

  it("includes the headline event with its documented payload", () => {
    const event = manifest.events.find((e) => e.type === "meeting.summary.ready")!;
    const data = event.dataSchema as { properties: Record<string, unknown> };
    for (const key of ["meeting", "summary", "keyPoints", "decisions", "actionItems", "participants", "version"]) {
      expect(data.properties).toHaveProperty(key);
    }
  });
});

describe("openapi", () => {
  const doc = buildOpenApi({ appUrl: APP });

  it("is OpenAPI 3.1 with an action path per registry action", () => {
    expect(doc.openapi).toBe("3.1.0");
    for (const action of ACTIONS) {
      expect(doc.paths).toHaveProperty(`/actions/${action.name}`);
    }
    for (const resource of RESOURCES) {
      expect(doc.paths).toHaveProperty(resource.path);
    }
    expect(doc.servers[0].url).toBe(`${APP}/api/connect/v1`);
  });
});

describe("action input validation", () => {
  const create = ACTIONS.find((a) => a.name === "meetings.create")!;

  it("rejects unknown fields (strict)", () => {
    expect(create.input.safeParse({ title: "x", bogus: 1 }).success).toBe(false);
  });

  it("accepts a minimal valid input", () => {
    expect(create.input.safeParse({ title: "Standup" }).success).toBe(true);
  });

  it("strips unknown fields when the caller asks to ignore them", () => {
    const schema = toJsonSchema(create.input, "input");
    const cleaned = stripUnknownFields(schema, {
      title: "x",
      bogus: 1,
      settings: { joinMode: "invite_only", nope: true },
      metadata: { anything: "goes" },
    });
    expect(cleaned).toEqual({
      title: "x",
      settings: { joinMode: "invite_only" },
      metadata: { anything: "goes" },
    });
    expect(create.input.safeParse(cleaned).success).toBe(true);
  });

  it("caps metadata at 2 KB", () => {
    const big = { title: "x", metadata: { blob: "a".repeat(2100) } };
    expect(create.input.safeParse(big).success).toBe(false);
  });

  it("requires exactly one recipient for notifications.create", () => {
    const notify = ACTIONS.find((a) => a.name === "notifications.create")!;
    const base = { title: "t", message: "m" };
    expect(notify.input.safeParse(base).success).toBe(false);
    expect(notify.input.safeParse({ ...base, userEmail: "a@b.co", userId: "x" }).success).toBe(false);
    expect(notify.input.safeParse({ ...base, userEmail: "a@b.co" }).success).toBe(true);
  });
});

describe("event patterns", () => {
  it("matches exact types and prefix wildcards", () => {
    expect(matchesEventPattern("meeting.ended", "meeting.ended")).toBe(true);
    expect(matchesEventPattern("meeting.*", "meeting.summary.ready")).toBe(true);
    expect(matchesEventPattern("meeting.*", "task.created")).toBe(false);
    expect(matchesEventPattern("meeting.end", "meeting.ended")).toBe(false);
  });

  it("validates subscriptions against real event types", () => {
    expect(isValidEventPattern("meeting.*")).toBe(true);
    expect(isValidEventPattern("task.completed")).toBe(true);
    expect(isValidEventPattern("nonsense.*")).toBe(false);
    expect(isValidEventPattern("*")).toBe(false);
    expect(isValidEventPattern("meeting.nope")).toBe(false);
  });
});
