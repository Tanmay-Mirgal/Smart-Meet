import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { emitConnectorEvent } from "../../convex/connector/events";
import { EVENTS, getEventScopes } from "../../convex/connector/registry";
import { eventEnvelope } from "../../convex/connector/standard";
import { actorFromTokenIdentifier } from "../../convex/lib/actor";
import { createMeetingCore } from "../../convex/meetings/index";
import { act, connect, getJson } from "./connect";
import { HOST, MEMBER, ORG, OTHER_ORG, OUTSIDER, as, newConvex, seedWorld, type TestConvex } from "./fixtures";
import { enableConnector, warmModules } from "./helpers";
import {
  EVERYTHING,
  bodyOf,
  installReceiver,
  registerHook,
  removeReceiver,
  settle,
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

type Item = {
  id: string;
  type: string;
  occurredAt: string;
  tenantId: string;
  actor: { id: string; name: string; kind: string };
  externalRef: Record<string, string>;
  data: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

async function poll(t: TestConvex, token: string, query = "") {
  const res = await getJson(t, token, `/events?limit=200${query}`);
  expect(res.status, res.text).toBe(200);
  return res.body!.items as Item[];
}

const typesOf = (items: Item[]) => items.map((item) => item.type);

/** Every event must satisfy BOTH the envelope schema and its own registry `data` schema. */
function expectValid(item: Item) {
  expect(eventEnvelope.safeParse(item).success, JSON.stringify(item)).toBe(true);
  const definition = EVENTS.find((e) => e.type === item.type)!;
  const parsed = definition.data.safeParse(item.data);
  expect(parsed.success, `${item.type}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
}

async function connectorMeeting(t: TestConvex, token: string, extra: Record<string, unknown> = {}) {
  const res = await act(t, token, "meetings.create", { title: "Roadmap", ...extra });
  expect(res.status, res.text).toBe(200);
  return res.body!.output.meeting.id as Id<"meetings">;
}

describe("lifecycle events", () => {
  it("meeting.started / meeting.scheduled / meeting.ended, with valid payloads", async () => {
    const { t, token } = await world();
    const live = await connectorMeeting(t, token);
    tick();
    await connectorMeeting(t, token, {
      title: "Later",
      scheduledFor: new Date(T0 + 3_600_000).toISOString(),
      scheduledEndsAt: new Date(T0 + 7_200_000).toISOString(),
    });
    tick();
    await act(t, token, "meetings.end", { meetingId: live });

    const items = await poll(t, token);
    expect(typesOf(items)).toEqual(["meeting.started", "meeting.scheduled", "meeting.ended"]);
    items.forEach(expectValid);
    expect(items[0].data).toMatchObject({
      meeting: { id: live, title: "Roadmap", status: "active", purpose: "Roadmap" },
      host: { name: "Hana Host" },
    });
    expect(items[2].data.meeting).toMatchObject({ id: live, status: "ended" });
    expect(items.every((item) => item.tenantId === ORG)).toBe(true);
    await settle(t);
  });

  it("a scheduled meeting emits meeting.started when it first goes live", async () => {
    const { t, token } = await world();
    const meetingId = await connectorMeeting(t, token, {
      scheduledFor: new Date(T0 + 3_600_000).toISOString(),
      scheduledEndsAt: new Date(T0 + 7_200_000).toISOString(),
    });
    expect(typesOf(await poll(t, token))).toEqual(["meeting.scheduled"]);

    vi.setSystemTime(T0 + 3_700_000); // > 1 h later: the original access token has expired
    await as(t, HOST).mutation(api.participants.index.join, { meetingId });
    await as(t, HOST).mutation(api.participants.index.join, { meetingId }); // joining again changes nothing
    const { token: fresh } = await connect(t, { scope: EVERYTHING });
    const items = await poll(t, fresh);
    expect(typesOf(items)).toEqual(["meeting.scheduled", "meeting.started"]);
    expect(items[1].actor.kind).toBe("user"); // caused in the UI, not through the connector
    await settle(t);
  });

  it("emits meeting.ended once even if the meeting is ended twice from the UI", async () => {
    const { t, token } = await world();
    const meetingId = await connectorMeeting(t, token);
    await as(t, HOST).mutation(api.meetings.index.endMeeting, { meetingId });
    tick();
    await as(t, HOST).mutation(api.meetings.index.endMeeting, { meetingId });
    expect(typesOf(await poll(t, token)).filter((type) => type === "meeting.ended")).toHaveLength(1);
    await settle(t);
  });

  it("invite.accepted when an invitee joins", async () => {
    const { t, token } = await world();
    const meetingId = await connectorMeeting(t, token, { inviteEmails: ["mia@example.com"] });
    await as(t, MEMBER).mutation(api.participants.index.join, { meetingId });
    const accepted = (await poll(t, token)).find((item) => item.type === "invite.accepted")!;
    expectValid(accepted);
    expect(accepted.data).toMatchObject({ email: "mia@example.com", meeting: { id: meetingId } });
    expect(accepted.actor).toMatchObject({ kind: "user", name: "Mia Member" });
    await settle(t);
  });
});

describe("meeting.summary.ready", () => {
  it("fires for a browser-saved summary, exactly once per version", async () => {
    const { t, token } = await world();
    const meetingId = await connectorMeeting(t, token);
    await as(t, HOST).mutation(api.participants.index.join, { meetingId });
    await as(t, MEMBER).mutation(api.participants.index.join, { meetingId });

    const save = (summary: string) =>
      as(t, HOST).mutation(api.meetings.index.saveSummary, {
        meetingId,
        summary,
        key_points: ["Ship"],
        decisions: ["Use Convex"],
        action_items: [{ task: "Write docs", assignee: "Mia Member", due: null }],
      });
    const summaries = async () => (await poll(t, token)).filter((e) => e.type === "meeting.summary.ready");

    await save("First draft");
    let events = await summaries();
    expect(events).toHaveLength(1);
    expectValid(events[0]);
    expect(events[0].data).toMatchObject({
      version: 1,
      summary: "First draft",
      keyPoints: ["Ship"],
      decisions: ["Use Convex"],
      actionItems: [{ task: "Write docs", assignee: "Mia Member", due: null }],
      meeting: { id: meetingId, host: { name: "Hana Host", email: "hana@example.com" } },
    });
    expect(events[0].data.participants.map((p: { name: string }) => p.name).sort()).toEqual(["Hana Host", "Mia Member"]);
    expect(events[0].data.participants.find((p: { name: string }) => p.name === "Mia Member").email).toBe("mia@example.com");
    expect(events[0].actor.kind).toBe("user");

    await save("First draft"); // identical re-save: same version, no new event
    expect(await summaries()).toHaveLength(1);

    tick();
    await save("Second draft"); // regenerated: version 2, emitted again
    events = await summaries();
    expect(events.map((e) => e.data.version)).toEqual([1, 2]);
    await settle(t);
  });
});

describe("task events", () => {
  it("task.created / task.updated / task.completed (a reopened task completes again)", async () => {
    const { t, token } = await world();
    const created = await act(t, token, "tasks.create", { title: "Ship it", assigneeEmail: "mia@example.com" });
    const taskId = created.body!.output.task.id as string;
    const update = async (status: "open" | "in_progress" | "done") => {
      vi.setSystemTime(Date.now() + 10_000); // outside the coalescing window
      await act(t, token, "tasks.update", { taskId, status });
    };

    await update("in_progress");
    await update("done");
    await update("open");
    await update("done");

    const items = await poll(t, token);
    items.forEach(expectValid);
    expect(typesOf(items)).toEqual([
      "task.created",
      "task.updated",
      "task.updated",
      "task.completed",
      "task.updated",
      "task.updated",
      "task.completed",
    ]);
    expect(items[0].data.task).toMatchObject({ id: taskId, title: "Ship it", status: "open", assignee: { name: "Mia Member" } });
    expect(items[3].data.task.status).toBe("done");
    expect(items[0].actor.kind).toBe("connector");
    await settle(t);
  });

  it("coalesces rapid updates of one task into the latest state", async () => {
    const { t, token } = await world();
    const taskId = (await act(t, token, "tasks.create", { title: "Draft" })).body!.output.task.id as string;

    await act(t, token, "tasks.update", { taskId, title: "Draft 2" });
    tick(1_000);
    await act(t, token, "tasks.update", { taskId, title: "Draft 3", status: "in_progress" });
    let updates = (await poll(t, token)).filter((e) => e.type === "task.updated");
    expect(updates).toHaveLength(1);
    expect(updates[0].data.task).toMatchObject({ title: "Draft 3", status: "in_progress" });

    tick(6_000); // past the 5 s window
    await act(t, token, "tasks.update", { taskId, title: "Draft 4" });
    updates = (await poll(t, token)).filter((e) => e.type === "task.updated");
    expect(updates.map((e) => e.data.task.title)).toEqual(["Draft 3", "Draft 4"]);
    await settle(t);
  });

  it("does not coalesce into an event that was already delivered", async () => {
    const calls = installReceiver();
    const { t, token } = await world();
    await registerHook(t, token, ["task.*"]);
    const taskId = (await act(t, token, "tasks.create", { title: "T" })).body!.output.task.id as string;
    await act(t, token, "tasks.update", { taskId, title: "T2" });
    await settle(t); // delivers created + updated
    const delivered = calls.length;

    tick(500);
    await act(t, token, "tasks.update", { taskId, title: "T3" });
    await settle(t);
    expect(calls.length).toBe(delivered + 1);
    expect(bodyOf(calls[calls.length - 1]).data.task.title).toBe("T3");
  });

  it("tasks inherit their meeting's correlation ids, and keep their own where they set them (C18)", async () => {
    const { t, token } = await world();
    const meetingId = await connectorMeeting(t, token, {
      externalRef: { hubProjectId: "prj_1", hubRunId: "run_1" },
    });
    await act(t, token, "tasks.create", { title: "inherits", meetingId });
    await act(t, token, "tasks.create", { title: "overrides", meetingId, externalRef: { hubRunId: "run_2", hubStepId: "s9" } });
    await act(t, token, "tasks.create", { title: "unrelated" });

    const created = (await poll(t, token)).filter((e) => e.type === "task.created");
    expect(created.map((e) => [e.data.task.title, e.externalRef])).toEqual([
      ["inherits", { hubProjectId: "prj_1", hubRunId: "run_1" }],
      ["overrides", { hubProjectId: "prj_1", hubRunId: "run_2", hubStepId: "s9" }],
      ["unrelated", {}],
    ]);
    await settle(t);
  });
});

describe("recording events", () => {
  it("recording.ready and recording.failed carry the meeting's correlation ids", async () => {
    const { t, token } = await world();
    const meetingId = await connectorMeeting(t, token, { externalRef: { hubRunId: "run_7" } });
    const host = as(t, HOST);
    await host.mutation(api.participants.index.join, { meetingId });

    const first = await host.mutation(api.recordings.index.start, { meetingId });
    tick(60_000);
    await host.mutation(api.recordings.index.stop, { meetingId, recordingId: first, mimeType: "video/webm" });
    await host.mutation(api.recordings.index.markReady, { meetingId, recordingId: first, mimeType: "video/webm" });

    const second = await host.mutation(api.recordings.index.start, { meetingId });
    await host.mutation(api.recordings.index.markFailed, { meetingId, recordingId: second, errorMessage: "encoder crashed" });

    const items = (await poll(t, token)).filter((e) => e.type.startsWith("recording."));
    items.forEach(expectValid);
    expect(typesOf(items)).toEqual(["recording.ready", "recording.failed"]);
    expect(items[0].data).toMatchObject({ recording: { id: String(first), mimeType: "video/webm", durationMs: 60_000 } });
    expect(items.every((e) => e.externalRef.hubRunId === "run_7")).toBe(true);
    expect(JSON.stringify(items)).not.toContain("encoder crashed"); // no free-form internals
    await settle(t);
  });
});

describe("meeting.transcript.ready", () => {
  async function endedWithTranscript(t: TestConvex, token: string, lines = 3) {
    const meetingId = await connectorMeeting(t, token);
    for (let i = 0; i < lines; i += 1) {
      tick();
      await as(t, HOST).mutation(api.transcripts.index.add, { meetingId, text: `line ${i}`, timestamp: i });
    }
    tick(10_000);
    await act(t, token, "meetings.end", { meetingId });
    return meetingId;
  }
  const ready = async (t: TestConvex, token: string) =>
    (await poll(t, token)).filter((e) => e.type === "meeting.transcript.ready");
  const advance = async (t: TestConvex, ms: number) => {
    vi.advanceTimersByTime(ms);
    await t.finishInProgressScheduledFunctions();
  };

  it("is emitted once, 60 s after the meeting ended, from the system", async () => {
    const { t, token } = await world();
    const meetingId = await endedWithTranscript(t, token);
    await advance(t, 59_000);
    expect(await ready(t, token)).toEqual([]);

    await advance(t, 2_000);
    const events = await ready(t, token);
    expect(events).toHaveLength(1);
    expectValid(events[0]);
    expect(events[0]).toMatchObject({ actor: { kind: "system" } });
    expect(events[0].data).toMatchObject({ segments: 3, meeting: { id: meetingId, status: "ended" } });
    expect(events[0].data.durationMs).toBeGreaterThan(0);

    await advance(t, 600_000);
    expect(await ready(t, token)).toHaveLength(1);
    await settle(t);
  });

  it("waits for a late transcript batch (debounce), then still emits once", async () => {
    const { t, token } = await world();
    const meetingId = await endedWithTranscript(t, token);
    await advance(t, 50_000);
    await as(t, HOST).mutation(api.transcripts.index.addBatch, {
      meetingId,
      entries: [{ text: "late line", timestamp: 99 }],
    });

    await advance(t, 20_000); // 70 s after the end, but only 20 s after the last write
    expect(await ready(t, token)).toEqual([]);
    await advance(t, 50_000);
    const events = await ready(t, token);
    expect(events).toHaveLength(1);
    expect(events[0].data.segments).toBe(4);
    await settle(t);
  });

  it("is not emitted for a meeting without a transcript", async () => {
    const { t, token } = await world();
    const meetingId = await connectorMeeting(t, token);
    await act(t, token, "meetings.end", { meetingId });
    await advance(t, 120_000);
    expect(await ready(t, token)).toEqual([]);
    await settle(t);
  });
});

const GROQ_REPLY = {
  summary: "## Overview\nShip on Friday.",
  key_points: ["Ship"],
  decisions: ["Go"],
  action_items: [{ task: "Write docs", assignee: null, due: null }],
};

describe("server-side summary fallback", () => {
  async function scenario(options: { lines?: number; subscribe?: boolean; plan?: "pro" | "starter"; withSummary?: boolean } = {}) {
    const llm = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(GROQ_REPLY) } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", llm);
    vi.stubEnv("GROQ_API_KEY", "gsk_test");
    vi.stubEnv("CONNECTOR_AUTO_SUMMARY", "true");
    vi.stubEnv("CONNECTOR_AUTO_SUMMARY_DELAY_MINUTES", "10");

    const calls = installReceiver();
    const { t, token } = await world(options.plan ?? "pro");
    if (options.subscribe !== false) await registerHook(t, token, ["meeting.summary.ready"]);
    const meetingId = await connectorMeeting(t, token);
    for (let i = 0; i < (options.lines ?? 5); i += 1) {
      tick();
      await as(t, HOST).mutation(api.transcripts.index.add, {
        meetingId,
        text: `${"We discussed the roadmap in detail. ".repeat(3)}#${i}`,
        timestamp: i,
      });
    }
    if (options.withSummary) {
      await as(t, HOST).mutation(api.meetings.index.saveSummary, { meetingId, summary: "Already there" });
    }
    await act(t, token, "meetings.end", { meetingId });
    return { t, token, meetingId, llm, calls };
  }

  const advance = async (t: TestConvex, ms: number) => {
    vi.advanceTimersByTime(ms);
    await t.finishInProgressScheduledFunctions();
  };
  const summaryAsset = (t: TestConvex) =>
    t.run((ctx) => ctx.db.query("meeting_assets").collect().then((rows) => rows.filter((r) => r.type === "summary")));

  it("generates the summary after the delay, emits meeting.summary.ready and creates tasks", async () => {
    const { t, token, llm, calls } = await scenario();
    await advance(t, 9 * 60_000);
    expect(llm).not.toHaveBeenCalled();
    expect(await summaryAsset(t)).toHaveLength(0);

    await advance(t, 61_000);
    await settle(t);
    expect(llm).toHaveBeenCalledTimes(1);
    const [asset] = await summaryAsset(t);
    expect(asset).toMatchObject({ content: GROQ_REPLY.summary, summaryVersion: 1 });

    const events = (await poll(t, token)).filter((e) => e.type === "meeting.summary.ready");
    expect(events).toHaveLength(1);
    expect(events[0].data.summary).toBe(GROQ_REPLY.summary);
    expect(events[0].actor.kind).toBe("connector");
    expect(calls.map((c) => c.headers["X-CP-Event"])).toContain("meeting.summary.ready");
    expect((await getJson(t, token, "/tasks")).body!.items.map((x: { title: string }) => x.title)).toEqual(["Write docs"]);
  });

  it.each([
    ["the flag is off", () => vi.stubEnv("CONNECTOR_AUTO_SUMMARY", "false"), {}],
    ["the transcript is too short", () => undefined, { lines: 1 }],
    ["a summary already exists", () => undefined, { withSummary: true }],
    ["nobody subscribed to summary events", () => undefined, { subscribe: false }],
    ["the plan has no AI summaries", () => undefined, { plan: "starter" as const, subscribe: true }],
  ])("does nothing when %s", async (_label, tweak, options) => {
    const { t, llm } = await scenario(options);
    tweak();
    await advance(t, 11 * 60_000);
    await settle(t);
    expect(llm).not.toHaveBeenCalled();
  });
});

describe("GET /events (polling fallback)", () => {
  it("C20: replays exactly what webhooks delivered, in order", async () => {
    const calls = installReceiver();
    const { t, token } = await world();
    await registerHook(t, token, ["meeting.*", "task.*"]);

    const meetingId = await connectorMeeting(t, token, { externalRef: { hubRunId: "r1" } });
    tick();
    await act(t, token, "tasks.create", { title: "T", meetingId });
    tick();
    await act(t, token, "meetings.end", { meetingId });
    await settle(t);

    const polled = await poll(t, token);
    const delivered = calls.map(bodyOf);
    expect(delivered.length).toBeGreaterThanOrEqual(3);
    const byId = new Map(polled.map((item) => [item.id, item]));
    for (const body of delivered) expect(byId.get(body.id), body.type).toEqual(body);
    expect(new Set(delivered.map((d) => d.id)).size).toBe(delivered.length);
    // The log is in commit order.
    expect(typesOf(polled).slice(0, 3)).toEqual(["meeting.started", "task.created", "meeting.ended"]);
  });

  it("C12: pages with a gap-free cursor and lets a poller resume", async () => {
    const { t, token } = await world();
    for (let i = 0; i < 5; i += 1) {
      tick();
      await act(t, token, "tasks.create", { title: `t${i}` });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await getJson(t, token, `/events?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(res.status).toBe(200);
      seen.push(...res.body!.items.map((e: Item) => e.data.task.title));
      cursor = res.body!.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toEqual(["t0", "t1", "t2", "t3", "t4"]);
    expect(pages).toBe(3);

    // Resume from the tail: only new events appear.
    const tail = await getJson(t, token, "/events?limit=200");
    const resumeFrom = tail.body!.latestCursor as string;
    expect((await getJson(t, token, `/events?cursor=${encodeURIComponent(resumeFrom)}`)).body!.items).toEqual([]);
    tick();
    await act(t, token, "tasks.create", { title: "t5" });
    const fresh = await getJson(t, token, `/events?cursor=${encodeURIComponent(resumeFrom)}`);
    expect(fresh.body!.items.map((e: Item) => e.data.task.title)).toEqual(["t5"]);
    await settle(t);
  });

  it("filters by types and rejects unknown types and bad cursors", async () => {
    const { t, token } = await world();
    const meetingId = await connectorMeeting(t, token);
    await act(t, token, "tasks.create", { title: "T", meetingId });
    await act(t, token, "meetings.end", { meetingId });

    expect(typesOf(await poll(t, token, "&types=task.*"))).toEqual(["task.created"]);
    expect(typesOf(await poll(t, token, "&types=meeting.ended,task.created")).sort()).toEqual(["meeting.ended", "task.created"]);
    expect((await getJson(t, token, "/events?types=bogus.*")).status).toBe(400);
    expect((await getJson(t, token, "/events?cursor=garbage")).status).toBe(400);
    expect((await getJson(t, token, "/events?limit=0")).status).toBe(400);
    await settle(t);
  });

  it("only returns events the connection's scopes could read, and only its own organization's", async () => {
    const { t, token } = await world();
    const { token: narrow } = await connect(t, { scope: "meetup:events:read meetup:meetings:read" });
    const meetingId = await connectorMeeting(t, token);
    await as(t, HOST).mutation(api.meetings.index.saveSummary, { meetingId, summary: "s" });
    await act(t, token, "tasks.create", { title: "T" });

    expect(typesOf(await poll(t, token))).toEqual(
      expect.arrayContaining(["meeting.started", "meeting.summary.ready", "task.created"]),
    );
    // No summaries:read / tasks:read ⇒ those events do not exist for this grant.
    expect(typesOf(await poll(t, narrow))).toEqual(["meeting.started"]);
    for (const event of EVENTS) {
      expect(getEventScopes(event.type).length).toBeGreaterThan(0);
    }

    const { token: foreign } = await connect(t, { who: OUTSIDER, orgId: OTHER_ORG, scope: EVERYTHING });
    expect(await poll(t, foreign)).toEqual([]);
    await settle(t);
  });

  it("keeps events for 7 days", async () => {
    const { t, token } = await world();
    await act(t, token, "tasks.create", { title: "old" });
    vi.setSystemTime(T0 + 8 * 86_400_000);
    const { token: later } = await connect(t, { scope: EVERYTHING });
    expect(await poll(t, later)).toEqual([]);
    await settle(t);
  });
});

describe("transactional outbox (C19)", () => {
  it("an event exists iff the change committed", async () => {
    const { t } = await world();
    const actor = (await t.run((ctx) => actorFromTokenIdentifier(ctx, HOST.tokenIdentifier)))!;
    const countEvents = () => t.run((ctx) => ctx.db.query("connector_events").collect().then((r) => r.length));

    // Rolled back: neither the meeting nor its event may survive.
    await expect(
      t.run(async (ctx) => {
        await createMeetingCore(ctx, actor, { orgId: ORG, title: "Doomed" });
        throw new Error("something else failed in the same transaction");
      }),
    ).rejects.toThrow("something else failed");
    expect(await t.run((ctx) => ctx.db.query("meetings").collect().then((r) => r.length))).toBe(0);
    expect(await countEvents()).toBe(0);

    // Committed: both exist, and they describe the same meeting.
    const meetingId = await t.run((ctx) => createMeetingCore(ctx, actor, { orgId: ORG, title: "Kept" }));
    const [event] = await t.run((ctx) => ctx.db.query("connector_events").collect());
    expect(event).toMatchObject({ type: "meeting.started", seq: 1 });
    expect(event.data.meeting.id).toBe(String(meetingId));
    await settle(t);
  });

  it("sequence numbers are gap-free and per organization", async () => {
    const { t, token } = await world();
    for (let i = 0; i < 4; i += 1) {
      tick();
      await act(t, token, "tasks.create", { title: `t${i}` });
    }
    const rows = await t.run((ctx) => ctx.db.query("connector_events").collect());
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
  });
});

describe("with the connector off (C22 / §6)", () => {
  it("emitting costs nothing: no database access, no scheduling", async () => {
    vi.stubEnv("CONNECTOR_ENABLED", "false");
    const trap = new Proxy({}, { get: () => { throw new Error("touched the database or scheduler"); } });
    await expect(
      emitConnectorEvent(
        { db: trap, scheduler: trap } as never,
        {
          orgId: ORG,
          type: "task.created",
          actor: null,
          build: async () => {
            throw new Error("built a payload");
          },
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("normal flows leave every connector table untouched", async () => {
    vi.stubEnv("CONNECTOR_ENABLED", "false");
    const t = newConvex();
    await seedWorld(t, "pro");
    const meetingId = await as(t, HOST).mutation(api.meetings.index.create, { orgId: ORG, title: "Plain" });
    await as(t, HOST).mutation(api.tasks.index.create, { orgId: ORG, title: "T", meetingId });
    await as(t, HOST).mutation(api.meetings.index.saveSummary, { meetingId, summary: "s" });
    await as(t, HOST).mutation(api.meetings.index.endMeeting, { meetingId });

    for (const table of [
      "connector_events", "connector_event_counters", "connector_deliveries", "connector_webhooks",
      "connector_operations", "connector_audit", "connector_grants",
    ] as const) {
      expect(await t.run((ctx) => ctx.db.query(table).collect()), table).toEqual([]);
    }
    // The only thing scheduled is what Meetup always scheduled (clearing the meeting's notifications).
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.every((job) => job.name.includes("markReadByMeetingId"))).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("writes nothing for an organization with no active connection", async () => {
    const t = newConvex();
    await seedWorld(t, "pro");
    await as(t, HOST).mutation(api.meetings.index.create, { orgId: ORG, title: "Nobody listens" });
    expect(await t.run((ctx) => ctx.db.query("connector_events").collect())).toEqual([]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("the sweep and retention jobs are harmless no-ops", async () => {
    vi.stubEnv("CONNECTOR_ENABLED", "false");
    const t = newConvex();
    expect(await t.mutation(internal.connector.dispatch.sweep, {})).toBe(0);
    await t.mutation(internal.connector.retention.run, {});
  });
});

describe("retention (daily cron)", () => {
  it("deletes expired rows in bounded batches and keeps the rest", async () => {
    const t = newConvex();
    await seedWorld(t);
    const grantId = await t.run((ctx) =>
      ctx.db.insert("connector_grants", {
        clientId: "hub", userTokenIdentifier: HOST.tokenIdentifier, orgId: ORG, scopes: [],
        accessHash: "a", accessExpiresAt: 0, refreshHash: "r", refreshExpiresAt: 0,
        refreshFamilyId: "f", createdAt: T0,
      }),
    );
    const day = 86_400_000;

    // 450 old events (more than one batch of 200), created now…
    await t.run(async (ctx) => {
      for (let i = 0; i < 450; i += 1) {
        await ctx.db.insert("connector_events", {
          orgId: ORG, seq: i + 1, eventId: `evt_${i}`, type: "task.created", occurredAt: T0,
          actor: { id: "x", name: "x", kind: "system" }, data: {},
        });
      }
      await ctx.db.insert("connector_operations", { grantId, orgId: ORG, action: "a", status: "succeeded", createdAt: T0 });
      await ctx.db.insert("connector_idempotency", { grantId, key: "k", requestHash: "h", status: 200, response: "{}", createdAt: T0, expiresAt: T0 + day });
      await ctx.db.insert("connector_codes", { codeHash: "c", clientId: "hub", userTokenIdentifier: "u", orgId: ORG, scopes: [], redirectUri: "https://x", codeChallenge: "c", expiresAt: T0 + 60_000 });
      await ctx.db.insert("connector_audit", { orgId: ORG, grantId, clientId: "hub", userTokenIdentifier: "u", via: "connector", action: "me", method: "GET", status: 200, ok: true, requestId: "r", createdAt: T0 });
      await ctx.db.insert("connector_ratelimits", { grantId, bucket: "rpm:1", count: 1, expiresAt: T0 + 120_000 });
    });
    // …and a fresh one that must survive.
    vi.setSystemTime(T0 + 8 * day);
    await t.run((ctx) =>
      ctx.db.insert("connector_events", {
        orgId: ORG, seq: 999, eventId: "evt_fresh", type: "task.created", occurredAt: Date.now(),
        actor: { id: "x", name: "x", kind: "system" }, data: {},
      }),
    );

    await t.mutation(internal.connector.retention.run, {});
    expect((await t.run((ctx) => ctx.db.query("connector_events").collect())).length).toBe(451 - 200);

    await t.finishAllScheduledFunctions(vi.runAllTimers); // the job re-schedules itself while a backlog remains
    const events = await t.run((ctx) => ctx.db.query("connector_events").collect());
    expect(events.map((e) => e.eventId)).toEqual(["evt_fresh"]);
    // 7 d operations, 24 h idempotency, expired codes and rate-limit windows are gone; audit (90 d) stays.
    expect(await t.run((ctx) => ctx.db.query("connector_operations").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("connector_idempotency").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("connector_codes").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("connector_ratelimits").collect())).toEqual([]);
    expect((await t.run((ctx) => ctx.db.query("connector_audit").collect())).length).toBe(1);

    vi.setSystemTime(T0 + 91 * day);
    await t.mutation(internal.connector.retention.run, {});
    expect(await t.run((ctx) => ctx.db.query("connector_audit").collect())).toEqual([]);
  });
});
