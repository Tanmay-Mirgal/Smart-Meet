# Meetup ecosystem connector (CP1)

Meetup is the **"Discuss" stage** of the ecosystem: meetings produce the decisions and action
items that start workflows (brainstorm → design → ship). The connector is a first-class,
secure, documented API that lets a central **Hub** schedule and end meetings, read transcripts,
summaries, decisions and action items, create and update tasks, notify people inside Meetup, and
receive signed webhooks such as `meeting.summary.ready`.

It implements **Ecosystem Connector Protocol v1 (CP1)**. When it is switched off (the default)
Meetup behaves exactly as it did before.

- [How it works](#how-it-works)
- [Enabling it](#enabling-it) · [Authentication](#authentication) · [Conventions](#conventions) · [Scopes](#scopes)
- [Reading data](#reading-data) · [Doing things](#doing-things) · [Operations](#operations)
- [Webhooks](#webhooks) · [Event catalog](#event-catalog) · [Polling](#polling-fallback)
- [Security model](#security-model) · [Behaviour notes and limits](#behaviour-notes-and-limits)
- [Runbook](#runbook) · [Findings to act on](#findings-to-act-on) · [Testing](#testing)

All examples assume:

```bash
export BASE=https://meetup.example.com        # your Meetup origin
export API=$BASE/api/connect/v1
export TOKEN=cp1_meetup_...                   # an access token (see Authentication)
```

---

## How it works

```
 Hub ──HTTPS──▶ Next.js app  ──rewrite──▶  Convex httpActions  ──▶  same business rules as the UI
        /api/connect/v1/*      (proxy only)   convex/connector/*      (convex/*/…Core helpers)
        /.well-known/ecosystem-connector.json
```

- **The logic lives in Convex** (`convex/connector/`), where the data and the scheduler are.
  Next.js only proxies `/api/connect/v1/*` and the well-known document, so the Hub talks to the
  app domain. The rewrite keeps the method, body, `Authorization`, `Idempotency-Key` and the
  upstream status and headers (verified; see [Testing](#testing)).
- **No second copy of the rules.** Every public Convex function that mattered was split into a
  `…Core(ctx, actor, args)` helper. The browser calls it with the signed-in Clerk user as the
  `actor`; the connector calls the *same* helper with the user who consented. Plan limits, host-only
  rules, invitations, summaries and task de-duplication are therefore identical.
- **One source of truth for the contract.** `convex/connector/registry.ts` defines every action,
  resource and event once with zod. The manifest, the OpenAPI 3.1 document and runtime request
  validation are all generated from it.
- **Tenant = Clerk organization.** A grant is pinned to exactly one organization. The acting user is
  the person who consented, and their live membership is re-checked on every request.
- **Events use a transactional outbox.** The event row is written in the same transaction as the
  change; a scheduler worker delivers it afterwards. A rolled-back change emits nothing; a crash
  after commit cannot lose the event.

## Enabling it

Everything is off unless `CONNECTOR_ENABLED=true`. The connector code runs **inside Convex**, so
set every `CONNECTOR_*` value in the **Convex dashboard** (and `NEXT_PUBLIC_APP_URL`/`APP_BASE_URL`,
and `GROQ_API_KEY` for server-side summaries) as well as in the Next.js environment.

| Variable | Where | Purpose |
|---|---|---|
| `CONNECTOR_ENABLED` | Convex + Next | `true` switches everything on. Anything else = off. |
| `CONNECTOR_HUB_NAME` | Convex | Shown on the consent screen and in "Created via …" tags. |
| `CONNECTOR_HUB_CLIENT_ID` / `CONNECTOR_HUB_CLIENT_SECRET` | Convex | The pre-registered confidential OAuth client. |
| `CONNECTOR_HUB_REDIRECT_URIS` | Convex | Comma separated, **exact match**, `https` only. |
| `CONNECTOR_TOKEN_PEPPER` | Convex | ≥ 32 chars. Tokens are stored only as `HMAC-SHA256(pepper, token)`. Also keys media-link signatures. |
| `CONNECTOR_ENCRYPTION_KEY` | Convex | 64 hex chars. AES-256-GCM key for webhook secrets. Add `CONNECTOR_ENCRYPTION_KEY_V2` … to rotate. |
| `CONNECTOR_AUTO_SUMMARY` | Convex | `true` enables the server-side summary fallback. |
| `CONNECTOR_AUTO_SUMMARY_DELAY_MINUTES` | Convex | Default `10`. |
| `NEXT_PUBLIC_APP_URL` (or `APP_BASE_URL`) | Convex + Next | Public origin, used for every `webUrl` and in the manifest. |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | Next (build) | `https://<deployment>.convex.site`. The rewrite target. |
| `GROQ_API_KEY` | Convex (and Next) | Server-side `generateSummary` runs in Convex, so it needs the key there too. |
| `CONNECTOR_DEV_MODE` | Convex | **Local development only.** Allows `http://localhost` redirect URIs and loopback webhook targets. |
| `CONNECTOR_DOCS_URL` | Convex | Optional override for the docs link in the manifest. |

If `CONNECTOR_ENABLED=true` but a required value is missing or malformed, `health` and `manifest`
answer `500 internal` naming the **variables** (never values) that need fixing.

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # CONNECTOR_TOKEN_PEPPER
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"         # CONNECTOR_ENCRYPTION_KEY
```

### Discovery

```bash
curl $BASE/.well-known/ecosystem-connector.json     # identical to $API/manifest; cacheable for 5 minutes
curl $API/health                                    # {"status":"ok","version":"1.0.0","time":"…"}
curl $API/openapi.json                              # OpenAPI 3.1, generated from the same registry
```

## Authentication

OAuth 2.0 **Authorization Code + PKCE (S256, mandatory)**. The Hub is one pre-registered
confidential client. Access tokens last **1 hour**; refresh tokens **90 days** and **rotate** on
every use.

```bash
# 1. PKCE pair
VERIFIER=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
CHALLENGE=$(printf %s "$VERIFIER" | openssl dgst -sha256 -binary | basenc --base64url -w0 | tr -d '=')

# 2. Send the user to the consent screen (they sign in with Meetup's normal login and pick an organization)
echo "$BASE/connect/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=$REDIRECT&scope=meetup:meetings:read%20meetup:tasks:write&state=$(openssl rand -hex 8)&code_challenge=$CHALLENGE&code_challenge_method=S256"
#    → redirected back to $REDIRECT?code=…&state=…   (code: single use, valid 60 s)

# 3. Exchange the code (client auth by HTTP Basic or body; form-encoded or JSON)
curl -s $API/oauth/token -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=authorization_code -d code="$CODE" -d redirect_uri="$REDIRECT" -d code_verifier="$VERIFIER"
```

```json
{
  "token_type": "Bearer",
  "access_token": "cp1_meetup_…",
  "expires_in": 3600,
  "refresh_token": "cp1r_meetup_…",
  "scope": "meetup:meetings:read meetup:tasks:write",
  "tenant": { "id": "org_2abc", "name": "Acme", "kind": "organization" },
  "user": { "id": "k57…", "email": "ada@example.com", "name": "Ada Lovelace" }
}
```

```bash
# Refresh — returns a NEW refresh token and invalidates the old one
curl -s $API/oauth/token -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=refresh_token -d refresh_token="$REFRESH"

# Revoke (always 200, RFC 7009)
curl -s $API/oauth/revoke -u "$CLIENT_ID:$CLIENT_SECRET" -d token="$TOKEN"
```

Rules worth knowing:

- Authorize validates `client_id`, **exact** `redirect_uri`, `S256` PKCE, `state` and scopes. For an unknown
  client or unregistered redirect it shows an error page and **never redirects**; other errors redirect back
  with `error` and `state` (RFC 6749 §4.1.2.1).
- A code is **single use**. Presenting it twice revokes the tokens issued from it. A wrong `code_verifier`
  fails and also burns the code.
- Re-using an **already-rotated refresh token** is treated as theft: the whole grant is revoked.
- Token-endpoint errors use the RFC 6749 shape (`{"error":"invalid_grant","error_description":"…"}`);
  every other endpoint uses the CP1 error shape below.
- Users can revoke any time in **Integrations → Connected apps**, which also shows scopes, last use,
  webhook health and the last 20 calls. Revoking disables the grant's webhooks immediately.
- A connector token can never mint tokens, grants or keys: only the signed-in user can approve a grant.

## Conventions

- JSON in and out (`application/json; charset=utf-8`). IDs are strings; timestamps are ISO-8601 UTC.
- Every entity has `id` and `webUrl` (a deep link into Meetup) and, where relevant, `createdAt`, `updatedAt`,
  `metadata` (object ≤ 2 KB) and `externalRef`.
- **Errors** — always this shape, never HTML:
  ```json
  { "error": { "code": "validation_failed", "message": "Request validation failed",
               "details": [{ "path": "input.title", "message": "Invalid input: expected string, received undefined" }],
               "retryable": false, "requestId": "req_8f2c…" } }
  ```

  | Code | HTTP | Notes |
  |---|---|---|
  | `unauthorized` | 401 | missing, malformed, expired or revoked token |
  | `insufficient_scope` | 403 | includes `requiredScope` |
  | `forbidden` | 403 | the connected *user* may not do this (e.g. not the meeting host) |
  | `not_found` | 404 | also returned for ids in **another organization** — never 403 |
  | `validation_failed` | 400 / 413 / 405 | `details[]` names the fields; 413 over 1 MiB; 405 wrong method |
  | `conflict` | 409 | e.g. a 6th webhook endpoint |
  | `idempotency_conflict` | 422 | same `Idempotency-Key`, different body |
  | `plan_limit` | 402 | includes `limit` and/or `feature` |
  | `precondition_failed` | 412 | includes `fixUrl` when the user can fix it in Meetup |
  | `rate_limited` | 429 | with `Retry-After` |
  | `upstream_failed` / `unavailable` / `internal` | 502 / 503 / 500 | |

  `retryable` is `true` only for 429 and 5xx.
- **Request ids** — send `X-Request-Id` or one is generated; it is echoed in the response and in `error.requestId`.
- **Pagination** — `?limit=` (default 50, max 200) and `?cursor=`; responses are `{ "items": […], "nextCursor": "…"|null }`.
  Cursors are opaque keyset positions: concurrent inserts never cause a skipped or repeated item.
- **Idempotency** — every `POST` action (and `POST /webhooks`) accepts `Idempotency-Key` (≤ 128 chars).
  Same key + same body replays the stored response (header `Idempotent-Replay: true`); same key + different body is
  `422 idempotency_conflict`. Records live 24 hours and are scoped to the grant. Only successful responses are stored.
- **Rate limits** — 120 requests/minute per grant, shared across instances. Every response carries
  `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (unix seconds); over the limit → `429` + `Retry-After`.
- **Unknown fields** are rejected (`400`) unless you send `Prefer: unknown-fields=ignore`. Additive *response* changes are
  non-breaking: ignore fields you do not know.
- **No CORS headers** on `/api/connect/v1/*` — server-to-server only.

## Scopes

| Scope | Allows |
|---|---|
| `meetup:orgs:read` | the connected organization's name |
| `meetup:members:read` | members' name and email (for assignee mapping) |
| `meetup:meetings:read` | meetings, participants, settings, whiteboards, insights |
| `meetup:meetings:write` | create, invite to and end meetings |
| `meetup:transcripts:read` | transcripts (the most sensitive data — separate on purpose) |
| `meetup:summaries:read` | summaries, decisions, action items |
| `meetup:recordings:read` | recording status and short-lived playback links |
| `meetup:tasks:read` / `meetup:tasks:write` | read / create and update tasks |
| `meetup:notifications:write` | in-app notifications to organization members |
| `meetup:events:read` | the polling event log |
| `meetup:webhooks:manage` | webhook endpoints (**grants `events:read` with it**) |

A token can never do more than the consenting user could do in Meetup, and never touches another organization.

## Reading data

All `GET`. Add `?limit=` / `?cursor=` to lists.

```bash
curl -H "Authorization: Bearer $TOKEN" $API/me           # user, tenant, scopes, plan{name,limits,usage}, capabilities
curl -H "Authorization: Bearer $TOKEN" $API/orgs         # meetup:orgs:read
curl -H "Authorization: Bearer $TOKEN" "$API/members"    # meetup:members:read — {id,name,email,imageUrl}
curl -H "Authorization: Bearer $TOKEN" "$API/meetings?status=ended&purpose=design-review&from=2026-03-01T00:00:00Z"
curl -H "Authorization: Bearer $TOKEN" $API/meetings/$MEETING_ID                    # settings, host, counts, calendar, recording flags
curl -H "Authorization: Bearer $TOKEN" $API/meetings/$MEETING_ID/participants
curl -H "Authorization: Bearer $TOKEN" "$API/meetings/$MEETING_ID/transcript?limit=100"   # meetup:transcripts:read
curl -H "Authorization: Bearer $TOKEN" $API/meetings/$MEETING_ID/summary                  # 404 until one exists
curl -H "Authorization: Bearer $TOKEN" $API/meetings/$MEETING_ID/recordings               # signed playback links
curl -H "Authorization: Bearer $TOKEN" $API/meetings/$MEETING_ID/whiteboard               # Excalidraw scene (size-capped)
curl -H "Authorization: Bearer $TOKEN" "$API/tasks?status=open&meetingId=$MEETING_ID&assigneeEmail=ada@example.com"
curl -H "Authorization: Bearer $TOKEN" "$API/insights?range=30d"                          # 7d | 30d | 90d | all
```

- `GET /me` → `capabilities: { aiSummary, recording, notionExport, googleCalendarSync, meetingsUsed, meetingsCap }`.
- Meeting `purpose` is free text; the convention is `brainstorm | design-review | standup | retro | planning | incident`,
  so the Hub can filter triggers. `meetings` filters `from`/`to` apply to the creation time.
- **Recordings** carry `playbackUrl` only for `ready` recordings: an HMAC-signed link on the app domain that expires in
  **10 minutes** and 302-redirects to storage. It is re-checked against the live grant when used, so revoking the connection
  kills links that have not expired. See [limits](#behaviour-notes-and-limits).
- The whiteboard scene is withheld (`scene: null, truncated: true`) above 800 kB. Insights are bounded
  (500 meetings, 1000 tasks per status).
- Nothing from `user_integrations` / `notion_integrations` (Google/Notion tokens) and no WebRTC `signals` is ever returned.

## Doing things

`POST $API/actions/{name}` with body `{ "input": { … } }`. Synchronous actions answer `200 { "output": … }`;
asynchronous ones answer `202 { "operation": { "id", "status", "pollUrl" } }`. All accept `Idempotency-Key`,
and every call is audited as `via: connector` (client id, grant id, action, request id — no payloads).

```bash
# meetings.create — scope meetup:meetings:write. Instant when scheduledFor is omitted.
curl -s $API/actions/meetings.create -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" -d '{
    "input": {
      "title": "Design review: onboarding",
      "purpose": "design-review",
      "scheduledFor": "2026-03-05T09:30:00Z", "scheduledEndsAt": "2026-03-05T10:00:00Z", "scheduledTimeZone": "Asia/Kolkata",
      "inviteEmails": ["ada@example.com"],
      "settings": { "joinMode": "invite_only" },
      "externalRef": { "hubProjectId": "prj_123", "hubRunId": "run_9", "hubStepId": "step_2" },
      "metadata": { "source": "hub" }
    } }'
# → 200 { "output": { "meeting": { "id", "title", "status", "scheduledFor", "joinUrl", "webUrl" } } }

# meetings.end — host-only, exactly as in the UI (403 forbidden otherwise). Ending twice is a no-op.
curl -s $API/actions/meetings.end    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"input":{"meetingId":"'$MEETING_ID'"}}'

# meetings.invite — the connected user must be a host/co-host AND present in the meeting (same rule as the UI).
curl -s $API/actions/meetings.invite -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"input":{"meetingId":"'$MEETING_ID'","emails":["grace@example.com"],"role":"participant"}}'

# meetings.generateSummary — ASYNC, scopes meetup:summaries:read + meetup:meetings:write
curl -s $API/actions/meetings.generateSummary -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"input":{"meetingId":"'$MEETING_ID'","force":false,"language":"en"}}'
# → 202 { "operation": { "id": "…", "status": "pending", "pollUrl": "…/operations/…" } }

# tasks.create — scope meetup:tasks:write. Unknown assigneeEmail ⇒ created unassigned with suggestedAssigneeName.
curl -s $API/actions/tasks.create -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"input":{"title":"Ship the onboarding redesign","meetingId":"'$MEETING_ID'","assigneeEmail":"ada@example.com","dueAt":"2026-03-12T17:00:00Z"}}'

# tasks.createFromSummary — de-duplicates titles (case-insensitive) against the meeting's existing tasks
curl -s $API/actions/tasks.createFromSummary -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"input":{"meetingId":"'$MEETING_ID'","actionItems":[{"title":"Write the launch email","assigneeName":"Grace"}]}}'
# → { "output": { "tasks": […], "skippedDuplicates": 0 } }

# tasks.update — emits task.updated (coalesced) and task.completed. null clears assignee/dueAt.
curl -s $API/actions/tasks.update -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"input":{"taskId":"'$TASK_ID'","status":"done"}}'

# notifications.create — appears in the recipient's bell. 60 per minute per connection. Recipient must be an org member.
curl -s $API/actions/notifications.create -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"input":{"userEmail":"ada@example.com","title":"Deployment is live","message":"Your deployment to production finished.","link":"https://orb.example.com/deploys/42"}}'
```

Notes:

- Creating actions persist `externalRef` and `metadata` and the record is tagged **"Created via <Hub>"** in the Meetup UI.
- `meetings.create` uses the same core as the UI: plan meeting cap (`402 plan_limit` with `limit`), invitations (emails go out as
  today), and Google Calendar sync only if **the connected user** linked Google (`412 precondition_failed` with `fixUrl` otherwise).
- `notifications.create` `link` must be an `https` URL or an in-app path (`/…`); `javascript:`, `//host`, `http:` etc. are `400`.
- An action that fails rolls back completely; nothing half-done is committed and nothing is stored for idempotency.

## Operations

```bash
curl -H "Authorization: Bearer $TOKEN" $API/operations/$OPERATION_ID
```

```json
{ "id": "…", "action": "meetings.generateSummary", "status": "succeeded",
  "output": { "meetingId": "…", "status": "generated", "version": 1, "summary": "…", "actionItemCount": 2, "tasksCreated": 2, "webUrl": "…" },
  "createdAt": "2026-03-02T09:31:00.000Z", "finishedAt": "2026-03-02T09:31:07.000Z" }
```

`status` is `pending → running → succeeded | failed` (`error: { code, message }` on failure, e.g. `upstream_failed`). Operations
belong to the grant that started them, need the same scopes as the action, and are kept for **7 days**.

`meetings.generateSummary` summarizes **on the server** — no browser tab required. It uses the *same* prompt, model and JSON repair
as the in-app summarizer (`lib/summarizer.ts`) and saves through the same core as `meetings.saveSummary`, then turns action items
into tasks (de-duplicated). Short meetings take exactly the browser's one-call path; transcripts over 500 lines are summarized in
parts of 400 lines (stored in `summary_chunks`) and merged. If a summary already exists and `force` is false it is returned
(`output.status = "existing"`). It needs the organization's `aiSummary` plan feature (`402 plan_limit`, reported immediately) and
at least one transcript segment (`412`). `summaryVersion` increases only when the saved content actually changes.

## Webhooks

```bash
# Register (scope meetup:webhooks:manage). The secret is returned ONCE.
curl -s $API/webhooks -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://hub.example.com/hooks/meetup","events":["meeting.*","task.completed"],"description":"Hub"}'
# → 201 { "id", "url", "events", "status": "active", "secret": "whsec_…", … }

curl -H "Authorization: Bearer $TOKEN" $API/webhooks                      # list (never includes secrets)
curl -H "Authorization: Bearer $TOKEN" $API/webhooks/$WEBHOOK_ID          # one, incl. status / disabledReason / failures
curl -X PATCH $API/webhooks/$WEBHOOK_ID -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"status":"active"}'   # re-enable
curl -X DELETE -H "Authorization: Bearer $TOKEN" $API/webhooks/$WEBHOOK_ID
curl -H "Authorization: Bearer $TOKEN" "$API/webhooks/$WEBHOOK_ID/deliveries?limit=20"    # status, attempts, last code, truncated body
curl -X POST -H "Authorization: Bearer $TOKEN" $API/webhooks/$WEBHOOK_ID/deliveries/$DELIVERY_ID/redeliver   # manual replay (new delivery id)
```

Subscriptions accept exact types and `prefix.*`. At most **5 endpoints per grant**. Endpoints belong to the grant that created them.
You can only subscribe to events your scopes could read.

**Target rules (SSRF protection).** `https` only; no credentials in the URL; no internal host names; and the host's DNS must resolve
only to public addresses. Loopback, link-local (including `169.254.169.254`), RFC 1918, RFC 4193, carrier-grade NAT, documentation and
multicast ranges — including IPv4 hidden in IPv6 (`::ffff:127.0.0.1`, NAT64, 6to4) — are rejected. The check is repeated **at delivery
time**, the address is validated again **at connect time** (so DNS rebinding cannot help), redirects are never followed, and the timeouts
are 5 s connect / 10 s total.

### Delivery

`POST` to your URL with the raw JSON body (the [envelope](#event-catalog)) and these headers:

| Header | Meaning |
|---|---|
| `X-CP-Event` | the event type |
| `X-CP-Delivery` | UUID, unique per delivery, **stable across retries** |
| `X-CP-Timestamp` | unix seconds when this attempt was signed |
| `X-CP-Signature` | `v1=` + hex `HMAC-SHA256(secret, "<timestamp>.<rawBody>")` |
| `User-Agent` | `Meetup-Connector/1.0` |

Verify with the **raw** body, in constant time, and reject stale timestamps:

```js
import crypto from "node:crypto";

export function verify(secret, headers, rawBody, toleranceSeconds = 300) {
  const timestamp = Number(headers["x-cp-timestamp"]);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = "v1=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const given = Buffer.from(headers["x-cp-signature"] ?? "");
  const want = Buffer.from(expected);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}
```

Semantics:

- **At-least-once.** Dedupe on the envelope `id`. Order is not guaranteed; use `occurredAt`.
- **Success** = any `2xx` within 10 s.
- **Retries:** after the first attempt, retry after **10 s, 30 s, 2 m, 10 m, 30 m, 1 h, 3 h, 6 h** (8 retries, ≈ 10 h 43 m), each with ±20 % jitter.
- **`410 Gone`** disables the endpoint immediately (`disabledReason: "endpoint_gone"`).
- **50 consecutive failed deliveries** (each having exhausted all retries) or **3 days** of failures disable it
  (`too_many_failures` / `failing_for_3_days`). Visible in `GET /webhooks/{id}` and in Connected apps. A success resets the counters;
  `PATCH {"status":"active"}` re-enables.
- Events are filtered **before** a delivery is queued: subscription match, same organization, and the grant's scopes must allow
  *reading* the entity.
- `task.updated` is **coalesced**: updates to one task within 5 s that have not been delivered yet are merged into the latest state.
- Never inline: delivery runs from the scheduler, not in the request that caused the change. A sweep every 2 minutes re-queues
  anything whose scheduled run was lost.

## Event catalog

Envelope (the body, exactly this shape):

```json
{ "id": "evt_01J…", "type": "meeting.started", "apiVersion": "cp1", "service": "meetup",
  "occurredAt": "2026-03-02T09:30:00.000Z", "tenantId": "org_2abc",
  "actor": { "id": "…", "name": "…", "kind": "user|system|connector" },
  "externalRef": { "hubProjectId": "…", "hubRunId": "…", "hubStepId": "…" },
  "data": { } }
```

`externalRef` is always present (empty `{}` when the entity carries no correlation ids). It echoes what the creating action set, on
the entity's events **and** its children's (a task inherits its meeting's, overridden key-by-key by its own). `actor.kind` is `connector`
for changes made through this API, `user` for changes made in Meetup, `system` for scheduled jobs.

Each sample below is **validated against the live schemas by the test suite** (`tests/unit/connector-docs.test.ts`).

### meeting.scheduled

```json
{
  "id": "evt_01JZ4K8M2Q7T5N3B6C9D0F1G2H", "type": "meeting.scheduled", "apiVersion": "cp1", "service": "meetup",
  "occurredAt": "2026-03-02T09:00:00.000Z", "tenantId": "org_2abc",
  "actor": { "id": "k57a1", "name": "Ada Lovelace", "kind": "connector" },
  "externalRef": { "hubProjectId": "prj_123", "hubRunId": "run_9", "hubStepId": "step_2" },
  "data": {
    "meeting": { "id": "k17f3a9b2c4d5e6f", "title": "Design review", "purpose": "design-review", "status": "scheduled",
                 "scheduledFor": "2026-03-05T09:30:00.000Z", "webUrl": "https://meetup.example.com/meeting/k17f3a9b2c4d5e6f/details" },
    "host": { "id": "k57a1", "name": "Ada Lovelace" },
    "participantCount": 0
  }
}
```

### meeting.started

Emitted when an instant meeting is created, or when a scheduled meeting first goes live (first join).

```json
{
  "id": "evt_01JZ4K8M2Q7T5N3B6C9D0F1G2J", "type": "meeting.started", "apiVersion": "cp1", "service": "meetup",
  "occurredAt": "2026-03-02T09:30:00.000Z", "tenantId": "org_2abc",
  "actor": { "id": "k57a1", "name": "Ada Lovelace", "kind": "user" },
  "externalRef": {},
  "data": {
    "meeting": { "id": "k17f3a9b2c4d5e6f", "title": "Design review", "purpose": "design-review", "status": "active",
                 "startedAt": "2026-03-02T09:30:00.000Z", "webUrl": "https://meetup.example.com/meeting/k17f3a9b2c4d5e6f/details" },
    "host": { "id": "k57a1", "name": "Ada Lovelace" },
    "participantCount": 1
  }
}
```

### meeting.ended

```json
{
  "id": "evt_01JZ4K8M2Q7T5N3B6C9D0F1G2K", "type": "meeting.ended", "apiVersion": "cp1", "service": "meetup",
  "occurredAt": "2026-03-02T10:02:00.000Z", "tenantId": "org_2abc",
  "actor": { "id": "k57a1", "name": "Ada Lovelace", "kind": "connector" },
  "externalRef": { "hubRunId": "run_9" },
  "data": {
    "meeting": { "id": "k17f3a9b2c4d5e6f", "title": "Design review", "purpose": "design-review", "status": "ended",
                 "startedAt": "2026-03-02T09:30:00.000Z", "endedAt": "2026-03-02T10:02:00.000Z",
                 "webUrl": "https://meetup.example.com/meeting/k17f3a9b2c4d5e6f/details" },
    "host": { "id": "k57a1", "name": "Ada Lovelace" },
    "participantCount": 4
  }
}
```

### meeting.summary.ready

**The Hub's primary trigger.** Emitted exactly once per summary *version*, from the shared save path, so it covers summaries saved in
the browser, generated through `meetings.generateSummary`, and generated by the server-side fallback. Re-emitted only when a *different*
summary is saved (e.g. regenerated with `force`).

```json
{
  "id": "evt_01JZ4K8M2Q7T5N3B6C9D0F1G2M", "type": "meeting.summary.ready", "apiVersion": "cp1", "service": "meetup",
  "occurredAt": "2026-03-02T10:05:00.000Z", "tenantId": "org_2abc",
  "actor": { "id": "k57a1", "name": "Ada Lovelace", "kind": "connector" },
  "externalRef": { "hubProjectId": "prj_123", "hubRunId": "run_9" },
  "data": {
    "meeting": { "id": "k17f3a9b2c4d5e6f", "title": "Design review", "purpose": "design-review", "status": "ended",
                 "startedAt": "2026-03-02T09:30:00.000Z", "endedAt": "2026-03-02T10:02:00.000Z",
                 "webUrl": "https://meetup.example.com/meeting/k17f3a9b2c4d5e6f/details",
                 "host": { "id": "k57a1", "name": "Ada Lovelace", "email": "ada@example.com" } },
    "version": 1,
    "summary": "## Overview\nWe agreed to ship the onboarding redesign on Friday.",
    "keyPoints": ["Ship on Friday", "Keep the three-step flow"],
    "decisions": ["Use the new checklist component"],
    "actionItems": [ { "task": "Write the launch email", "assignee": "Grace Hopper", "due": null } ],
    "participants": [ { "name": "Ada Lovelace", "email": "ada@example.com" }, { "name": "Grace Hopper", "email": "grace@example.com" } ],
    "language": "en"
  }
}
```

### meeting.transcript.ready

Emitted **once**, debounced: at the later of `endedAt + 60 s` and the last write to the meeting `+ 60 s`. Not emitted for a meeting with no transcript.

```json
{
  "id": "evt_01JZ4K8M2Q7T5N3B6C9D0F1G2N", "type": "meeting.transcript.ready", "apiVersion": "cp1", "service": "meetup",
  "occurredAt": "2026-03-02T10:03:00.000Z", "tenantId": "org_2abc",
  "actor": { "id": "system", "name": "Meetup", "kind": "system" },
  "externalRef": {},
  "data": {
    "meeting": { "id": "k17f3a9b2c4d5e6f", "title": "Design review", "purpose": "design-review", "status": "ended",
                 "endedAt": "2026-03-02T10:02:00.000Z", "webUrl": "https://meetup.example.com/meeting/k17f3a9b2c4d5e6f/details" },
    "segments": 214,
    "durationMs": 1920000
  }
}
```

### recording.ready

```json
{
  "id": "evt_01JZ4K8M2Q7T5N3B6C9D0F1G2P", "type": "recording.ready", "apiVersion": "cp1", "service": "meetup",
  "occurredAt": "2026-03-02T10:04:00.000Z", "tenantId": "org_2abc",
  "actor": { "id": "k57a1", "name": "Ada Lovelace", "kind": "user" },
  "externalRef": {},
  "data": {
    "meeting": { "id": "k17f3a9b2c4d5e6f", "title": "Design review", "purpose": "design-review", "status": "ended",
                 "webUrl": "https://meetup.example.com/meeting/k17f3a9b2c4d5e6f/details" },
    "recording": { "id": "k97c2d1e0f9a8b7c", "durationMs": 1920000, "mimeType": "video/webm" }
  }
}
```

### recording.failed

```json
{
  "id": "evt_01JZ4K8M2Q7T5N3B6C9D0F1G2Q", "type": "recording.failed", "apiVersion": "cp1", "service": "meetup",
  "occurredAt": "2026-03-02T10:04:30.000Z", "tenantId": "org_2abc",
  "actor": { "id": "k57a1", "name": "Ada Lovelace", "kind": "user" },
  "externalRef": {},
  "data": {
    "meeting": { "id": "k17f3a9b2c4d5e6f", "title": "Design review", "purpose": "design-review", "status": "ended",
                 "webUrl": "https://meetup.example.com/meeting/k17f3a9b2c4d5e6f/details" },
    "recording": { "id": "k97c2d1e0f9a8b7d" }
  }
}
```

### task.created

```json
{
  "id": "evt_01JZ4K8M2Q7T5N3B6C9D0F1G2R", "type": "task.created", "apiVersion": "cp1", "service": "meetup",
  "occurredAt": "2026-03-02T10:06:00.000Z", "tenantId": "org_2abc",
  "actor": { "id": "k57a1", "name": "Ada Lovelace", "kind": "connector" },
  "externalRef": { "hubProjectId": "prj_123", "hubRunId": "run_9" },
  "data": {
    "task": { "id": "k47t1a2s3k4", "title": "Write the launch email", "status": "open",
              "assignee": { "id": "k57b2", "name": "Grace Hopper" }, "dueAt": "2026-03-12T17:00:00.000Z",
              "meetingId": "k17f3a9b2c4d5e6f", "source": "summary", "webUrl": "https://meetup.example.com/tasks",
              "createdVia": "connector", "externalRef": { "hubRunId": "run_9" },
              "createdAt": "2026-03-02T10:06:00.000Z", "updatedAt": "2026-03-02T10:06:00.000Z" },
    "meetingId": "k17f3a9b2c4d5e6f"
  }
}
```

### task.updated

```json
{
  "id": "evt_01JZ4K8M2Q7T5N3B6C9D0F1G2S", "type": "task.updated", "apiVersion": "cp1", "service": "meetup",
  "occurredAt": "2026-03-02T11:00:00.000Z", "tenantId": "org_2abc",
  "actor": { "id": "k57b2", "name": "Grace Hopper", "kind": "user" },
  "externalRef": { "hubProjectId": "prj_123", "hubRunId": "run_9" },
  "data": {
    "task": { "id": "k47t1a2s3k4", "title": "Write the launch email", "status": "in_progress",
              "assignee": { "id": "k57b2", "name": "Grace Hopper" }, "meetingId": "k17f3a9b2c4d5e6f", "source": "summary",
              "webUrl": "https://meetup.example.com/tasks",
              "createdAt": "2026-03-02T10:06:00.000Z", "updatedAt": "2026-03-02T11:00:00.000Z" },
    "meetingId": "k17f3a9b2c4d5e6f"
  }
}
```

### task.completed

```json
{
  "id": "evt_01JZ4K8M2Q7T5N3B6C9D0F1G2T", "type": "task.completed", "apiVersion": "cp1", "service": "meetup",
  "occurredAt": "2026-03-02T15:00:00.000Z", "tenantId": "org_2abc",
  "actor": { "id": "k57b2", "name": "Grace Hopper", "kind": "user" },
  "externalRef": { "hubProjectId": "prj_123", "hubRunId": "run_9" },
  "data": {
    "task": { "id": "k47t1a2s3k4", "title": "Write the launch email", "status": "done",
              "assignee": { "id": "k57b2", "name": "Grace Hopper" }, "meetingId": "k17f3a9b2c4d5e6f", "source": "summary",
              "completedAt": "2026-03-02T15:00:00.000Z", "webUrl": "https://meetup.example.com/tasks",
              "createdAt": "2026-03-02T10:06:00.000Z", "updatedAt": "2026-03-02T15:00:00.000Z" },
    "meetingId": "k17f3a9b2c4d5e6f"
  }
}
```

### invite.accepted

```json
{
  "id": "evt_01JZ4K8M2Q7T5N3B6C9D0F1G2V", "type": "invite.accepted", "apiVersion": "cp1", "service": "meetup",
  "occurredAt": "2026-03-02T09:31:00.000Z", "tenantId": "org_2abc",
  "actor": { "id": "k57b2", "name": "Grace Hopper", "kind": "user" },
  "externalRef": {},
  "data": {
    "meeting": { "id": "k17f3a9b2c4d5e6f", "title": "Design review", "purpose": "design-review", "status": "active",
                 "webUrl": "https://meetup.example.com/meeting/k17f3a9b2c4d5e6f/details" },
    "email": "grace@example.com"
  }
}
```

## Polling fallback

`GET /events?cursor=&types=&limit=` (scope `meetup:events:read`, granted together with `webhooks:manage`) returns the organization's event log
in commit order, retained **7 days**. It serves the **same envelopes and applies the same scope filter** as webhooks, so it can heal anything
a webhook missed.

```bash
curl -H "Authorization: Bearer $TOKEN" "$API/events?types=meeting.*,task.completed&limit=100"
# → { "items": [ …envelopes… ], "nextCursor": "…" | null, "latestCursor": "…" }
```

Store `latestCursor` (an additive field): pass it as `?cursor=` later to get only newer events, even if the last page was empty. The cursor is a
gap-free per-organization sequence number, so a poller can never skip an event.

## Security model

- **Tenant isolation is in the data-access layer.** Ids resolve through `normalizeId` plus an organization check; another organization's id,
  a malformed id and a deleted id are the same `404`. Tests cover two organizations in both directions across reads, actions and webhooks.
- **Live authorization.** Every request re-reads the grant and re-checks the user's *current* organization membership and (via the shared cores)
  meeting-level rights. Losing membership cuts the token off on the very next call.
- **Tokens** are opaque (`prefix` + 32 random bytes) and stored only as `HMAC-SHA256(CONNECTOR_TOKEN_PEPPER, token)`; lookups are by hash and
  every secret/signature comparison is constant-time. Tokens are never logged. Refresh tokens rotate; reuse revokes the grant.
- **Secrets at rest.** Webhook signing secrets are encrypted with AES-256-GCM under a versioned key (`enc:v1:…`); the plaintext is shown once.
  Idempotent replays of webhook creation are stored encrypted too.
- **Never exposed:** Google/Notion access and refresh tokens, WebRTC signals, token hashes, encrypted secrets. A test scans every endpoint's
  responses for them (C21).
- **SSRF** — see [Webhooks](#webhooks). **Audit** — every call is logged `via: connector` with client id, grant id, action and request id (90 days).
- **Anti-clickjacking headers stay on every route** (the connector adds no embed routes). The consent page is Clerk-protected and returns 404 when
  the connector is off.
- **Feature flag:** with `CONNECTOR_ENABLED` unset, every `/connect/v1/*` route is a JSON 404, the Next.js rewrites do not exist, the consent page
  404s, the "Connected apps" section is not rendered, and the outbox helper returns after a single env check (no reads, no writes, nothing scheduled).

## Behaviour notes and limits

Deliberate choices, and things that differ from what you might assume:

1. **No role data in Convex.** Meetup stores organization *membership*, not Clerk roles, so the consent screen lists every organization the user belongs
   to, and "the user's role caps the scopes" is implemented as membership + meeting-level rights (host/co-host/joined). An organization-admin-only
   connection policy would need Clerk role data to be synced first.
2. **`meetings.invite` needs the host present.** The UI only lets a host/co-host who has *joined* the meeting invite people, and the connector does not
   bypass that. A meeting created through the API has its host row in the "left" state until the host joins in the UI, so invite people with
   `inviteEmails` on `meetings.create`, or after the host has joined.
3. **Recording links are short-lived, the storage URL is not.** The link handed to the Hub expires in 10 minutes and dies on revocation, but it
   302-redirects to the Convex storage URL, which this code does not time-limit. Streaming the bytes through the API would avoid that but is bounded by
   the HTTP-action response size limit.
4. **Concurrent duplicates.** Two simultaneous requests with one `Idempotency-Key` are serialized by the database (optimistic concurrency), so the second
   one is answered with the first one's response (a replay) rather than `409`.
5. **"50 consecutive failed deliveries"** counts deliveries that exhausted every retry. The 3-day rule measures from the first failure after the last success.
6. **Webhook retries:** the first attempt plus 8 retries (9 attempts), i.e. the listed 8 delays.
7. **`GET /events` adds `latestCursor`** (additive, ignorable).
8. **Browser summarization has no chunking.** The in-app flow sends the first 500 lines of one request; `summary_chunks` exists but nothing in the UI
   used it. Server-side chunking only reuses that table's shape.
9. **`insights` and `meetings?purpose=`** are bounded (see above); a very selective filter on a huge organization can return a short page with a
   non-null `nextCursor`. Keep following the cursor.
10. **Not implemented (all optional in CP1 v1):** the connector API key fallback (§2.5), embed sessions (§8), and `exports.notion`. The
    org-admin "allow Hub to access this organization" toggle was left out because per-grant revocation already gives that control and Meetup has no
    admin-role data (see 1).
11. **`CONNECTOR_DEV_MODE`** is an addition to the specified variables, for local development only.
12. **`meeting.ended` has a single source.** Meetup has no idle auto-end path (the last participant leaving only transfers the host role), so the event is
    emitted from ending the meeting (UI or `meetings.end`) and nowhere else. If an idle auto-end is added later, route it through `endMeetingCore`
    and the event and the transcript/summary follow-ups come with it.
13. **Meeting `started` for scheduled meetings** follows Meetup's existing rule: a scheduled meeting becomes `active` on the first non-denied join after
    its start time, which is where `meeting.started` is emitted.

## Runbook

### Production enablement (in this order)

1. **Pick values** for the secrets above; register the Hub's redirect URI(s) (exact match, https).
2. **Convex dashboard → Environment variables:** set `CONNECTOR_ENABLED=true` last, after `CONNECTOR_HUB_NAME`, `CONNECTOR_HUB_CLIENT_ID`,
   `CONNECTOR_HUB_CLIENT_SECRET`, `CONNECTOR_HUB_REDIRECT_URIS`, `CONNECTOR_TOKEN_PEPPER`, `CONNECTOR_ENCRYPTION_KEY`, `NEXT_PUBLIC_APP_URL`,
   `GROQ_API_KEY` (and optionally `CONNECTOR_AUTO_SUMMARY=true`).
3. **Deploy the Convex functions** (`npx convex deploy`). This creates the new tables/indexes (additive) and registers the two crons.
4. **Set the Next.js environment** (`CONNECTOR_ENABLED=true`, `NEXT_PUBLIC_CONVEX_SITE_URL=https://<deployment>.convex.site`) and **rebuild/redeploy**:
   the rewrites are read at build/start time.
5. **Verify:** `curl $BASE/.well-known/ecosystem-connector.json`, `curl $API/health`, then `node --experimental-strip-types scripts/connector-smoke.ts`.
6. Give the Hub its client id/secret and have a user connect from the Hub; check **Integrations → Connected apps**.

To switch off: set `CONNECTOR_ENABLED` to anything else in Convex **and** Next.js (and redeploy Next.js). Existing grants stay in the database but nothing answers.

### Operating it

- **Rotate the encryption key:** add `CONNECTOR_ENCRYPTION_KEY_V2` (64 hex). New secrets use the highest key id; old ones still decrypt. Remove `…_KEY` only after
  re-registering the endpoints that used it.
- **Rotate the pepper:** invalidates every token and media link (users must reconnect). Do it only after revoking grants.
- **A webhook stopped delivering:** `GET /webhooks/{id}` shows `status` and `disabledReason`; `GET /webhooks/{id}/deliveries` shows attempts, last HTTP code and the
  truncated response body. Fix the receiver, then `PATCH {"status":"active"}` and redeliver, or heal from `GET /events`.
- **Stuck deliveries:** the sweep (every 2 minutes) re-queues overdue ones. A claimed delivery holds a 30 s lease, so a crashed worker is retried automatically.
- **Retention (daily cron, bounded batches):** events 7 d · deliveries 14 d · operations 7 d · idempotency 24 h · authorization codes right after expiry ·
  audit 90 d · rate-limit windows · rotated-refresh tombstones after 91 d.
- **A user left the organization:** their grants stop working on the next call (`403 forbidden`); revoke them from the UI/API to tidy up.
- **Logs:** every connector log line is JSON with `requestId`; tokens and secrets are never logged.

## Findings to act on

**Provider tokens are stored in plaintext.** `user_integrations` (Google Calendar) and `notion_integrations` store `accessToken` and `refreshToken` as plain
strings. This predates the connector and the connector never reads or returns them (verified by tests), but anyone with database access can. Recommendation:
encrypt them with the same approach used for webhook secrets — AES-256-GCM, versioned key id, `convex/connector/crypto.ts` (`encryptSecret` /
`decryptSecret`) — behind a one-off migration, and decrypt only inside the actions that call Google/Notion.

Also noticed while integrating, not changed here: `notifications.markAllRead` and `notifications.markReadByMeetingId` use unbounded `.collect()`; and
`getOrganizationPlan` probes at most `maxMeetings + 1` meetings, so `meetingsUsed` is capped at the plan limit.

## Testing

```bash
npm test                 # ~390 tests: unit, Convex functions (convex-test) and the C01–C22 conformance suite
npm run typecheck
npm run lint
```

- `tests/convex/conformance.test.ts` is the automated CP1 checklist, one `describe` per C-number.
- The Next.js rewrite was verified end to end against a stand-in upstream: method, path and query, body, `Authorization`, `Idempotency-Key`, the upstream
  status (418 in the check) and `X-RateLimit-*`, `Retry-After` and `Idempotent-Replay` headers all pass through, and with the flag off every connect route is
  a 404.
- **Smoke test against a running deployment:**

  ```bash
  CP1_BASE_URL=$BASE CP1_ACCESS_TOKEN=$TOKEN node --experimental-strip-types scripts/connector-smoke.ts
  # optional: CP1_WEBHOOK_URL=https://hub.example.com/hooks/meetup   (also exercises webhook CRUD)
  # helpers:  … connector-smoke.ts authorize | exchange <code> | receiver
  ```
