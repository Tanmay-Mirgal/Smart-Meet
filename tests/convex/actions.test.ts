import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ACTIONS } from "../../convex/connector/registry";
import { buildSummaryRequest } from "../../lib/summarizer";
import { bearer, connect, getJson } from "./connect";
import {
  HOST,
  MEMBER,
  ORG,
  OTHER_ORG,
  OUTSIDER,
  as,
  newConvex,
  seedWorld,
  type PlanSeed,
  type TestConvex,
} from "./fixtures";
import { enableConnector, warmModules } from "./helpers";

const T0 = new Date("2026-03-01T10:00:00.000Z").getTime();
const WRITE_SCOPES = [
  "meetup:members:read",
  "meetup:meetings:read",
  "meetup:meetings:write",
  "meetup:transcripts:read",
  "meetup:summaries:read",
  "meetup:tasks:read",
  "meetup:tasks:write",
  "meetup:notifications:write",
].join(" ");

beforeAll(warmModules, 60_000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  enableConnector();
  vi.stubEnv("GROQ_API_KEY", "gsk_test");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const tick = (ms = 5) => vi.setSystemTime(Date.now() + ms);
const settle = (t: TestConvex) => t.finishAllScheduledFunctions(vi.runAllTimers);

async function setup(plan: PlanSeed = "pro", scope = WRITE_SCOPES) {
  const t = newConvex();
  await seedWorld(t, plan);
  const { token } = await connect(t, { scope });
  return { t, token };
}

async function act(
  t: TestConvex,
  token: string,
  name: string,
  input: unknown,
  headers: Record<string, string> = {},
) {
  const response = await t.fetch(`/connect/v1/actions/${name}`, {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json", ...headers },
    body: JSON.stringify({ input }),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: text ? (JSON.parse(text) as Record<string, any>) : null, // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

function expectOutputMatchesSchema(name: string, output: unknown) {
  const result = ACTIONS.find((a) => a.name === name)!.output.safeParse(output);
  expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
}

const all = <T extends "meetings" | "tasks" | "notifications" | "connector_idempotency" | "connector_operations" | "connector_audit">(
  t: TestConvex,
  table: T,
) => t.run((ctx) => ctx.db.query(table).collect());

describe("meetings.create", () => {
  it("creates an instant meeting as the consenting user and persists correlation data", async () => {
    const { t, token } = await setup();
    const res = await act(t, token, "meetings.create", {
      title: "Design review",
      purpose: "design-review",
      description: "Review the onboarding flow",
      inviteEmails: ["Ann@Example.com"],
      settings: { joinMode: "invite_only" },
      metadata: { source: "hub" },
      externalRef: { hubProjectId: "prj_1", hubRunId: "run_1", hubStepId: "step_1" },
    });

    expect(res.status).toBe(200);
    expectOutputMatchesSchema("meetings.create", res.body!.output);
    const { meeting } = res.body!.output;
    expect(meeting).toMatchObject({ title: "Design review", status: "active" });
    expect(meeting.joinUrl).toBe(`https://meetup.example.com/meeting/${meeting.id}`);
    expect(meeting.webUrl).toBe(`https://meetup.example.com/meeting/${meeting.id}/details`);

    const [row] = await all(t, "meetings");
    expect(row).toMatchObject({
      orgId: ORG,
      purpose: "design-review",
      hostUserTokenIdentifier: HOST.tokenIdentifier,
      createdVia: "connector",
      externalRef: { hubProjectId: "prj_1", hubRunId: "run_1", hubStepId: "step_1" },
      metadataJson: '{"source":"hub"}',
      settings: { joinMode: "invite_only", allowChat: true },
    });
    const invites = await t.run((ctx) => ctx.db.query("meeting_invites").collect());
    expect(invites.map((i) => i.email)).toEqual(["ann@example.com"]);
    await settle(t);
  });

  it("schedules a future meeting", async () => {
    const { t, token } = await setup();
    const res = await act(t, token, "meetings.create", {
      title: "Planning",
      scheduledFor: new Date(T0 + 3_600_000).toISOString(),
      scheduledEndsAt: new Date(T0 + 7_200_000).toISOString(),
      scheduledTimeZone: "Asia/Kolkata",
    });
    expect(res.body!.output.meeting).toMatchObject({
      status: "scheduled",
      scheduledFor: new Date(T0 + 3_600_000).toISOString(),
    });
    await settle(t);
  });

  it("C11: validation errors name the field path", async () => {
    const { t, token } = await setup();
    const missing = await act(t, token, "meetings.create", {});
    expect(missing.status).toBe(400);
    expect(missing.body!.error).toMatchObject({ code: "validation_failed", retryable: false });
    expect(missing.body!.error.details[0].path).toBe("input.title");

    const badTime = await act(t, token, "meetings.create", { title: "x", scheduledFor: "tomorrow" });
    expect(badTime.status).toBe(400);
    expect(badTime.body!.error.details[0].path).toBe("input.scheduledFor");

    const ordering = await act(t, token, "meetings.create", {
      title: "x",
      scheduledFor: new Date(T0 + 7_200_000).toISOString(),
      scheduledEndsAt: new Date(T0 + 3_600_000).toISOString(),
    });
    expect(ordering.status).toBe(400);
    expect(ordering.body!.error.details[0]).toMatchObject({ path: "scheduledEndsAt" });
    expect(await all(t, "meetings")).toHaveLength(0);
  });

  it("rejects unknown fields unless the caller asks to ignore them", async () => {
    const { t, token } = await setup();
    expect((await act(t, token, "meetings.create", { title: "x", bogus: true })).status).toBe(400);
    expect(
      (await act(t, token, "meetings.create", { title: "x", bogus: true }, { prefer: "unknown-fields=ignore" })).status,
    ).toBe(200);

    const strictEnvelope = await t.fetch("/connect/v1/actions/meetings.create", {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify({ input: { title: "y" }, extra: 1 }),
    });
    expect(strictEnvelope.status).toBe(400);
    await settle(t);
  });

  it("answers bad JSON, oversized bodies and unknown actions with the standard shape", async () => {
    const { t, token } = await setup();
    const post = (path: string, body: string) =>
      t.fetch(`/connect/v1/actions/${path}`, {
        method: "POST",
        headers: { ...bearer(token), "content-type": "application/json" },
        body,
      });

    const invalid = await post("meetings.create", "{nope");
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("validation_failed");

    const huge = await post("meetings.create", JSON.stringify({ input: { title: "x".repeat(1_100_000) } }));
    expect(huge.status).toBe(413);
    expect((await huge.json()).error.code).toBe("validation_failed");

    const unknown = await post("meetings.explode", "{}");
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe("not_found");
  });

  it("402 plan_limit at the meeting cap, with the limit", async () => {
    const { t, token } = await setup({ maxMeetings: 1 });
    expect((await act(t, token, "meetings.create", { title: "one" })).status).toBe(200);
    const capped = await act(t, token, "meetings.create", { title: "two" });
    expect(capped.status).toBe(402);
    expect(capped.body!.error).toMatchObject({
      code: "plan_limit",
      limit: 1,
      feature: "maxMeetings",
      retryable: false,
    });
    await settle(t);
  });

  it("412 precondition_failed with an absolute fixUrl when Google Calendar is not connected", async () => {
    const { t, token } = await setup("pro");
    const res = await act(t, token, "meetings.create", {
      title: "x",
      scheduledFor: new Date(T0 + 3_600_000).toISOString(),
      syncWithGoogleCalendar: true,
    });
    expect(res.status).toBe(412);
    expect(res.body!.error).toMatchObject({
      code: "precondition_failed",
      fixUrl: "https://meetup.example.com/integrations",
    });
    expect(await all(t, "meetings")).toHaveLength(0);
  });

  it("C07: needs the write scope and names it", async () => {
    const { t, token } = await setup("pro", "meetup:meetings:read");
    const res = await act(t, token, "meetings.create", { title: "x" });
    expect(res.status).toBe(403);
    expect(res.body!.error).toMatchObject({
      code: "insufficient_scope",
      requiredScope: "meetup:meetings:write",
    });
  });

  it("audits every call as via=connector, including failures", async () => {
    const { t, token } = await setup();
    await act(t, token, "meetings.create", { title: "ok" });
    await act(t, token, "meetings.create", {});
    const rows = await all(t, "connector_audit");
    expect(rows.map((r) => [r.action, r.method, r.status, r.ok])).toEqual([
      ["meetings.create", "POST", 200, true],
      ["meetings.create", "POST", 400, false],
    ]);
    expect(rows[0]).toMatchObject({ via: "connector", orgId: ORG });
    await settle(t);
  });
});

describe("idempotency (C10)", () => {
  const input = { title: "Standup" };

  it("replays the stored response for the same key and body — and runs the action once", async () => {
    const { t, token } = await setup();
    const first = await act(t, token, "meetings.create", input, { "idempotency-key": "k-1" });
    const second = await act(t, token, "meetings.create", input, { "idempotency-key": "k-1" });

    expect(first.status).toBe(200);
    expect(first.headers.get("idempotent-replay")).toBeNull();
    expect(second.status).toBe(200);
    expect(second.headers.get("idempotent-replay")).toBe("true");
    expect(second.text).toBe(first.text);
    expect(await all(t, "meetings")).toHaveLength(1);
    await settle(t);
  });

  it("does not depend on JSON key order", async () => {
    const { t, token } = await setup();
    const a = await act(t, token, "tasks.create", { title: "T", metadata: { a: 1, b: 2 } }, { "idempotency-key": "k" });
    const b = await act(t, token, "tasks.create", { metadata: { b: 2, a: 1 }, title: "T" }, { "idempotency-key": "k" });
    expect(b.headers.get("idempotent-replay")).toBe("true");
    expect(b.text).toBe(a.text);
    expect(await all(t, "tasks")).toHaveLength(1);
  });

  it("422 idempotency_conflict for the same key with a different body", async () => {
    const { t, token } = await setup();
    await act(t, token, "meetings.create", input, { "idempotency-key": "k-1" });
    const conflict = await act(t, token, "meetings.create", { title: "Different" }, { "idempotency-key": "k-1" });
    expect(conflict.status).toBe(422);
    expect(conflict.body!.error).toMatchObject({ code: "idempotency_conflict", retryable: false });
    expect(await all(t, "meetings")).toHaveLength(1);
    await settle(t);
  });

  it("treats different keys, or no key, as different requests", async () => {
    const { t, token } = await setup();
    await act(t, token, "meetings.create", input, { "idempotency-key": "a" });
    await act(t, token, "meetings.create", input, { "idempotency-key": "b" });
    await act(t, token, "meetings.create", input);
    await act(t, token, "meetings.create", input);
    expect(await all(t, "meetings")).toHaveLength(4);
    await settle(t);
  });

  it("does not store failures, so a corrected retry with the same key succeeds", async () => {
    const { t, token } = await setup();
    const bad = await act(t, token, "meetings.create", {}, { "idempotency-key": "retry" });
    expect(bad.status).toBe(400);
    const good = await act(t, token, "meetings.create", input, { "idempotency-key": "retry" });
    expect(good.status).toBe(200);
    expect(good.headers.get("idempotent-replay")).toBeNull();
    await settle(t);
  });

  it("scopes keys per grant and forgets them after 24 hours", async () => {
    const { t, token } = await setup();
    const { token: otherGrant } = await connect(t, { scope: WRITE_SCOPES });
    await act(t, token, "meetings.create", input, { "idempotency-key": "shared" });
    const independent = await act(t, otherGrant, "meetings.create", input, { "idempotency-key": "shared" });
    expect(independent.headers.get("idempotent-replay")).toBeNull();

    vi.setSystemTime(T0 + 25 * 3_600_000);
    const { token: later } = await connect(t, { scope: WRITE_SCOPES });
    const afterExpiry = await act(t, later, "meetings.create", input, { "idempotency-key": "shared" });
    expect(afterExpiry.headers.get("idempotent-replay")).toBeNull();
    expect(await all(t, "meetings")).toHaveLength(3);
    await settle(t);
  });

  it("rejects an empty or over-long key", async () => {
    const { t, token } = await setup();
    expect((await act(t, token, "meetings.create", input, { "idempotency-key": "k".repeat(129) })).status).toBe(400);
    expect((await act(t, token, "meetings.create", input, { "idempotency-key": "k".repeat(128) })).status).toBe(200);
    await settle(t);
  });
});

describe("meetings.end and meetings.invite", () => {
  async function withMeeting() {
    const ctx = await setup();
    const created = await act(ctx.t, ctx.token, "meetings.create", { title: "Standup" });
    return { ...ctx, meetingId: created.body!.output.meeting.id as string };
  }

  it("ends the meeting as its host, and ending twice does not move endedAt", async () => {
    const { t, token, meetingId } = await withMeeting();
    tick(60_000);
    const first = await act(t, token, "meetings.end", { meetingId });
    expect(first.status).toBe(200);
    expectOutputMatchesSchema("meetings.end", first.body!.output);
    expect(first.body!.output.meeting).toMatchObject({ id: meetingId, status: "ended" });

    tick(60_000);
    const again = await act(t, token, "meetings.end", { meetingId });
    expect(again.status).toBe(200);
    expect(again.body!.output.meeting.endedAt).toBe(first.body!.output.meeting.endedAt);
    await settle(t);
  });

  it("403 forbidden when the connected user is not the host — it never bypasses the rule", async () => {
    const { t, meetingId } = await withMeeting();
    const { token: memberToken } = await connect(t, { who: MEMBER, scope: WRITE_SCOPES });
    const res = await act(t, memberToken, "meetings.end", { meetingId });
    expect(res.status).toBe(403);
    expect(res.body!.error.code).toBe("forbidden");
    expect(res.body!.error.message).toMatch(/host/i);
    const [meeting] = await all(t, "meetings");
    expect(meeting.status).toBe("active");
    await settle(t);
  });

  it("C08: 404 for another organization's meeting and for missing ids", async () => {
    const { t, token } = await withMeeting();
    const other = await as(t, OUTSIDER).mutation(api.meetings.index.create, { orgId: OTHER_ORG, title: "Theirs" });
    for (const id of [String(other), "nonexistent", "0".repeat(32)]) {
      const res = await act(t, token, "meetings.end", { meetingId: id });
      expect(res.status, id).toBe(404);
    }
    await settle(t);
  });

  it("invite follows the UI rule: the host must be present in the meeting", async () => {
    const { t, token, meetingId } = await withMeeting();
    const notYet = await act(t, token, "meetings.invite", { meetingId, emails: ["bob@example.com"] });
    expect(notYet.status).toBe(403);
    expect(notYet.body!.error.code).toBe("forbidden");

    // Once the host has joined (as in the UI), the same call works.
    await as(t, HOST).mutation(api.participants.index.join, { meetingId: meetingId as Id<"meetings"> });
    const ok = await act(t, token, "meetings.invite", {
      meetingId,
      emails: ["Bob@Example.com", "bob@example.com", "cy@example.com"],
      role: "viewer",
    });
    expect(ok.status).toBe(200);
    expectOutputMatchesSchema("meetings.invite", ok.body!.output);
    expect(ok.body!.output.invited.sort()).toEqual(["bob@example.com", "cy@example.com"]);

    const repeat = await act(t, token, "meetings.invite", { meetingId, emails: ["bob@example.com"] });
    expect(repeat.body!.output.invited).toEqual([]);
    await settle(t);
  });
});

describe("tasks", () => {
  it("creates a task, assigning a known member by email", async () => {
    const { t, token } = await setup();
    const meeting = await act(t, token, "meetings.create", { title: "M" });
    const meetingId = meeting.body!.output.meeting.id;

    const res = await act(t, token, "tasks.create", {
      title: "Write docs",
      meetingId,
      assigneeEmail: "mia@example.com",
      dueAt: new Date(T0 + 86_400_000).toISOString(),
      metadata: { k: "v" },
      externalRef: { hubRunId: "run_9" },
    });
    expect(res.status).toBe(200);
    expectOutputMatchesSchema("tasks.create", res.body!.output);
    expect(res.body!.output.task).toMatchObject({
      title: "Write docs",
      status: "open",
      source: "manual",
      assignee: { name: "Mia Member" },
      meetingId,
      dueAt: new Date(T0 + 86_400_000).toISOString(),
      createdVia: "connector",
      externalRef: { hubRunId: "run_9" },
      metadata: { k: "v" },
      webUrl: "https://meetup.example.com/tasks",
    });

    const [row] = await all(t, "tasks");
    expect(row).toMatchObject({ assigneeTokenIdentifier: MEMBER.tokenIdentifier, createdVia: "connector" });
    await settle(t);
  });

  it("unknown emails — and people from other orgs — become an unassigned suggestion", async () => {
    const { t, token } = await setup();
    for (const email of ["nobody@example.com", "otto@example.com"]) {
      const res = await act(t, token, "tasks.create", { title: `for ${email}`, assigneeEmail: email });
      expect(res.status).toBe(200);
      expect(res.body!.output.task.assignee).toBeUndefined();
      expect(res.body!.output.task.suggestedAssigneeName).toBe(email);
    }
    const rows = await all(t, "tasks");
    expect(rows.every((r) => r.assigneeTokenIdentifier === undefined)).toBe(true);
  });

  it("creates tasks from a summary, de-duplicating titles", async () => {
    const { t, token } = await setup();
    const meetingId = (await act(t, token, "meetings.create", { title: "M" })).body!.output.meeting.id;
    const items = [
      { title: "Ship it", assigneeName: "mia member" },
      { title: " ship IT " },
      { title: "Call vendor", assigneeName: "Zed" },
    ];
    const first = await act(t, token, "tasks.createFromSummary", {
      meetingId,
      actionItems: items,
      externalRef: { hubStepId: "s1" },
    });
    expect(first.status).toBe(200);
    expectOutputMatchesSchema("tasks.createFromSummary", first.body!.output);
    expect(first.body!.output.tasks.map((x: { title: string }) => x.title)).toEqual(["Ship it", "Call vendor"]);
    expect(first.body!.output.skippedDuplicates).toBe(1);
    expect(first.body!.output.tasks[0]).toMatchObject({
      source: "summary",
      assignee: { name: "Mia Member" },
      createdVia: "connector",
      externalRef: { hubStepId: "s1" },
    });
    expect(first.body!.output.tasks[1].suggestedAssigneeName).toBe("Zed");

    const second = await act(t, token, "tasks.createFromSummary", { meetingId, actionItems: items });
    expect(second.body!.output).toMatchObject({ tasks: [], skippedDuplicates: 3 });
    await settle(t);
  });

  it("updates status, assignee, due date and title — and clears them", async () => {
    const { t, token } = await setup();
    const taskId = (await act(t, token, "tasks.create", { title: "Old" })).body!.output.task.id;

    tick(5_000);
    const done = await act(t, token, "tasks.update", {
      taskId,
      status: "done",
      assigneeEmail: "mia@example.com",
      dueAt: new Date(T0 + 1000).toISOString(),
      title: "New title",
    });
    expect(done.status).toBe(200);
    expectOutputMatchesSchema("tasks.update", done.body!.output);
    expect(done.body!.output.task).toMatchObject({
      title: "New title",
      status: "done",
      assignee: { name: "Mia Member" },
      dueAt: new Date(T0 + 1000).toISOString(),
      completedAt: new Date(T0 + 5_000).toISOString(),
    });
    const [row] = await all(t, "tasks");
    expect(row.completedByName).toBe("Hana Host");

    const cleared = await act(t, token, "tasks.update", {
      taskId,
      status: "open",
      assigneeEmail: null,
      dueAt: null,
    });
    expect(cleared.body!.output.task.assignee).toBeUndefined();
    expect(cleared.body!.output.task.dueAt).toBeUndefined();
    expect(cleared.body!.output.task.completedAt).toBeUndefined();

    const untouched = await act(t, token, "tasks.update", { taskId });
    expect(untouched.status).toBe(200);
    expect(untouched.body!.output.task.title).toBe("New title");
  });

  it("rejects non-member assignees on update, and other organizations' tasks and meetings", async () => {
    const { t, token } = await setup();
    const taskId = (await act(t, token, "tasks.create", { title: "T" })).body!.output.task.id;
    const bad = await act(t, token, "tasks.update", { taskId, assigneeEmail: "otto@example.com" });
    expect(bad.status).toBe(400);
    expect(bad.body!.error.details[0]).toMatchObject({ path: "assigneeEmail" });

    const theirs = await as(t, OUTSIDER).mutation(api.tasks.index.create, { orgId: OTHER_ORG, title: "Theirs" });
    expect((await act(t, token, "tasks.update", { taskId: String(theirs), status: "done" })).status).toBe(404);

    const theirMeeting = await as(t, OUTSIDER).mutation(api.meetings.index.create, { orgId: OTHER_ORG, title: "X" });
    expect((await act(t, token, "tasks.create", { title: "x", meetingId: String(theirMeeting) })).status).toBe(404);
    expect(
      (await act(t, token, "tasks.createFromSummary", { meetingId: String(theirMeeting), actionItems: [{ title: "x" }] })).status,
    ).toBe(404);
    const [task] = await t.run((ctx) => ctx.db.get(theirs).then((x) => [x]));
    expect(task?.status).toBe("open");
    await settle(t);
  });

  it("creating through the connector shows up in the read API too", async () => {
    const { t, token } = await setup();
    await act(t, token, "tasks.create", { title: "Visible", assigneeEmail: "mia@example.com" });
    const list = await getJson(t, token, "/tasks?assigneeEmail=mia@example.com");
    expect(list.body!.items.map((x: { title: string }) => x.title)).toEqual(["Visible"]);
  });
});

describe("notifications.create", () => {
  it("shows up in the recipient's bell", async () => {
    const { t, token } = await setup();
    const res = await act(t, token, "notifications.create", {
      userEmail: "mia@example.com",
      title: "Deployment is live",
      message: "Your deployment to production finished.",
      link: "/dashboard",
    });
    expect(res.status).toBe(200);
    expectOutputMatchesSchema("notifications.create", res.body!.output);

    const bell = await as(t, MEMBER).query(api.notifications.index.list, { orgId: ORG });
    expect(bell).toHaveLength(1);
    expect(bell[0]).toMatchObject({
      title: "Deployment is live",
      message: "Your deployment to production finished.",
      link: "/dashboard",
      kind: "connector",
      isRead: false,
      orgId: ORG,
    });
  });

  it("accepts a userId from /members and a meeting link", async () => {
    const { t, token } = await setup();
    const members = await getJson(t, token, "/members");
    const mia = members.body!.items.find((m: { email: string }) => m.email === "mia@example.com");
    const meetingId = (await act(t, token, "meetings.create", { title: "M" })).body!.output.meeting.id;
    const res = await act(t, token, "notifications.create", {
      userId: mia.id,
      title: "Hi",
      message: "There is a meeting",
      meetingId,
      link: "https://orb.example.com/deploys/1",
    });
    expect(res.status).toBe(200);
    // (Creating the meeting also notified the org, so pick ours by title.)
    const bell = await as(t, MEMBER).query(api.notifications.index.list, { orgId: ORG });
    const note = bell.find((n) => n.title === "Hi");
    expect(note).toMatchObject({
      link: "https://orb.example.com/deploys/1",
      message: "There is a meeting",
      meetingId,
    });
    await settle(t);
  });

  it("treats non-members like unknown users (404) and validates recipients", async () => {
    const { t, token } = await setup();
    const base = { title: "t", message: "m" };
    expect((await act(t, token, "notifications.create", { ...base, userEmail: "otto@example.com" })).status).toBe(404);
    expect((await act(t, token, "notifications.create", { ...base, userEmail: "ghost@example.com" })).status).toBe(404);
    expect((await act(t, token, "notifications.create", { ...base })).status).toBe(400);
    expect(
      (await act(t, token, "notifications.create", { ...base, userEmail: "mia@example.com", userId: "x" })).status,
    ).toBe(400);
    expect(await all(t, "notifications")).toHaveLength(0);
  });

  it("refuses links that could send the user somewhere unsafe", async () => {
    const { t, token } = await setup();
    for (const link of ["javascript:alert(1)", "//evil.example.com", "http://plain.example.com", "data:text/html,x", "mailto:a@b.c"]) {
      const res = await act(t, token, "notifications.create", {
        userEmail: "mia@example.com",
        title: "t",
        message: "m",
        link,
      });
      expect(res.status, link).toBe(400);
      expect(res.body!.error.details[0].path).toBe("link");
    }
    expect(await all(t, "notifications")).toHaveLength(0);
  });

  it("C13: limited to 60 per minute per connection, then resets", async () => {
    const { t, token } = await setup();
    const send = () =>
      act(t, token, "notifications.create", { userEmail: "mia@example.com", title: "t", message: "m" });
    for (let i = 0; i < 60; i += 1) {
      expect((await send()).status, `call ${i + 1}`).toBe(200);
    }
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.body!.error).toMatchObject({ code: "rate_limited", retryable: true });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await all(t, "notifications")).toHaveLength(60);

    vi.setSystemTime(T0 + 61_000);
    expect((await send()).status).toBe(200);
  });
});

// ── generateSummary ──────────────────────────────────────────────────────────

type SummaryReply = {
  summary: string;
  key_points: string[];
  decisions: string[];
  action_items: Array<{ task: string; assignee: string | null; due: string | null }>;
};

const GOOD_SUMMARY: SummaryReply = {
  summary: "## Overview\nWe agreed to ship on Friday.",
  key_points: ["Ship Friday"],
  decisions: ["Use Convex"],
  action_items: [
    { task: "Write docs", assignee: "Mia Member", due: null },
    { task: "Ship it", assignee: null, due: "Friday" },
  ],
};

type LlmReply = Partial<SummaryReply> | "http-500" | "garbage" | "timeout";

function stubLlm(replies: LlmReply[] | (() => LlmReply)) {
  let calls = 0;
  const fetchMock = vi.fn(async () => {
    const next = typeof replies === "function" ? replies() : replies[Math.min(calls, replies.length - 1)];
    calls += 1;
    if (next === "timeout") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    if (next === "http-500") return new Response("{}", { status: 500 });
    const content = next === "garbage" ? "this is not json" : JSON.stringify({ ...GOOD_SUMMARY, ...next });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function endedMeetingWithTranscript(t: TestConvex, token: string, lines = 3) {
  const meetingId = (await act(t, token, "meetings.create", { title: "Roadmap" })).body!.output.meeting.id as string;
  for (let i = 0; i < lines; i += 1) {
    tick();
    await as(t, i % 2 ? MEMBER : HOST).mutation(api.transcripts.index.add, {
      meetingId: meetingId as Id<"meetings">,
      text: `line ${i}`,
      timestamp: i + 1,
    });
  }
  await act(t, token, "meetings.end", { meetingId });
  await settle(t);
  return meetingId;
}

async function pollOperation(t: TestConvex, token: string, id: string) {
  await settle(t);
  return (await getJson(t, token, `/operations/${id}`)).body!;
}

describe("meetings.generateSummary (async)", () => {
  it("C14: answers 202 with an operation, which reaches a terminal state with a summary AND tasks", async () => {
    const { t, token } = await setup();
    const llm = stubLlm([GOOD_SUMMARY]);
    const meetingId = await endedMeetingWithTranscript(t, token);

    const accepted = await act(t, token, "meetings.generateSummary", { meetingId });
    expect(accepted.status).toBe(202);
    const { operation } = accepted.body!;
    expect(operation).toMatchObject({ status: "pending" });
    expect(operation.pollUrl).toBe(`https://meetup.example.com/api/connect/v1/operations/${operation.id}`);

    const done = await pollOperation(t, token, operation.id);
    expect(done).toMatchObject({
      id: operation.id,
      action: "meetings.generateSummary",
      status: "succeeded",
    });
    expect(done.finishedAt).toBeTruthy();
    expectOutputMatchesSchema("meetings.generateSummary", done.output);
    expect(done.output).toMatchObject({
      meetingId,
      status: "generated",
      version: 1,
      summary: GOOD_SUMMARY.summary,
      actionItemCount: 2,
      tasksCreated: 2,
    });

    // The summary is stored through the same path as the browser's.
    const summary = await getJson(t, token, `/meetings/${meetingId}/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      summary: GOOD_SUMMARY.summary,
      keyPoints: ["Ship Friday"],
      decisions: ["Use Convex"],
      version: 1,
    });

    // …and the action items became tasks, matched to org members.
    const tasks = await getJson(t, token, `/tasks?meetingId=${meetingId}`);
    expect(tasks.body!.items.map((x: { title: string }) => x.title).sort()).toEqual(["Ship it", "Write docs"]);
    expect(tasks.body!.items.find((x: { title: string }) => x.title === "Write docs")).toMatchObject({
      source: "summary",
      createdVia: "connector",
      assignee: { name: "Mia Member" },
    });

    // The model was asked exactly what the browser flow asks, over the transcript in order.
    expect(llm).toHaveBeenCalledTimes(1);
    const [url, init] = llm.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gsk_test");
    expect(JSON.parse(init.body as string)).toEqual(
      buildSummaryRequest([
        { sender: "Hana Host", text: "line 0" },
        { sender: "Mia Member", text: "line 1" },
        { sender: "Hana Host", text: "line 2" },
      ]),
    );
  });

  it("returns an existing summary without calling the model, unless force is set", async () => {
    const { t, token } = await setup();
    const llm = stubLlm([GOOD_SUMMARY, { summary: "## Overview\nRegenerated.", action_items: [{ task: "Ship it", assignee: null, due: null }] }]);
    const meetingId = await endedMeetingWithTranscript(t, token);

    const first = await act(t, token, "meetings.generateSummary", { meetingId });
    await pollOperation(t, token, first.body!.operation.id);

    const second = await act(t, token, "meetings.generateSummary", { meetingId });
    expect(second.status).toBe(202);
    const existing = await pollOperation(t, token, second.body!.operation.id);
    expect(existing.output).toMatchObject({ status: "existing", version: 1, tasksCreated: 0 });
    expect(llm).toHaveBeenCalledTimes(1);

    const forced = await act(t, token, "meetings.generateSummary", { meetingId, force: true });
    const regenerated = await pollOperation(t, token, forced.body!.operation.id);
    expect(regenerated.output).toMatchObject({ status: "generated", version: 2, tasksCreated: 0 });
    expect(llm).toHaveBeenCalledTimes(2);
    expect((await getJson(t, token, `/meetings/${meetingId}/summary`)).body!.summary).toBe(
      "## Overview\nRegenerated.",
    );
  });

  it("passes the requested language to the prompt and records it", async () => {
    const { t, token } = await setup();
    const llm = stubLlm([GOOD_SUMMARY]);
    const meetingId = await endedMeetingWithTranscript(t, token);
    const accepted = await act(t, token, "meetings.generateSummary", { meetingId, language: "hi" });
    await pollOperation(t, token, accepted.body!.operation.id);

    const body = JSON.parse((llm.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[0].content).toContain('BCP-47 code "hi"');
    expect((await getJson(t, token, `/meetings/${meetingId}/summary`)).body!.language).toBe("hi");
  });

  it("C10: an idempotent replay returns the same operation and calls the model once", async () => {
    const { t, token } = await setup();
    const llm = stubLlm([GOOD_SUMMARY]);
    const meetingId = await endedMeetingWithTranscript(t, token);
    const key = { "idempotency-key": "summarize-1" };

    const first = await act(t, token, "meetings.generateSummary", { meetingId }, key);
    const replay = await act(t, token, "meetings.generateSummary", { meetingId }, key);
    expect(replay.status).toBe(202);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(replay.body!.operation.id).toBe(first.body!.operation.id);

    await settle(t);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(await all(t, "connector_operations")).toHaveLength(1);
  });

  it("402 plan_limit (aiSummary) is reported synchronously, before any operation exists", async () => {
    const { t, token } = await setup("starter");
    const llm = stubLlm([GOOD_SUMMARY]);
    const meetingId = await endedMeetingWithTranscript(t, token);
    const res = await act(t, token, "meetings.generateSummary", { meetingId });
    expect(res.status).toBe(402);
    expect(res.body!.error).toMatchObject({ code: "plan_limit", feature: "aiSummary" });
    expect(await all(t, "connector_operations")).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
  });

  it("412 when the meeting has no transcript; 404 for another organization's meeting", async () => {
    const { t, token } = await setup();
    stubLlm([GOOD_SUMMARY]);
    const empty = (await act(t, token, "meetings.create", { title: "Silent" })).body!.output.meeting.id;
    const noTranscript = await act(t, token, "meetings.generateSummary", { meetingId: empty });
    expect(noTranscript.status).toBe(412);
    expect(noTranscript.body!.error.code).toBe("precondition_failed");

    const theirs = await as(t, OUTSIDER).mutation(api.meetings.index.create, { orgId: OTHER_ORG, title: "Theirs" });
    expect((await act(t, token, "meetings.generateSummary", { meetingId: String(theirs) })).status).toBe(404);
    await settle(t);
  });

  it("C07: needs both summaries:read and meetings:write", async () => {
    const { t, token } = await setup("pro", "meetup:meetings:read meetup:meetings:write");
    const res = await act(t, token, "meetings.generateSummary", { meetingId: "x" });
    expect(res.status).toBe(403);
    expect(res.body!.error).toMatchObject({ code: "insufficient_scope", requiredScope: "meetup:summaries:read" });
  });

  it.each([
    ["the model returns HTTP 500", "http-500", /service error/i],
    ["the model returns unparseable output", "garbage", /invalid response/i],
    ["the model call times out", "timeout", /timed out/i],
  ] as const)("fails the operation cleanly when %s — nothing is half-written", async (_label, reply, message) => {
    const { t, token } = await setup();
    stubLlm([reply]);
    const meetingId = await endedMeetingWithTranscript(t, token);
    const accepted = await act(t, token, "meetings.generateSummary", { meetingId });
    const failed = await pollOperation(t, token, accepted.body!.operation.id);

    expect(failed.status).toBe("failed");
    expect(failed.error.code).toBe("upstream_failed");
    expect(failed.error.message).toMatch(message);
    expect(failed.output).toBeUndefined();
    expect((await getJson(t, token, `/meetings/${meetingId}/summary`)).status).toBe(404);
    expect((await getJson(t, token, `/tasks?meetingId=${meetingId}`)).body!.items).toEqual([]);
  });

  it("fails with 'unavailable' when summarization is not configured", async () => {
    const { t, token } = await setup();
    vi.stubEnv("GROQ_API_KEY", "");
    const meetingId = await endedMeetingWithTranscript(t, token);
    const accepted = await act(t, token, "meetings.generateSummary", { meetingId });
    const failed = await pollOperation(t, token, accepted.body!.operation.id);
    expect(failed).toMatchObject({ status: "failed", error: { code: "unavailable" } });
  });

  it("fails — without saving — when the connection is revoked while the model runs", async () => {
    const { t, token } = await setup();
    const llm = vi.fn(async () => {
      // The user cuts the connection while the model is still thinking.
      const grant = (await t.run((ctx) => ctx.db.query("connector_grants").collect()))[0];
      await as(t, HOST).mutation(api.connector.grants.revoke, { grantId: grant._id });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(GOOD_SUMMARY) } }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", llm);
    const meetingId = await endedMeetingWithTranscript(t, token);
    const accepted = await act(t, token, "meetings.generateSummary", { meetingId });
    await settle(t);
    expect(llm).toHaveBeenCalled();

    const meeting = await t.run((ctx) =>
      ctx.db
        .query("meeting_assets")
        .collect()
        .then((rows) => rows.filter((r) => r.type === "summary")),
    );
    expect(meeting).toHaveLength(0);
    const operation = (await all(t, "connector_operations")).find((o) => String(o._id) === accepted.body!.operation.id);
    expect(operation?.status).toBe("failed");
    expect(operation?.error?.code).toBe("unauthorized");
  });

  it("summarizes long meetings in parts, stores the chunks, then merges them", async () => {
    const { t, token } = await setup();
    const llm = stubLlm([GOOD_SUMMARY]);
    const meetingId = (await act(t, token, "meetings.create", { title: "Marathon" })).body!.output.meeting.id as string;
    await t.run(async (ctx) => {
      for (let i = 0; i < 900; i += 1) {
        await ctx.db.insert("transcripts", {
          meetingId: meetingId as Id<"meetings">,
          speakerId: "s",
          speakerName: "Hana Host",
          text: `utterance ${i}`,
          timestamp: i,
          createdAt: T0,
        });
      }
    });

    const accepted = await act(t, token, "meetings.generateSummary", { meetingId });
    const done = await pollOperation(t, token, accepted.body!.operation.id);
    expect(done.status).toBe("succeeded");

    // 900 lines → parts of 400, 400 and 100, then one merge call.
    expect(llm).toHaveBeenCalledTimes(4);
    const bodies = llm.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string));
    const userLines = (n: number) => bodies[n].messages[1].content.split("\n").filter((l: string) => l.startsWith("Hana Host:"));
    expect([userLines(0).length, userLines(1).length, userLines(2).length]).toEqual([400, 400, 100]);
    expect(bodies[0].messages[1].content).toContain("utterance 0");
    expect(bodies[2].messages[1].content).toContain("utterance 899");
    expect(bodies[3].messages[1].content).toContain("Part 1 of 3");

    const chunks = await t.run((ctx) => ctx.db.query("summary_chunks").collect());
    expect(chunks.map((c) => c.chunkIndex).sort()).toEqual([0, 1, 2]);
    expect(chunks[0].summary).toBe(GOOD_SUMMARY.summary);
  });
});

describe("operations", () => {
  async function started() {
    const { t, token } = await setup();
    stubLlm([GOOD_SUMMARY]);
    const meetingId = await endedMeetingWithTranscript(t, token);
    const accepted = await act(t, token, "meetings.generateSummary", { meetingId });
    return { t, token, id: accepted.body!.operation.id as string };
  }

  it("are owned by the grant that started them", async () => {
    const { t, token, id } = await started();
    expect((await getJson(t, token, `/operations/${id}`)).status).toBe(200);

    const { token: sameUserOtherGrant } = await connect(t, { scope: WRITE_SCOPES });
    expect((await getJson(t, sameUserOtherGrant, `/operations/${id}`)).status).toBe(404);
    const { token: otherOrg } = await connect(t, { who: OUTSIDER, orgId: OTHER_ORG, scope: WRITE_SCOPES });
    expect((await getJson(t, otherOrg, `/operations/${id}`)).status).toBe(404);
    expect((await getJson(t, token, "/operations/nonexistent")).status).toBe(404);
    await settle(t);
  });

  it("require the same scopes as the action that created them", async () => {
    const { t, token, id } = await started();
    await settle(t);
    expect((await getJson(t, token, `/operations/${id}`)).status).toBe(200);

    // The grant loses one of generateSummary's two scopes: the operation is no longer readable.
    const grant = (await t.run((ctx) => ctx.db.query("connector_grants").collect()))[0];
    await t.run((ctx) =>
      ctx.db.patch(grant._id, { scopes: grant.scopes.filter((s) => s !== "meetup:summaries:read") }),
    );
    const res = await getJson(t, token, `/operations/${id}`);
    expect(res.status).toBe(403);
    expect(res.body!.error).toMatchObject({
      code: "insufficient_scope",
      requiredScope: "meetup:summaries:read",
    });
  });

  it("are no longer served after 7 days", async () => {
    const { t, token, id } = await started();
    await settle(t);
    expect((await getJson(t, token, `/operations/${id}`)).status).toBe(200);

    // Jump past the retention window, keeping the token itself valid so only retention is tested.
    vi.setSystemTime(T0 + 8 * 86_400_000);
    const grant = (await t.run((ctx) => ctx.db.query("connector_grants").collect()))[0];
    await t.run((ctx) => ctx.db.patch(grant._id, { accessExpiresAt: Date.now() + 3_600_000 }));
    expect((await getJson(t, token, `/operations/${id}`)).status).toBe(404);
  });
});

describe("summary versions (shared save path)", () => {
  it("increase only when the saved content actually changes", async () => {
    const { t } = await setup();
    const meetingId = await as(t, HOST).mutation(api.meetings.index.create, { orgId: ORG, title: "M" });
    const save = (summary: string) =>
      as(t, HOST).mutation(api.meetings.index.saveSummary, { meetingId, summary, key_points: ["k"] });
    const version = async () =>
      (await t.run((ctx) => ctx.db.query("meeting_assets").collect()))[0].summaryVersion;

    await save("First");
    expect(await version()).toBe(1);
    await save("First"); // identical re-save from the browser
    expect(await version()).toBe(1);
    await save("Second");
    expect(await version()).toBe(2);
    await settle(t);
  });
});
