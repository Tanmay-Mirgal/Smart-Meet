import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_STATUS } from "../../convex/connector/errors";
import { ACTIONS, EVENTS, RESOURCES } from "../../convex/connector/registry";
import { SCOPE_DEFINITIONS } from "../../convex/connector/scopes";
import { eventEnvelope } from "../../convex/connector/standard";

const root = path.resolve(__dirname, "../..");
const docs = fs.readFileSync(path.join(root, "docs/CONNECTOR.md"), "utf8");
const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");

/** The first ```json fence after each `### <heading>` inside the "Event catalog" section. */
function eventSamples() {
  const section = docs.split("\n## Event catalog")[1]?.split("\n## Polling fallback")[0] ?? "";
  const samples = new Map<string, unknown>();
  for (const block of section.split(/\n### /).slice(1)) {
    const heading = block.split("\n")[0].trim();
    const fence = /```json\n([\s\S]*?)\n```/.exec(block.slice(heading.length));
    if (fence) samples.set(heading, JSON.parse(fence[1]));
  }
  return samples;
}

describe("docs/CONNECTOR.md stays true to the code", () => {
  const samples = eventSamples();

  it("documents every event with a sample", () => {
    expect([...samples.keys()].sort()).toEqual(EVENTS.map((e) => e.type).sort());
  });

  it.each(EVENTS.map((e) => e.type))("the %s sample validates against its schemas", (type) => {
    const sample = samples.get(type) as { type: string; data: unknown };
    expect(sample.type).toBe(type);
    const envelope = eventEnvelope.safeParse(sample);
    expect(envelope.success, JSON.stringify(envelope.error?.issues)).toBe(true);
    const data = EVENTS.find((e) => e.type === type)!.data.safeParse(sample.data);
    expect(data.success, JSON.stringify(data.error?.issues)).toBe(true);
  });

  it("has a curl example for every action and every resource", () => {
    for (const action of ACTIONS) expect(docs, action.name).toContain(`/actions/${action.name}`);
    for (const resource of RESOURCES) {
      expect(docs, resource.name).toContain(resource.path.replace("{id}", "$MEETING_ID").replace(/^\//, "$API/"));
    }
  });

  it("lists every scope, error code, retention window and webhook header", () => {
    for (const scope of SCOPE_DEFINITIONS) expect(docs, scope.name).toContain(scope.name);
    for (const code of Object.keys(DEFAULT_STATUS)) expect(docs, code).toContain(code);
    for (const header of ["X-CP-Event", "X-CP-Delivery", "X-CP-Timestamp", "X-CP-Signature", "Idempotency-Key", "X-RateLimit-Remaining", "Retry-After"]) {
      expect(docs, header).toContain(header);
    }
  });

  it("documents every CONNECTOR_* variable the code reads, and .env.example lists them", () => {
    const dir = path.join(root, "convex/connector");
    const used = new Set<string>();
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      // Environment variables are read as `process.env.X` or named in a quoted string (key ring, required list).
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      for (const match of source.matchAll(/(?:process\.env\.|["'])(CONNECTOR_[A-Z0-9_]+)/g)) {
        used.add(match[1]);
      }
    }
    // The key ring accepts _V2.._V9; the docs describe the pattern once.
    const names = [...used].filter((name) => !/^CONNECTOR_ENCRYPTION_KEY_V[3-9]$/.test(name));
    expect(names).toContain("CONNECTOR_ENABLED");
    for (const name of names) {
      expect(docs, name).toContain(name);
      if (!/_V\d$/.test(name)) expect(envExample, name).toContain(name);
    }
  });

  it("states the limits the implementation enforces", () => {
    for (const fact of ["120 requests/minute", "1 MiB", "60 per minute", "5 endpoints", "10 s, 30 s, 2 m, 10 m, 30 m, 1 h, 3 h, 6 h", "7 days", "10 minutes"]) {
      expect(docs, fact).toContain(fact);
    }
  });
});
