/**
 * Smoke test for a running Meetup connector (CP1). Plain Node, no dependencies:
 *
 *   node --experimental-strip-types scripts/connector-smoke.ts [run]
 *   node --experimental-strip-types scripts/connector-smoke.ts authorize
 *   node --experimental-strip-types scripts/connector-smoke.ts exchange <code>
 *   node --experimental-strip-types scripts/connector-smoke.ts receiver
 *
 * `run` needs CP1_BASE_URL and CP1_ACCESS_TOKEN; set CP1_WEBHOOK_URL to also
 * exercise webhook registration. See docs/CONNECTOR.md.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const env = (name: string, fallback = "") => process.env[name] ?? fallback;
const base = env("CP1_BASE_URL").replace(/\/+$/, "");
const api = `${base}/api/connect/v1`;
const stateFile = ".cp1-smoke.json";

function need(...names: string[]) {
  const missing = names.filter((name) => !env(name));
  if (missing.length > 0) {
    console.error(`Missing environment: ${missing.join(", ")}`);
    process.exit(2);
  }
}

const b64url = (buffer: Buffer) => buffer.toString("base64url");

// ── authorize / exchange: walk the OAuth flow from a terminal ────────────────

function authorize() {
  need("CP1_BASE_URL", "CP1_CLIENT_ID", "CP1_REDIRECT_URI");
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = crypto.randomBytes(8).toString("hex");
  const scope = env(
    "CP1_SCOPES",
    "meetup:orgs:read meetup:members:read meetup:meetings:read meetup:meetings:write meetup:transcripts:read meetup:summaries:read meetup:tasks:read meetup:tasks:write meetup:notifications:write meetup:webhooks:manage",
  );
  fs.writeFileSync(stateFile, JSON.stringify({ verifier, state }), { mode: 0o600 });

  const url = new URL(`${base}/connect/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: env("CP1_CLIENT_ID"),
    redirect_uri: env("CP1_REDIRECT_URI"),
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  console.log("Open this URL, sign in, pick an organization and click Allow:\n");
  console.log(url.toString());
  console.log(`\nThen run: ... connector-smoke.ts exchange <code from the redirect>   (verifier saved in ${stateFile})`);
}

async function exchange(code: string | undefined) {
  need("CP1_BASE_URL", "CP1_CLIENT_ID", "CP1_CLIENT_SECRET", "CP1_REDIRECT_URI");
  if (!code) {
    console.error("Usage: connector-smoke.ts exchange <code>");
    process.exit(2);
  }
  const { verifier } = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { verifier: string };
  const response = await fetch(`${api}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${encodeURIComponent(env("CP1_CLIENT_ID"))}:${encodeURIComponent(env("CP1_CLIENT_SECRET"))}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: env("CP1_REDIRECT_URI"),
      code_verifier: verifier,
    }).toString(),
  });
  const body = await response.json();
  console.log(JSON.stringify(body, null, 2));
  console.error(response.ok ? "\nStore these tokens like passwords. Use access_token as CP1_ACCESS_TOKEN." : "\nExchange failed.");
  process.exit(response.ok ? 0 : 1);
}

// ── receiver: a local webhook endpoint that verifies signatures ──────────────

function verify(secret: string, headers: http.IncomingHttpHeaders, rawBody: string) {
  const timestamp = Number(headers["x-cp-timestamp"]);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const expected = Buffer.from(
    `v1=${crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`,
  );
  const given = Buffer.from(String(headers["x-cp-signature"] ?? ""));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function receiver() {
  need("CP1_WEBHOOK_SECRET");
  const port = Number(env("CP1_RECEIVER_PORT", "4010"));
  const seen = new Set<string>();
  http
    .createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!verify(env("CP1_WEBHOOK_SECRET"), request.headers, raw)) {
          console.log("✗ rejected: bad signature or stale timestamp");
          response.writeHead(401).end();
          return;
        }
        const event = JSON.parse(raw) as { id: string; type: string; externalRef: unknown };
        const duplicate = seen.has(event.id);
        seen.add(event.id);
        console.log(`✓ ${event.type}  id=${event.id}${duplicate ? "  (duplicate — dedupe on id)" : ""}  externalRef=${JSON.stringify(event.externalRef)}`);
        response.writeHead(200).end("ok");
      });
    })
    .listen(port, () => console.log(`Listening for webhooks on http://localhost:${port}`));
}

// ── run: the smoke test ──────────────────────────────────────────────────────

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function run() {
  need("CP1_BASE_URL", "CP1_ACCESS_TOKEN");
  const token = env("CP1_ACCESS_TOKEN");
  const results: Array<[string, boolean, string]> = [];

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, json: (text ? JSON.parse(text) : {}) as Json };
  }

  async function check(name: string, work: () => Promise<string | void>) {
    try {
      const note = (await work()) ?? "";
      results.push([name, true, note]);
    } catch (error) {
      results.push([name, false, error instanceof Error ? error.message : String(error)]);
    }
  }

  const expectStatus = (actual: number, wanted: number, what: string) => {
    if (actual !== wanted) throw new Error(`${what}: expected HTTP ${wanted}, got ${actual}`);
  };

  let meetingId = "";
  let taskId = "";
  let webhookId = "";

  await check("health (no auth)", async () => {
    const response = await fetch(`${api}/health`);
    expectStatus(response.status, 200, "GET /health");
    const body = (await response.json()) as Json;
    if (body.status !== "ok") throw new Error("status is not ok");
    return `version ${body.version}`;
  });

  await check("manifest is cp1 and advertises this origin", async () => {
    const response = await fetch(`${base}/.well-known/ecosystem-connector.json`);
    expectStatus(response.status, 200, "GET /.well-known/ecosystem-connector.json");
    const manifest = (await response.json()) as Json;
    if (manifest.protocol !== "cp1" || manifest.service !== "meetup") throw new Error("not a cp1 meetup manifest");
    if (!String(manifest.auth.tokenUrl).startsWith(base)) throw new Error("tokenUrl is not on the app domain");
    return `${manifest.actions.length} actions, ${manifest.resources.length} resources, ${manifest.events.length} events`;
  });

  await check("openapi.json is 3.1", async () => {
    const response = await fetch(`${api}/openapi.json`);
    expectStatus(response.status, 200, "GET /openapi.json");
    if (((await response.json()) as Json).openapi !== "3.1.0") throw new Error("not OpenAPI 3.1");
  });

  await check("unauthenticated calls are rejected with the standard error", async () => {
    const response = await fetch(`${api}/me`);
    expectStatus(response.status, 401, "GET /me without a token");
    const body = (await response.json()) as Json;
    if (body.error?.code !== "unauthorized" || !body.error.requestId) throw new Error("malformed error body");
  });

  await check("/me", async () => {
    const res = await call("GET", "/me");
    expectStatus(res.status, 200, "GET /me");
    if (!res.headers.get("x-ratelimit-limit")) throw new Error("no X-RateLimit-Limit header");
    return `${res.json.user.email} @ ${res.json.tenant.name} (${res.json.plan.name})`;
  });

  await check("read: orgs, members, meetings, tasks, insights", async () => {
    for (const path of ["/orgs", "/members", "/meetings?limit=5", "/tasks?limit=5", "/insights?range=30d"]) {
      const res = await call("GET", path);
      if (res.status === 403) continue; // scope not granted — fine for a smoke test
      expectStatus(res.status, 200, `GET ${path}`);
    }
  });

  await check("meetings.create + Idempotency-Key replay", async () => {
    const key = crypto.randomUUID();
    const input = { title: `Smoke test ${new Date().toISOString()}`, purpose: "standup", externalRef: { hubRunId: "smoke" } };
    const first = await call("POST", "/actions/meetings.create", { input }, { "idempotency-key": key });
    expectStatus(first.status, 200, "meetings.create");
    meetingId = first.json.output.meeting.id;
    const replay = await call("POST", "/actions/meetings.create", { input }, { "idempotency-key": key });
    expectStatus(replay.status, 200, "meetings.create replay");
    if (replay.headers.get("idempotent-replay") !== "true") throw new Error("missing Idempotent-Replay header");
    if (replay.json.output.meeting.id !== meetingId) throw new Error("replay created a second meeting");
    const conflict = await call("POST", "/actions/meetings.create", { input: { ...input, title: "other" } }, { "idempotency-key": key });
    expectStatus(conflict.status, 422, "same key, different body");
    return first.json.output.meeting.webUrl;
  });

  await check("GET /meetings/{id}", async () => {
    const res = await call("GET", `/meetings/${meetingId}`);
    expectStatus(res.status, 200, "GET /meetings/{id}");
  });

  await check("tasks.create → tasks.update", async () => {
    const created = await call("POST", "/actions/tasks.create", { input: { title: "Smoke-test task", meetingId } });
    expectStatus(created.status, 200, "tasks.create");
    taskId = created.json.output.task.id;
    const updated = await call("POST", "/actions/tasks.update", { input: { taskId, status: "done" } });
    expectStatus(updated.status, 200, "tasks.update");
    if (updated.json.output.task.status !== "done") throw new Error("status did not change");
  });

  await check("events log contains what we just did", async () => {
    const res = await call("GET", "/events?limit=200");
    if (res.status === 403) return "skipped (no events scope)";
    expectStatus(res.status, 200, "GET /events");
    const types = (res.json.items as Json[]).map((event) => event.type);
    for (const wanted of ["meeting.started", "task.created", "task.completed"]) {
      if (!types.includes(wanted)) throw new Error(`no ${wanted} event`);
    }
  });

  if (env("CP1_WEBHOOK_URL")) {
    await check("webhooks: register → list → delete", async () => {
      const created = await call("POST", "/webhooks", { url: env("CP1_WEBHOOK_URL"), events: ["meeting.*", "task.*"] });
      expectStatus(created.status, 201, "POST /webhooks");
      webhookId = created.json.id;
      if (!String(created.json.secret).startsWith("whsec_")) throw new Error("no signing secret returned");
      const listed = await call("GET", "/webhooks");
      if (JSON.stringify(listed.json).includes(created.json.secret)) throw new Error("secret leaked in list");
      return `secret ${created.json.secret.slice(0, 10)}… (shown once)`;
    });
    await check("webhooks: private targets are refused (SSRF)", async () => {
      const res = await call("POST", "/webhooks", { url: "https://169.254.169.254/latest/meta-data/", events: ["meeting.*"] });
      expectStatus(res.status, 400, "metadata-address webhook");
    });
  }

  if (meetingId) {
    await check("meetings.end (host-only)", async () => {
      const res = await call("POST", "/actions/meetings.end", { input: { meetingId } });
      expectStatus(res.status, 200, "meetings.end");
    });
  }
  if (webhookId) {
    await check("webhooks: cleanup", async () => {
      expectStatus((await call("DELETE", `/webhooks/${webhookId}`)).status, 204, "DELETE /webhooks/{id}");
    });
  }

  console.log("");
  for (const [name, ok, note] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

const handlers: Record<string, () => void | Promise<void>> = {
  run,
  authorize,
  exchange: () => exchange(process.argv[3]),
  receiver,
};

const handler = handlers[process.argv[2] ?? "run"];
if (!handler) {
  console.error("Usage: connector-smoke.ts [run|authorize|exchange <code>|receiver]");
  process.exit(2);
}
await handler();
