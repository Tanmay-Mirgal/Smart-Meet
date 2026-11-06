import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { RESOURCES } from "../../convex/connector/registry";
import { connect, getJson } from "./connect";
import {
  HOST,
  MEMBER,
  ORG,
  OTHER_ORG,
  OUTSIDER,
  as,
  newConvex,
  seedWorld,
  type TestConvex,
} from "./fixtures";
import { enableConnector } from "./helpers";

const T0 = new Date("2026-03-01T10:00:00.000Z").getTime();
const READ_SCOPES = [
  "meetup:orgs:read",
  "meetup:members:read",
  "meetup:meetings:read",
  "meetup:transcripts:read",
  "meetup:summaries:read",
  "meetup:recordings:read",
  "meetup:tasks:read",
].join(" ");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  enableConnector();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const tick = (ms = 5) => vi.setSystemTime(Date.now() + ms);

/** Every response must satisfy the zod output schema that generated the manifest. */
function expectMatchesSchema(name: string, body: unknown) {
  const definition = RESOURCES.find((r) => r.name === name)!;
  const result = definition.output.safeParse(body);
  expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
}

async function build() {
  const t = newConvex();
  await seedWorld(t, "pro");
  const host = as(t, HOST);

  const create = async (title: string, purpose: string, extra: Record<string, unknown> = {}) => {
    tick();
    return await host.mutation(api.meetings.index.create, { orgId: ORG, title, purpose, ...extra });
  };

  const m1 = await create("Design review", "design-review");
  const m2 = await create("Standup", "standup");
  const m3 = await create("Planning", "planning", {
    scheduledFor: T0 + 86_400_000,
    scheduledEndsAt: T0 + 90_000_000,
  });
  const m4 = await create("Retro", "Standup");

  // m2: host joins, then ends it.
  await host.mutation(api.participants.index.join, { meetingId: m2 });
  tick();
  await host.mutation(api.meetings.index.endMeeting, { meetingId: m2 });

  // m1 transcript — two segments share a timestamp to exercise tie handling.
  for (const [text, ts] of [["a", 10], ["b", 20], ["c1", 30], ["c2", 30], ["d", 40]] as const) {
    tick();
    await host.mutation(api.transcripts.index.add, { meetingId: m1, text, timestamp: ts });
  }

  // Tasks in ORG.
  const taskIds: Id<"tasks">[] = [];
  for (const [title, meetingId, assignee] of [
    ["t1", m1, MEMBER.tokenIdentifier],
    ["t2", m1, undefined],
    ["t3", m2, MEMBER.tokenIdentifier],
    ["t4", undefined, undefined],
    ["t5", undefined, MEMBER.tokenIdentifier],
  ] as const) {
    tick();
    taskIds.push(
      await host.mutation(api.tasks.index.create, {
        orgId: ORG,
        title,
        meetingId,
        assigneeTokenIdentifier: assignee,
      }),
    );
  }
  await as(t, MEMBER).mutation(api.tasks.index.updateTask, { taskId: taskIds[2], status: "done" });

  // Another organization with its own data.
  const other = as(t, OUTSIDER);
  tick();
  const otherMeeting = await other.mutation(api.meetings.index.create, {
    orgId: OTHER_ORG,
    title: "Secret board meeting",
    purpose: "design-review",
  });
  tick();
  await other.mutation(api.transcripts.index.add, {
    meetingId: otherMeeting,
    text: "other-org confidential",
    timestamp: 1,
  });
  const otherTask = await other.mutation(api.tasks.index.create, {
    orgId: OTHER_ORG,
    title: "other-org task",
    meetingId: otherMeeting,
  });

  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["video"])));
  const recordings = await t.run(async (ctx) => {
    const row = (status: "ready" | "processing", n: number) =>
      ctx.db.insert("meeting_recordings", {
        meetingId: m1,
        orgId: ORG,
        ownerTokenIdentifier: HOST.tokenIdentifier,
        startedAt: T0 + n,
        stoppedAt: T0 + n + 60_000,
        durationMs: 60_000,
        status,
        storageId: status === "ready" ? storageId : undefined,
        mimeType: "video/webm",
        createdAt: T0 + n,
        updatedAt: T0 + n,
      });
    const ready = await row("ready", 1);
    const processing = await row("processing", 2);
    const foreign = await ctx.db.insert("meeting_recordings", {
      meetingId: otherMeeting,
      orgId: OTHER_ORG,
      ownerTokenIdentifier: OUTSIDER.tokenIdentifier,
      startedAt: T0,
      status: "ready",
      storageId,
      createdAt: T0,
      updatedAt: T0,
    });
    await ctx.db.insert("meeting_whiteboards", {
      meetingId: m1,
      isOpen: true,
      scene: JSON.stringify({ type: "excalidraw", elements: [{ id: "e1" }] }),
      updatedByTokenIdentifier: HOST.tokenIdentifier,
      updatedAt: T0,
    });
    return { ready, processing, foreign };
  });

  const { token } = await connect(t, { scope: `${READ_SCOPES}` });
  const outsiderToken = (await connect(t, { who: OUTSIDER, orgId: OTHER_ORG, scope: READ_SCOPES })).token;

  return { t, token, outsiderToken, m1, m2, m3, m4, otherMeeting, taskIds, otherTask, recordings };
}

async function settle(t: TestConvex) {
  vi.useRealTimers();
  await t.finishAllScheduledFunctions(() => undefined);
}

describe("simple resources", () => {
  it("serves orgs and members, matching the schema, without secrets", async () => {
    const f = await build();
    const org = await getJson(f.t, f.token, "/orgs");
    expect(org.status).toBe(200);
    expect(org.body).toMatchObject({ id: ORG, name: "Acme", slug: "acme" });
    expectMatchesSchema("orgs.get", org.body);

    const members = await getJson(f.t, f.token, "/members");
    expect(members.status).toBe(200);
    expectMatchesSchema("members.list", members.body);
    expect(members.body!.items.map((m: { email: string }) => m.email).sort()).toEqual([
      "hana@example.com",
      "mia@example.com",
    ]);
    // Only the documented fields, and the id is Meetup's own — not a Clerk id or tokenIdentifier.
    for (const member of members.body!.items) {
      expect(Object.keys(member).sort()).toEqual(["email", "id", "imageUrl", "name"]);
      expect(member.id).not.toMatch(/user_|clerk/);
    }
    expect(members.text).not.toContain("tokenIdentifier");
    await settle(f.t);
  });

  it("returns the insights aggregates", async () => {
    const f = await build();
    const res = await getJson(f.t, f.token, "/insights?range=30d");
    expect(res.status).toBe(200);
    expectMatchesSchema("insights.get", res.body);
    expect(res.body!.meetings).toEqual({ total: 4, scheduled: 1, active: 2, ended: 1 });
    expect(res.body!.tasks).toEqual({ open: 4, inProgress: 0, done: 1 });
    expect(res.body!.timeline).toHaveLength(4);
    await settle(f.t);
  });
});

describe("meetings", () => {
  it("lists newest first and matches the schema", async () => {
    const f = await build();
    const res = await getJson(f.t, f.token, "/meetings");
    expect(res.status).toBe(200);
    expectMatchesSchema("meetings.list", res.body);
    expect(res.body!.items.map((m: { title: string }) => m.title)).toEqual([
      "Retro",
      "Planning",
      "Standup",
      "Design review",
    ]);
    expect(res.body!.nextCursor).toBeNull();
    const first = res.body!.items[3];
    expect(first).toMatchObject({
      status: "active",
      host: { name: "Hana Host" },
      purpose: "design-review",
    });
    expect(first.joinUrl).toBe(`https://meetup.example.com/meeting/${f.m1}`);
    expect(first.webUrl).toBe(`https://meetup.example.com/meeting/${f.m1}/details`);
    await settle(f.t);
  });

  it("filters by status, purpose (case-insensitive) and creation window", async () => {
    const f = await build();
    const titles = async (query: string) =>
      (await getJson(f.t, f.token, `/meetings?${query}`)).body!.items.map(
        (m: { title: string }) => m.title,
      );

    expect(await titles("status=ended")).toEqual(["Standup"]);
    expect(await titles("status=scheduled")).toEqual(["Planning"]);
    expect((await titles("purpose=STANDUP")).sort()).toEqual(["Retro", "Standup"]);
    expect(await titles("status=active&purpose=standup")).toEqual(["Retro"]);
    expect(await titles(`from=${encodeURIComponent(new Date(T0 + 3_000).toISOString())}`)).toEqual([]);
    expect(await titles(`to=${encodeURIComponent(new Date(T0).toISOString())}`)).toEqual([]);
    expect((await titles(`from=${encodeURIComponent(new Date(T0).toISOString())}`)).length).toBe(4);
    await settle(f.t);
  });

  it("C12: pages with stable cursors — no gaps or repeats, even with concurrent inserts", async () => {
    const f = await build();
    const page1 = await getJson(f.t, f.token, "/meetings?limit=2");
    expect(page1.body!.items.map((m: { title: string }) => m.title)).toEqual(["Retro", "Planning"]);
    expect(page1.body!.nextCursor).toBeTruthy();

    // A newer meeting appears between the two requests.
    tick();
    await as(f.t, HOST).mutation(api.meetings.index.create, { orgId: ORG, title: "Brand new" });

    const page2 = await getJson(
      f.t,
      f.token,
      `/meetings?limit=2&cursor=${encodeURIComponent(page1.body!.nextCursor)}`,
    );
    expect(page2.body!.items.map((m: { title: string }) => m.title)).toEqual([
      "Standup",
      "Design review",
    ]);
    expect(page2.body!.nextCursor).toBeNull();
    await settle(f.t);
  });

  it("rejects bad cursors, limits and unknown params (strict), unless told to ignore them", async () => {
    const f = await build();
    const bad = await getJson(f.t, f.token, "/meetings?cursor=garbage");
    expect(bad.status).toBe(400);
    expect(bad.body!.error).toMatchObject({ code: "validation_failed", retryable: false });

    expect((await getJson(f.t, f.token, "/meetings?limit=0")).status).toBe(400);
    expect((await getJson(f.t, f.token, "/meetings?limit=201")).status).toBe(400);
    expect((await getJson(f.t, f.token, "/meetings?limit=200")).status).toBe(200);
    expect((await getJson(f.t, f.token, "/meetings?status=bogus")).status).toBe(400);

    const strict = await getJson(f.t, f.token, "/meetings?mystery=1");
    expect(strict.status).toBe(400);
    expect(strict.body!.error.details[0].message).toMatch(/unrecognized|unknown/i);
    expect(
      (await getJson(f.t, f.token, "/meetings?mystery=1", { prefer: "unknown-fields=ignore" })).status,
    ).toBe(200);
    await settle(f.t);
  });

  it("returns meeting detail with settings, counts and flags", async () => {
    const f = await build();
    const res = await getJson(f.t, f.token, `/meetings/${f.m1}`);
    expect(res.status).toBe(200);
    expectMatchesSchema("meetings.get", res.body);
    expect(res.body).toMatchObject({
      id: String(f.m1),
      status: "active",
      settings: { joinMode: "organization_only", allowRecording: true },
      participantCount: 0,
      hasSummary: false,
      googleCalendar: { syncRequested: false },
      recording: { allowed: true, recordingCount: 2, hasReadyRecording: true },
    });

    const ended = await getJson(f.t, f.token, `/meetings/${f.m2}`);
    expect(ended.body).toMatchObject({ status: "ended", participantCount: 1 });
    expect(ended.body!.durationMs).toBeGreaterThanOrEqual(0);
    await settle(f.t);
  });

  it("lists participants with pagination", async () => {
    const f = await build();
    await as(f.t, MEMBER).mutation(api.participants.index.join, { meetingId: f.m2 }).catch(() => undefined);
    const all = await getJson(f.t, f.token, `/meetings/${f.m2}/participants`);
    expect(all.status).toBe(200);
    expectMatchesSchema("meetings.participants", all.body);
    expect(all.body!.items[0]).toMatchObject({ name: "Hana Host", role: "host", email: "hana@example.com" });

    const paged = await getJson(f.t, f.token, `/meetings/${f.m1}/participants?limit=1`);
    expect(paged.body!.items).toHaveLength(1);
    await settle(f.t);
  });

  it("serves the whiteboard scene, or an empty state", async () => {
    const f = await build();
    const board = await getJson(f.t, f.token, `/meetings/${f.m1}/whiteboard`);
    expect(board.status).toBe(200);
    expectMatchesSchema("meetings.whiteboard", board.body);
    expect(board.body).toMatchObject({
      isOpen: true,
      scene: { type: "excalidraw", elements: [{ id: "e1" }] },
      truncated: false,
    });

    const none = await getJson(f.t, f.token, `/meetings/${f.m2}/whiteboard`);
    expect(none.body).toEqual({ isOpen: false, scene: null, updatedAt: null, truncated: false });

    // Oversized scenes are withheld rather than streamed.
    await f.t.run(async (ctx) => {
      const row = (await ctx.db.query("meeting_whiteboards").collect())[0];
      await ctx.db.patch(row._id, { scene: "x".repeat(800_001) });
    });
    const big = await getJson(f.t, f.token, `/meetings/${f.m1}/whiteboard`);
    expect(big.body).toMatchObject({ scene: null, truncated: true });
    await settle(f.t);
  });
});

describe("transcript", () => {
  it("pages in spoken order, including segments that share a timestamp", async () => {
    const f = await build();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await getJson(
        f.t,
        f.token,
        `/meetings/${f.m1}/transcript?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(res.status).toBe(200);
      expectMatchesSchema("meetings.transcript", res.body);
      seen.push(...res.body!.items.map((s: { text: string }) => s.text));
      cursor = res.body!.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(seen).toEqual(["a", "b", "c1", "c2", "d"]);
    expect(pages).toBe(3);

    const first = (await getJson(f.t, f.token, `/meetings/${f.m1}/transcript`)).body!.items[0];
    expect(first).toMatchObject({ speaker: "Hana Host", timestamp: new Date(10).toISOString() });
    await settle(f.t);
  });
});

describe("summary", () => {
  it("is 404 until one exists, then returns the structured summary", async () => {
    const f = await build();
    const none = await getJson(f.t, f.token, `/meetings/${f.m1}/summary`);
    expect(none.status).toBe(404);
    expect(none.body!.error.code).toBe("not_found");

    await as(f.t, HOST).mutation(api.meetings.index.saveSummary, {
      meetingId: f.m1,
      summary: "## Overview\nShip it.",
      key_points: ["Ship Friday"],
      decisions: ["Use Convex"],
      action_items: [{ task: "Write docs", assignee: "Mia Member", due: null }],
    });
    const res = await getJson(f.t, f.token, `/meetings/${f.m1}/summary`);
    expect(res.status).toBe(200);
    expectMatchesSchema("meetings.summary", res.body);
    expect(res.body).toMatchObject({
      summary: "## Overview\nShip it.",
      keyPoints: ["Ship Friday"],
      decisions: ["Use Convex"],
      actionItems: [{ task: "Write docs", assignee: "Mia Member", due: null }],
      version: 1,
    });
    expect((await getJson(f.t, f.token, `/meetings/${f.m1}`)).body!.hasSummary).toBe(true);
    await settle(f.t);
  });
});

describe("recordings", () => {
  it("gives ready recordings a short-lived signed link, never a permanent one", async () => {
    const f = await build();
    const res = await getJson(f.t, f.token, `/meetings/${f.m1}/recordings`);
    expect(res.status).toBe(200);
    expectMatchesSchema("meetings.recordings", res.body);

    const [processing, ready] = res.body!.items;
    expect(processing).toMatchObject({ id: String(f.recordings.processing), status: "processing" });
    expect(processing.playbackUrl).toBeUndefined();
    expect(ready).toMatchObject({ id: String(f.recordings.ready), status: "ready", mimeType: "video/webm" });

    const link = new URL(ready.playbackUrl);
    expect(link.origin + link.pathname).toBe(
      `https://meetup.example.com/api/connect/v1/recordings/${f.recordings.ready}/media`,
    );
    expect(Number(link.searchParams.get("exp"))).toBe(Date.now() + 10 * 60_000);
    expect(ready.playbackUrlExpiresAt).toBe(new Date(Date.now() + 10 * 60_000).toISOString());

    const media = (path = link.pathname.replace("/api", "") + link.search) => f.t.fetch(path);
    const ok = await media();
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBeTruthy();
    expect(ok.headers.get("cache-control")).toBe("no-store");
    await settle(f.t);
  });

  it("rejects tampered, expired and revoked links", async () => {
    const f = await build();
    const res = await getJson(f.t, f.token, `/meetings/${f.m1}/recordings`);
    const link = new URL(res.body!.items[1].playbackUrl);
    const path = (mutate: (u: URL) => void = () => undefined) => {
      const copy = new URL(link);
      mutate(copy);
      return copy.pathname.replace("/api", "") + copy.search;
    };

    expect((await f.t.fetch(path((u) => u.searchParams.set("sig", "0".repeat(64))))).status).toBe(401);
    expect((await f.t.fetch(path((u) => u.searchParams.set("exp", String(Date.now() + 1e9))))).status).toBe(401);
    expect((await f.t.fetch(path((u) => u.searchParams.delete("sig")))).status).toBe(401);
    // A signature for one recording cannot be replayed against another.
    const swapped = path().replace(String(f.recordings.ready), String(f.recordings.processing));
    expect((await f.t.fetch(swapped)).status).toBe(401);

    expect((await f.t.fetch(path())).status).toBe(302);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect((await f.t.fetch(path())).status).toBe(401);

    // Revoking the grant kills links that have not expired yet.
    vi.setSystemTime(T0 + 60_000);
    const fresh = await getJson(f.t, f.token, `/meetings/${f.m1}/recordings`);
    const freshLink = new URL(fresh.body!.items[1].playbackUrl);
    const freshPath = freshLink.pathname.replace("/api", "") + freshLink.search;
    expect((await f.t.fetch(freshPath)).status).toBe(302);
    const grant = (await f.t.run((ctx) => ctx.db.query("connector_grants").collect()))[0];
    await as(f.t, HOST).mutation(api.connector.grants.revoke, { grantId: grant._id });
    expect((await f.t.fetch(freshPath)).status).toBe(401);
    await settle(f.t);
  });
});

describe("tasks", () => {
  it("lists and filters tasks", async () => {
    const f = await build();
    const titles = async (query = "") =>
      (await getJson(f.t, f.token, `/tasks${query}`)).body!.items.map((t: { title: string }) => t.title);

    expect(await titles()).toEqual(["t5", "t4", "t3", "t2", "t1"]);
    expect(await titles("?status=done")).toEqual(["t3"]);
    expect(await titles("?status=open")).toEqual(["t5", "t4", "t2", "t1"]);
    expect(await titles(`?meetingId=${f.m1}`)).toEqual(["t2", "t1"]);
    expect(await titles(`?meetingId=${f.m1}&status=open`)).toEqual(["t2", "t1"]);
    expect(await titles("?assigneeEmail=mia@example.com")).toEqual(["t5", "t3", "t1"]);
    expect(await titles("?assigneeEmail=nobody@example.com")).toEqual([]);
    expect(await titles("?assigneeEmail=otto@example.com")).toEqual([]); // exists, but in another org

    const res = await getJson(f.t, f.token, "/tasks");
    expectMatchesSchema("tasks.list", res.body);
    expect(res.body!.items[4]).toMatchObject({
      title: "t1",
      status: "open",
      source: "manual",
      assignee: { name: "Mia Member" },
      meetingId: String(f.m1),
      webUrl: "https://meetup.example.com/tasks",
    });
    await settle(f.t);
  });

  it("pages tasks with stable cursors", async () => {
    const f = await build();
    const p1 = await getJson(f.t, f.token, "/tasks?limit=2");
    expect(p1.body!.items.map((t: { title: string }) => t.title)).toEqual(["t5", "t4"]);
    tick();
    await as(f.t, HOST).mutation(api.tasks.index.create, { orgId: ORG, title: "t6" });
    const p2 = await getJson(f.t, f.token, `/tasks?limit=2&cursor=${encodeURIComponent(p1.body!.nextCursor)}`);
    expect(p2.body!.items.map((t: { title: string }) => t.title)).toEqual(["t3", "t2"]);
    const p3 = await getJson(f.t, f.token, `/tasks?limit=2&cursor=${encodeURIComponent(p2.body!.nextCursor)}`);
    expect(p3.body!.items.map((t: { title: string }) => t.title)).toEqual(["t1"]);
    expect(p3.body!.nextCursor).toBeNull();
    await settle(f.t);
  });
});

describe("tenant isolation (C08)", () => {
  const subPaths = (id: string) => [
    `/meetings/${id}`,
    `/meetings/${id}/participants`,
    `/meetings/${id}/transcript`,
    `/meetings/${id}/summary`,
    `/meetings/${id}/recordings`,
    `/meetings/${id}/whiteboard`,
    `/tasks?meetingId=${id}`,
  ];

  it("answers 404 — never 403 — for another organization's ids, in both directions", async () => {
    const f = await build();
    for (const path of subPaths(String(f.otherMeeting))) {
      const res = await getJson(f.t, f.token, path);
      expect(res.status, `ORG token → ${path}`).toBe(404);
      expect(res.body!.error.code).toBe("not_found");
    }
    for (const path of subPaths(String(f.m1))) {
      const res = await getJson(f.t, f.outsiderToken, path);
      expect(res.status, `OTHER_ORG token → ${path}`).toBe(404);
    }
  });

  it("is indistinguishable from a missing or malformed id", async () => {
    const f = await build();
    const foreign = await getJson(f.t, f.token, `/meetings/${f.otherMeeting}`);
    for (const id of ["nonexistent", "0".repeat(32), String(f.taskIds[0]), String(f.recordings.ready)]) {
      const res = await getJson(f.t, f.token, `/meetings/${id}`);
      expect(res.status).toBe(404);
      expect(res.body!.error.message).toBe(foreign.body!.error.message);
    }
  });

  it("never leaks another organization's rows into lists, counts or insights", async () => {
    const f = await build();
    for (const path of ["/meetings", "/tasks", "/members", "/insights", "/orgs"]) {
      const res = await getJson(f.t, f.token, path);
      expect(res.text, path).not.toContain("Secret board meeting");
      expect(res.text, path).not.toContain("other-org");
      expect(res.text, path).not.toContain("otto@example.com");
    }
    const theirs = await getJson(f.t, f.outsiderToken, "/meetings");
    expect(theirs.body!.items.map((m: { title: string }) => m.title)).toEqual(["Secret board meeting"]);
    expect((await getJson(f.t, f.outsiderToken, "/orgs")).body!.name).toBe("Other");
    expect((await getJson(f.t, f.outsiderToken, "/insights")).body!.meetings.total).toBe(1);
  });

  it("signed media links cannot cross tenants either", async () => {
    const f = await build();
    // A link signed for the foreign recording but carrying the ORG grant fails the tenant check.
    const own = await getJson(f.t, f.token, `/meetings/${f.m1}/recordings`);
    const url = new URL(own.body!.items[1].playbackUrl);
    const forged = url.pathname.replace("/api", "").replace(String(f.recordings.ready), String(f.recordings.foreign)) + url.search;
    expect((await f.t.fetch(forged)).status).toBe(401); // signature covers the recording id
    await settle(f.t);
  });
});

describe("scopes (C07)", () => {
  it("each resource demands its own scope and names it", async () => {
    const f = await build();
    const { token } = await connect(f.t, { scope: "meetup:meetings:read" });
    const expectations: Array<[string, string]> = [
      ["/orgs", "meetup:orgs:read"],
      ["/members", "meetup:members:read"],
      [`/meetings/${f.m1}/transcript`, "meetup:transcripts:read"],
      [`/meetings/${f.m1}/summary`, "meetup:summaries:read"],
      [`/meetings/${f.m1}/recordings`, "meetup:recordings:read"],
      ["/tasks", "meetup:tasks:read"],
    ];
    for (const [path, scope] of expectations) {
      const res = await getJson(f.t, token, path);
      expect(res.status, path).toBe(403);
      expect(res.body!.error).toMatchObject({ code: "insufficient_scope", requiredScope: scope });
    }
    for (const path of ["/meetings", `/meetings/${f.m1}`, `/meetings/${f.m1}/participants`, `/meetings/${f.m1}/whiteboard`, "/insights"]) {
      expect((await getJson(f.t, token, path)).status, path).toBe(200);
    }
    await settle(f.t);
  });
});

describe("no secret material (C21)", () => {
  it("never returns provider tokens, signals or credentials from any resource", async () => {
    const f = await build();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("user_integrations", {
        userTokenIdentifier: HOST.tokenIdentifier,
        provider: "google_calendar",
        accountEmail: "hana@gmail.test",
        accessToken: "ya29.TOPSECRET-GOOGLE-ACCESS",
        refreshToken: "1//TOPSECRET-GOOGLE-REFRESH",
        scope: ["calendar"],
        tokenExpiresAt: T0 + 1e6,
        status: "connected",
        connectedAt: T0,
        updatedAt: T0,
      });
      await ctx.db.insert("notion_integrations", {
        userTokenIdentifier: HOST.tokenIdentifier,
        orgId: ORG,
        botId: "bot",
        accessToken: "secret_TOPSECRET-NOTION",
        status: "connected",
        connectedAt: T0,
        updatedAt: T0,
      });
    });

    const everything = [
      "/orgs", "/members", "/meetings", `/meetings/${f.m1}`, `/meetings/${f.m1}/participants`,
      `/meetings/${f.m1}/transcript`, `/meetings/${f.m1}/summary`, `/meetings/${f.m1}/recordings`,
      `/meetings/${f.m1}/whiteboard`, "/tasks", "/insights", "/me",
    ];
    for (const path of everything) {
      const res = await getJson(f.t, f.token, path);
      expect(res.text, path).not.toMatch(/TOPSECRET|accessToken|refreshToken|access_token|refresh_token|cp1r?_meetup_|signals|secretEnc|codeHash|accessHash/);
    }
    await settle(f.t);
  });
});
