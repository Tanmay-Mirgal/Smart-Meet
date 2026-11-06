/**
 * Phase 2 safety net: pins the observable behaviour of the public Convex
 * functions that were refactored into actor-aware "core" helpers. These tests
 * only use the public API (`api.*`), so they were run against the code BEFORE
 * the refactor and must give identical results AFTER it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
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

const NOW = new Date("2026-03-01T10:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function settle(t: TestConvex) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function createInstant(t: TestConvex, extra: Record<string, unknown> = {}) {
  return await as(t, HOST).mutation(api.meetings.index.create, {
    orgId: ORG,
    title: "Standup",
    ...extra,
  });
}

/** Host joins their own meeting so meeting-level permissions apply (as in the UI). */
async function hostJoins(t: TestConvex, meetingId: Id<"meetings">) {
  await as(t, HOST).mutation(api.participants.index.join, { meetingId });
}

const SUMMARY = {
  summary: "## Overview\nWe agreed to ship.",
  key_points: ["Ship Friday"],
  decisions: ["Use Convex"],
  action_items: [{ task: "Write docs", assignee: "Mia Member", due: null }],
};

describe("billing.getOrganizationPlan", () => {
  it("returns the default Starter plan when no snapshot exists", async () => {
    const t = newConvex();
    await seedWorld(t);
    expect(await as(t, HOST).query(api.billing.index.getOrganizationPlan, { orgId: ORG })).toEqual({
      planKey: "starter",
      planName: "Starter",
      maxMeetings: 10,
      features: {
        unlimitedMeetings: false,
        aiSummary: false,
        notionExport: false,
        recording: false,
        googleCalendarSync: false,
      },
      usage: { meetingsUsed: 0, meetingsRemaining: 10, meetingsLimitReached: false },
      syncedAt: null,
      expiresAt: null,
    });
  });

  it("reflects a Pro snapshot and live meeting usage", async () => {
    const t = newConvex();
    await seedWorld(t, "pro");
    const plan = await as(t, HOST).query(api.billing.index.getOrganizationPlan, { orgId: ORG });
    expect(plan).toMatchObject({
      planKey: "pro",
      maxMeetings: null,
      features: { aiSummary: true, recording: true, googleCalendarSync: true },
      usage: { meetingsUsed: 0, meetingsRemaining: null, meetingsLimitReached: false },
    });
    expect(plan.syncedAt).toBe(NOW.getTime());
    expect(plan.expiresAt).toBe(NOW.getTime() + 30 * 86_400_000);
  });

  it("counts meetings against a custom cap", async () => {
    const t = newConvex();
    await seedWorld(t, { maxMeetings: 1 });
    await createInstant(t);
    expect(
      (await as(t, HOST).query(api.billing.index.getOrganizationPlan, { orgId: ORG })).usage,
    ).toEqual({ meetingsUsed: 1, meetingsRemaining: 0, meetingsLimitReached: true });
  });

  it("rejects outsiders and anonymous callers", async () => {
    const t = newConvex();
    await seedWorld(t);
    await expect(
      as(t, OUTSIDER).query(api.billing.index.getOrganizationPlan, { orgId: ORG }),
    ).rejects.toThrow("Forbidden");
    await expect(t.query(api.billing.index.getOrganizationPlan, { orgId: ORG })).rejects.toThrow(
      "Unauthenticated",
    );
  });
});

describe("meetings.create", () => {
  it("creates an instant meeting with host, invites and org notifications", async () => {
    const t = newConvex();
    await seedWorld(t);
    const id = await createInstant(t, { inviteEmails: ["Ann@Example.com", "ann@example.com"] });

    const snapshot = await t.run(async (ctx) => ({
      meeting: await ctx.db.get(id),
      participants: await ctx.db
        .query("meeting_participants")
        .withIndex("by_meetingId_and_status", (q) => q.eq("meetingId", id))
        .collect(),
      invites: await ctx.db
        .query("meeting_invites")
        .withIndex("by_meetingId", (q) => q.eq("meetingId", id))
        .collect(),
      notifications: (await ctx.db.query("notifications").collect()).filter((n) => n.link === `/meeting/${id}`),
    }));

    expect(snapshot.meeting).toMatchObject({
      orgId: ORG,
      title: "Standup",
      purpose: "Standup",
      status: "active",
      isLocked: false,
      creatorName: "Hana Host",
      creatorClerkId: HOST.subject,
      creatorTokenIdentifier: HOST.tokenIdentifier,
      hostUserTokenIdentifier: HOST.tokenIdentifier,
      hostClerkId: HOST.subject,
      startedAt: NOW.getTime(),
      lastActivityAt: NOW.getTime(),
      settings: { joinMode: "organization_only", allowChat: true, lobbyEnabled: false },
    });
    expect(snapshot.meeting?.scheduledFor).toBeUndefined();

    expect(snapshot.participants).toHaveLength(1);
    expect(snapshot.participants[0]).toMatchObject({
      role: "host",
      status: "left",
      name: "Hana Host",
      userTokenIdentifier: HOST.tokenIdentifier,
      imageUrl: `https://img.example.com/${HOST.subject}.png`,
    });

    expect(snapshot.invites).toHaveLength(1);
    expect(snapshot.invites[0]).toMatchObject({
      email: "ann@example.com",
      role: "participant",
      status: "pending",
      invitedByName: "Hana Host",
      orgId: ORG,
    });

    expect(snapshot.notifications.map((n) => n.userTokenIdentifier).sort()).toEqual(
      [HOST.tokenIdentifier, MEMBER.tokenIdentifier].sort(),
    );
    expect(snapshot.notifications[0].message).toBe("Hana Host started Standup");
    await settle(t);
  });

  it("schedules a future meeting and says so in the notification", async () => {
    const t = newConvex();
    await seedWorld(t);
    const id = await createInstant(t, {
      title: "Planning",
      purpose: "planning",
      description: "Q2",
      scheduledFor: NOW.getTime() + 3_600_000,
      scheduledEndsAt: NOW.getTime() + 7_200_000,
      scheduledTimeZone: "Asia/Kolkata",
    });
    const meeting = await as(t, HOST).query(api.meetings.index.get, { meetingId: id });
    expect(meeting).toMatchObject({
      status: "scheduled",
      purpose: "planning",
      description: "Q2",
      scheduledTimeZone: "Asia/Kolkata",
    });
    expect(meeting.startedAt).toBeUndefined();
    const notes = await t.run(async (ctx) => ctx.db.query("notifications").collect());
    expect(notes.every((n) => n.message === "New meeting scheduled: Planning")).toBe(true);
    await settle(t);
  });

  it.each([
    [
      "end before start",
      { scheduledFor: NOW.getTime() + 7_200_000, scheduledEndsAt: NOW.getTime() + 3_600_000 },
      "Meeting end time must be after the start time",
    ],
    [
      "calendar sync on an instant meeting",
      { syncWithGoogleCalendar: true },
      "Google Calendar sync is only available for scheduled meetings",
    ],
    [
      "calendar sync on the Starter plan",
      { syncWithGoogleCalendar: true, scheduledFor: NOW.getTime() + 3_600_000 },
      "Google Calendar sync is only available on paid workspace plans",
    ],
  ])("rejects %s", async (_label, extra, message) => {
    const t = newConvex();
    await seedWorld(t);
    await expect(createInstant(t, extra)).rejects.toThrow(message);
  });

  it("requires the Google Calendar connection on paid plans", async () => {
    const t = newConvex();
    await seedWorld(t, "pro");
    await expect(
      createInstant(t, { syncWithGoogleCalendar: true, scheduledFor: NOW.getTime() + 3_600_000 }),
    ).rejects.toThrow("Connect Google Calendar before enabling calendar sync");
  });

  it("enforces the plan's meeting cap with the exact upgrade message", async () => {
    const t = newConvex();
    await seedWorld(t, { maxMeetings: 1 });
    await createInstant(t);
    await expect(createInstant(t, { title: "Second" })).rejects.toThrow(
      "This workspace has reached its 1-meeting limit. Upgrade the plan to create more meetings.",
    );
  });

  it("rejects outsiders and anonymous callers", async () => {
    const t = newConvex();
    await seedWorld(t);
    await expect(
      as(t, OUTSIDER).mutation(api.meetings.index.create, { orgId: ORG, title: "x" }),
    ).rejects.toThrow("Forbidden");
    await expect(t.mutation(api.meetings.index.create, { orgId: ORG, title: "x" })).rejects.toThrow(
      "Unauthenticated",
    );
  });
});

describe("meetings.get", () => {
  it("returns the host's view of a freshly created meeting", async () => {
    const t = newConvex();
    await seedWorld(t);
    const id = await createInstant(t);
    const view = await as(t, HOST).query(api.meetings.index.get, { meetingId: id });
    expect(view).toMatchObject({
      _id: id,
      title: "Standup",
      status: "active",
      activeParticipants: 0,
      waitingParticipants: 0,
      summary: null,
      key_points: [],
      decisions: [],
      action_items: [],
      isOrgMember: true,
      isInvited: false,
      joinDecision: { status: "joined", reason: null },
      currentParticipant: { role: "host", status: "left" },
      settings: { joinMode: "organization_only" },
    });
    expect(Object.values(view.effectivePermissions).every((v) => v === false)).toBe(true);
    expect(view.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("shows an org member no participant but a join decision", async () => {
    const t = newConvex();
    await seedWorld(t);
    const id = await createInstant(t);
    const view = await as(t, MEMBER).query(api.meetings.index.get, { meetingId: id });
    expect(view.currentParticipant).toBeNull();
    expect(view.joinDecision).toEqual({ status: "joined", reason: null });
    expect(view.isOrgMember).toBe(true);
  });

  it("hides the meeting from outsiders", async () => {
    const t = newConvex();
    await seedWorld(t);
    const id = await createInstant(t);
    await expect(as(t, OUTSIDER).query(api.meetings.index.get, { meetingId: id })).rejects.toThrow(
      "Forbidden",
    );
  });

  it("includes the saved summary", async () => {
    const t = newConvex();
    await seedWorld(t, "pro");
    const id = await createInstant(t);
    await as(t, HOST).mutation(api.meetings.index.saveSummary, { meetingId: id, ...SUMMARY });
    const view = await as(t, MEMBER).query(api.meetings.index.get, { meetingId: id });
    expect(view.summary).toBe(SUMMARY.summary);
    expect(view.key_points).toEqual(SUMMARY.key_points);
    expect(view.decisions).toEqual(SUMMARY.decisions);
    expect(view.action_items).toEqual(SUMMARY.action_items);
  });
});

describe("meetings.endMeeting", () => {
  it("is host-only", async () => {
    const t = newConvex();
    await seedWorld(t);
    const id = await createInstant(t);
    await expect(
      as(t, MEMBER).mutation(api.meetings.index.endMeeting, { meetingId: id }),
    ).rejects.toThrow("Only the host can perform this action");
    await expect(
      as(t, OUTSIDER).mutation(api.meetings.index.endMeeting, { meetingId: id }),
    ).rejects.toThrow("Forbidden");
  });

  it("ends the meeting, audits it and clears its notifications", async () => {
    const t = newConvex();
    await seedWorld(t);
    const id = await createInstant(t);
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    await as(t, HOST).mutation(api.meetings.index.endMeeting, { meetingId: id });
    await settle(t);

    const after = await t.run(async (ctx) => ({
      meeting: await ctx.db.get(id),
      audit: await ctx.db
        .query("meeting_audit_logs")
        .withIndex("by_meetingId_and_createdAt", (q) => q.eq("meetingId", id))
        .collect(),
      unread: (await ctx.db.query("notifications").collect()).filter((n) => !n.isRead),
    }));
    expect(after.meeting).toMatchObject({
      status: "ended",
      endedAt: NOW.getTime() + 60_000,
      lastActivityAt: NOW.getTime() + 60_000,
    });
    expect(after.audit.map((a) => a.action)).toContain("meeting_ended");
    expect(after.audit.find((a) => a.action === "meeting_ended")?.actorName).toBe("Hana Host");
    expect(after.unread).toHaveLength(0);
  });
});

describe("meetings.saveSummary / getSummary", () => {
  it("is blocked on plans without aiSummary", async () => {
    const t = newConvex();
    await seedWorld(t);
    const id = await createInstant(t);
    await expect(
      as(t, HOST).mutation(api.meetings.index.saveSummary, { meetingId: id, ...SUMMARY }),
    ).rejects.toThrow("AI summaries are only available on paid workspace plans");
  });

  it("creates then updates the single summary asset", async () => {
    const t = newConvex();
    await seedWorld(t, "pro");
    const id = await createInstant(t);
    await as(t, HOST).mutation(api.meetings.index.saveSummary, { meetingId: id, ...SUMMARY });
    const first = await as(t, MEMBER).query(api.meetings.index.getSummary, { meetingId: id });
    expect(first).toMatchObject({
      type: "summary",
      content: SUMMARY.summary,
      key_points: SUMMARY.key_points,
      decisions: SUMMARY.decisions,
      action_items: SUMMARY.action_items,
      updatedAt: NOW.getTime(),
    });

    await as(t, HOST).mutation(api.meetings.index.saveSummary, {
      meetingId: id,
      summary: "Revised",
    });
    const second = await as(t, MEMBER).query(api.meetings.index.getSummary, { meetingId: id });
    expect(second?._id).toBe(first?._id);
    expect(second?.content).toBe("Revised");
    expect(second?.key_points).toBeUndefined();
  });

  it("returns null before any summary and hides it from outsiders", async () => {
    const t = newConvex();
    await seedWorld(t, "pro");
    const id = await createInstant(t);
    expect(await as(t, HOST).query(api.meetings.index.getSummary, { meetingId: id })).toBeNull();
    await expect(
      as(t, OUTSIDER).query(api.meetings.index.getSummary, { meetingId: id }),
    ).rejects.toThrow("Forbidden");
  });
});

describe("meetings.inviteParticipants", () => {
  it("needs meeting permissions, then invites each address once", async () => {
    const t = newConvex();
    await seedWorld(t);
    const id = await createInstant(t);

    await expect(
      as(t, MEMBER).mutation(api.meetings.index.inviteParticipants, {
        meetingId: id,
        emails: ["bob@example.com"],
      }),
    ).rejects.toThrow("You do not have permission to invite people");

    await hostJoins(t, id);
    const inserted = await as(t, HOST).mutation(api.meetings.index.inviteParticipants, {
      meetingId: id,
      emails: ["Bob@Example.com", "bob@example.com", "cy@example.com"],
      role: "viewer",
    });
    expect(inserted.sort()).toEqual(["bob@example.com", "cy@example.com"]);

    expect(
      await as(t, HOST).mutation(api.meetings.index.inviteParticipants, {
        meetingId: id,
        emails: ["bob@example.com"],
      }),
    ).toEqual([]);

    const after = await t.run(async (ctx) => ({
      invites: await ctx.db
        .query("meeting_invites")
        .withIndex("by_meetingId", (q) => q.eq("meetingId", id))
        .collect(),
      audit: await ctx.db
        .query("meeting_audit_logs")
        .withIndex("by_meetingId_and_createdAt", (q) => q.eq("meetingId", id))
        .collect(),
    }));
    expect(after.invites.map((i) => [i.email, i.role]).sort()).toEqual([
      ["bob@example.com", "viewer"],
      ["cy@example.com", "viewer"],
    ]);
    const invited = after.audit.find((a) => a.action === "participants_invited");
    expect(invited?.metadata).toBe(JSON.stringify({ count: 2, role: "viewer" }));
    await settle(t);
  });
});

describe("tasks", () => {
  async function world() {
    const t = newConvex();
    await seedWorld(t);
    const meetingId = await createInstant(t);
    return { t, meetingId };
  }

  it("creates, assigns and lists manual tasks", async () => {
    const { t, meetingId } = await world();
    const taskId = await as(t, HOST).mutation(api.tasks.index.create, {
      orgId: ORG,
      meetingId,
      title: "Write docs",
      assigneeTokenIdentifier: MEMBER.tokenIdentifier,
      dueAt: NOW.getTime() + 86_400_000,
    });
    const listed = await as(t, MEMBER).query(api.tasks.index.list, { orgId: ORG });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      _id: taskId,
      title: "Write docs",
      status: "open",
      source: "manual",
      meetingId,
      assigneeName: "Mia Member",
      assigneeTokenIdentifier: MEMBER.tokenIdentifier,
      dueAt: NOW.getTime() + 86_400_000,
      createdAt: NOW.getTime(),
    });
    expect(await as(t, MEMBER).query(api.tasks.index.list, { orgId: ORG, status: "done" })).toEqual([]);
    expect(await as(t, MEMBER).query(api.tasks.index.listByMeeting, { meetingId })).toHaveLength(1);
    await settle(t);
  });

  it("rejects assignees from another org and outsiders", async () => {
    const { t, meetingId } = await world();
    await expect(
      as(t, HOST).mutation(api.tasks.index.create, {
        orgId: ORG,
        title: "x",
        assigneeTokenIdentifier: OUTSIDER.tokenIdentifier,
      }),
    ).rejects.toThrow("Assignee must belong to this workspace");
    await expect(
      as(t, OUTSIDER).mutation(api.tasks.index.create, { orgId: ORG, title: "x" }),
    ).rejects.toThrow("Forbidden");
    await expect(
      as(t, OUTSIDER).mutation(api.tasks.index.create, { orgId: OTHER_ORG, title: "x", meetingId }),
    ).rejects.toThrow("Forbidden");
    await settle(t);
  });

  it("creates tasks from a summary, matching assignees and de-duplicating titles", async () => {
    const { t, meetingId } = await world();
    const items = [
      { title: "Ship it", assigneeName: "mia member" },
      { title: "  ship IT  " },
      { title: "Call vendor", assigneeName: "Zed Unknown" },
      { title: "   " },
    ];
    const created = await as(t, HOST).mutation(api.tasks.index.createFromSummary, {
      orgId: ORG,
      meetingId,
      actionItems: items,
    });
    expect(created).toHaveLength(2);

    const tasks = await as(t, HOST).query(api.tasks.index.listByMeeting, { meetingId });
    const byTitle = Object.fromEntries(tasks.map((task) => [task.title, task]));
    expect(byTitle["Ship it"]).toMatchObject({
      source: "summary",
      assigneeName: "Mia Member",
      assigneeTokenIdentifier: MEMBER.tokenIdentifier,
    });
    expect(byTitle["Ship it"].suggestedAssigneeName).toBeUndefined();
    expect(byTitle["Call vendor"]).toMatchObject({ suggestedAssigneeName: "Zed Unknown" });
    expect(byTitle["Call vendor"].assigneeTokenIdentifier).toBeUndefined();

    expect(
      await as(t, HOST).mutation(api.tasks.index.createFromSummary, {
        orgId: ORG,
        meetingId,
        actionItems: items,
      }),
    ).toEqual([]);
    expect(
      await as(t, HOST).mutation(api.tasks.index.createFromSummary, {
        orgId: ORG,
        meetingId,
        actionItems: [],
      }),
    ).toEqual([]);
    await settle(t);
  });

  it("updates status, completion metadata and assignee", async () => {
    const { t, meetingId } = await world();
    const taskId = await as(t, HOST).mutation(api.tasks.index.create, {
      orgId: ORG,
      meetingId,
      title: "Ship it",
    });

    vi.setSystemTime(new Date(NOW.getTime() + 5_000));
    await as(t, MEMBER).mutation(api.tasks.index.updateTask, {
      taskId,
      status: "done",
      assigneeTokenIdentifier: MEMBER.tokenIdentifier,
    });
    let task = (await as(t, HOST).query(api.tasks.index.list, { orgId: ORG, status: "done" }))[0];
    expect(task).toMatchObject({
      _id: taskId,
      status: "done",
      completedAt: NOW.getTime() + 5_000,
      completedByName: "Mia Member",
      completedByTokenIdentifier: MEMBER.tokenIdentifier,
      assigneeName: "Mia Member",
      updatedAt: NOW.getTime() + 5_000,
    });

    await as(t, HOST).mutation(api.tasks.index.updateTask, {
      taskId,
      status: "in_progress",
      assigneeTokenIdentifier: null,
    });
    task = (await as(t, HOST).query(api.tasks.index.list, { orgId: ORG, status: "in_progress" }))[0];
    expect(task.status).toBe("in_progress");
    expect(task.completedAt).toBeUndefined();
    expect(task.completedByName).toBeUndefined();
    expect(task.assigneeTokenIdentifier).toBeUndefined();

    await expect(
      as(t, OUTSIDER).mutation(api.tasks.index.updateTask, { taskId, status: "open" }),
    ).rejects.toThrow("Forbidden");
    await settle(t);
  });

  it("lists org members sorted by name", async () => {
    const { t } = await world();
    const members = await as(t, HOST).query(api.tasks.index.listOrgMembers, { orgId: ORG });
    expect(members).toEqual([
      { tokenIdentifier: HOST.tokenIdentifier, name: "Hana Host", email: HOST.email },
      { tokenIdentifier: MEMBER.tokenIdentifier, name: "Mia Member", email: MEMBER.email },
    ]);
    await settle(t);
  });
});

describe("transcripts.list", () => {
  it("returns segments in spoken order for people who can see the meeting", async () => {
    const t = newConvex();
    await seedWorld(t);
    const id = await createInstant(t);
    await as(t, HOST).mutation(api.transcripts.index.add, { meetingId: id, text: "second", timestamp: 20 });
    await as(t, HOST).mutation(api.transcripts.index.add, { meetingId: id, text: "first", timestamp: 10 });
    await as(t, MEMBER).mutation(api.transcripts.index.addBatch, {
      meetingId: id,
      entries: [{ text: "  third  ", timestamp: 30 }, { text: "   ", timestamp: 31 }],
    });

    const list = await as(t, MEMBER).query(api.transcripts.index.list, { meetingId: id });
    expect(list.map((s) => [s.text, s.speakerName, s.timestamp])).toEqual([
      ["first", "Hana Host", 10],
      ["second", "Hana Host", 20],
      ["third", "Mia Member", 30],
    ]);
    await expect(
      as(t, OUTSIDER).query(api.transcripts.index.list, { meetingId: id }),
    ).rejects.toThrow("Forbidden");
    await settle(t);
  });
});

describe("recordings.listByMeeting", () => {
  it("lists newest first, keeping stored playback URLs when there is no storage file", async () => {
    const t = newConvex();
    await seedWorld(t);
    const id = await createInstant(t);
    expect(await as(t, MEMBER).query(api.recordings.index.listByMeeting, { meetingId: id })).toEqual([]);

    await t.run(async (ctx) => {
      for (const [n, status] of [[1, "ready"], [2, "failed"]] as const) {
        await ctx.db.insert("meeting_recordings", {
          meetingId: id,
          orgId: ORG,
          ownerTokenIdentifier: HOST.tokenIdentifier,
          startedAt: n,
          status,
          playbackUrl: `https://cdn.example.com/${n}.webm`,
          createdAt: n,
          updatedAt: n,
        });
      }
    });
    const list = await as(t, MEMBER).query(api.recordings.index.listByMeeting, { meetingId: id });
    expect(list.map((r) => [r.status, r.playbackUrl])).toEqual([
      ["failed", "https://cdn.example.com/2.webm"],
      ["ready", "https://cdn.example.com/1.webm"],
    ]);
    await expect(
      as(t, OUTSIDER).query(api.recordings.index.listByMeeting, { meetingId: id }),
    ).rejects.toThrow("Forbidden");
    await settle(t);
  });
});

describe("insights.get", () => {
  it("summarises the org's meetings", async () => {
    const t = newConvex();
    await seedWorld(t);
    const first = await createInstant(t, { title: "One" });
    await createInstant(t, { title: "Two" });
    await as(t, HOST).mutation(api.meetings.index.endMeeting, { meetingId: first });

    const insights = await as(t, MEMBER).query(api.insights.index.get, { orgId: ORG });
    expect(insights.totals).toEqual({ meetings: 2, active: 1, ended: 1 });
    expect(insights.timeline.map((e) => [e.title, e.status]).sort()).toEqual([
      ["One", "ended"],
      ["Two", "active"],
    ]);
    await expect(as(t, OUTSIDER).query(api.insights.index.get, { orgId: ORG })).rejects.toThrow(
      "Forbidden",
    );
    await settle(t);
  });
});
