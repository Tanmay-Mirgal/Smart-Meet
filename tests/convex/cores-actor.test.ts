/**
 * The point of the Phase 2 refactor: the same business rules must run for a
 * caller that has NO Clerk identity (the connector path), driven by an Actor
 * resolved from a stored user.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrganizationPlanCore } from "../../convex/billing/index";
import { getGoogleCalendarConnectionCore } from "../../convex/integrations/index";
import { actorFromTokenIdentifier } from "../../convex/lib/actor";
import {
  createMeetingCore,
  endMeetingCore,
  getMeetingCore,
  saveSummaryCore,
} from "../../convex/meetings/index";
import { createTaskCore, listTasksCore } from "../../convex/tasks/index";
import { PlanLimitError, PreconditionError } from "../../convex/lib/errors";
import { normalizeError } from "../../convex/connector/errors";
import { HOST, MEMBER, ORG, OUTSIDER, newConvex, seedWorld } from "./fixtures";

const NOW = new Date("2026-03-01T10:00:00.000Z");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function actorOf(t: ReturnType<typeof newConvex>, who: { tokenIdentifier: string }) {
  const actor = await t.run((ctx) => actorFromTokenIdentifier(ctx, who.tokenIdentifier));
  if (!actor) throw new Error("missing test actor");
  return actor;
}

describe("actorFromTokenIdentifier", () => {
  it("resolves the stored user, matching what identity-based callers see", async () => {
    const t = newConvex();
    await seedWorld(t);
    expect(await actorOf(t, HOST)).toEqual({
      tokenIdentifier: HOST.tokenIdentifier,
      clerkId: HOST.subject,
      name: "Hana Host",
      email: "hana@example.com",
      imageUrl: `https://img.example.com/${HOST.subject}.png`,
      displayName: "Hana Host",
    });
    expect(
      await t.run((ctx) => actorFromTokenIdentifier(ctx, "https://clerk.test|ghost")),
    ).toBeNull();
  });
});

describe("cores run without any Clerk identity", () => {
  it("creates, reads and ends a meeting as the actor, with connector fields", async () => {
    const t = newConvex();
    await seedWorld(t, "pro");
    const host = await actorOf(t, HOST);

    const out = await t.run(async (ctx) => {
      // No ctx.auth identity exists here — only the Actor drives the rules.
      expect(await ctx.auth.getUserIdentity()).toBeNull();

      const meetingId = await createMeetingCore(ctx, host, {
        orgId: ORG,
        title: "Design review",
        purpose: "design-review",
        inviteEmails: ["new@example.com"],
        settings: { joinMode: "invite_only" }, // partial, defaults merge in
        createdVia: "connector",
        externalRef: { hubProjectId: "prj_1", hubRunId: "run_1" },
        metadataJson: '{"k":"v"}',
      });
      const view = await getMeetingCore(ctx, host, { meetingId });
      await endMeetingCore(ctx, host, { meetingId });
      return { meetingId, view, ended: await ctx.db.get(meetingId) };
    });

    expect(out.view).toMatchObject({
      title: "Design review",
      purpose: "design-review",
      status: "active",
      createdVia: "connector",
      externalRef: { hubProjectId: "prj_1", hubRunId: "run_1" },
      metadataJson: '{"k":"v"}',
      settings: { joinMode: "invite_only", allowChat: true },
      hostUserTokenIdentifier: HOST.tokenIdentifier,
      creatorName: "Hana Host",
    });
    expect(out.ended?.status).toBe("ended");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("keeps host-only rules: a non-host actor cannot end the meeting", async () => {
    const t = newConvex();
    await seedWorld(t);
    const [host, member] = [await actorOf(t, HOST), await actorOf(t, MEMBER)];
    const meetingId = await t.run((ctx) =>
      createMeetingCore(ctx, host, { orgId: ORG, title: "Standup" }),
    );

    const failure = await t
      .run((ctx) => endMeetingCore(ctx, member, { meetingId }))
      .catch((error: unknown) => error);
    expect(normalizeError(failure)).toMatchObject({ code: "forbidden", status: 403 });
    expect((failure as Error).message).toBe("Only the host can perform this action");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("enforces tenant isolation for an actor from another org", async () => {
    const t = newConvex();
    await seedWorld(t);
    const [host, outsider] = [await actorOf(t, HOST), await actorOf(t, OUTSIDER)];
    const meetingId = await t.run((ctx) => createMeetingCore(ctx, host, { orgId: ORG, title: "x" }));

    await expect(t.run((ctx) => getMeetingCore(ctx, outsider, { meetingId }))).rejects.toThrow("Forbidden");
    await expect(
      t.run((ctx) => createMeetingCore(ctx, outsider, { orgId: ORG, title: "y" })),
    ).rejects.toThrow("Forbidden");
    await expect(t.run((ctx) => listTasksCore(ctx, outsider, { orgId: ORG }))).rejects.toThrow("Forbidden");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("shares task rules with the UI path", async () => {
    const t = newConvex();
    await seedWorld(t);
    const host = await actorOf(t, HOST);
    const taskId = await t.run((ctx) =>
      createTaskCore(ctx, host, { orgId: ORG, title: "Ship", assigneeTokenIdentifier: MEMBER.tokenIdentifier }),
    );
    const tasks = await t.run((ctx) => listTasksCore(ctx, host, { orgId: ORG }));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ _id: taskId, assigneeName: "Mia Member" });
  });
});

describe("typed errors keep the UI's exact messages", () => {
  it("meeting cap → PlanLimitError{limit, feature}", async () => {
    const t = newConvex();
    await seedWorld(t, { maxMeetings: 1 });
    const host = await actorOf(t, HOST);
    await t.run((ctx) => createMeetingCore(ctx, host, { orgId: ORG, title: "one" }));

    const error = await t
      .run((ctx) => createMeetingCore(ctx, host, { orgId: ORG, title: "two" }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlanLimitError);
    expect((error as Error).message).toBe(
      "This workspace has reached its 1-meeting limit. Upgrade the plan to create more meetings.",
    );
    expect(normalizeError(error)).toMatchObject({
      code: "plan_limit",
      status: 402,
      extras: { limit: 1, feature: "maxMeetings" },
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("summary without aiSummary → plan_limit{feature: aiSummary}", async () => {
    const t = newConvex();
    await seedWorld(t);
    const host = await actorOf(t, HOST);
    const meetingId = await t.run((ctx) => createMeetingCore(ctx, host, { orgId: ORG, title: "m" }));
    const error = await t
      .run((ctx) => saveSummaryCore(ctx, host, { meetingId, summary: "s" }))
      .catch((e: unknown) => e);
    expect(normalizeError(error)).toMatchObject({
      code: "plan_limit",
      extras: { feature: "aiSummary" },
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("calendar sync without a Google connection → precondition_failed with fixUrl", async () => {
    const t = newConvex();
    await seedWorld(t, "pro");
    const host = await actorOf(t, HOST);
    const error = await t
      .run((ctx) =>
        createMeetingCore(ctx, host, {
          orgId: ORG,
          title: "m",
          scheduledFor: NOW.getTime() + 3_600_000,
          syncWithGoogleCalendar: true,
        }),
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreconditionError);
    expect(normalizeError(error)).toMatchObject({
      code: "precondition_failed",
      status: 412,
      extras: { fixUrl: "/integrations" },
    });
  });

  it("invalid times → validation_failed with the offending field", async () => {
    const t = newConvex();
    await seedWorld(t);
    const host = await actorOf(t, HOST);
    const error = await t
      .run((ctx) =>
        createMeetingCore(ctx, host, {
          orgId: ORG,
          title: "m",
          scheduledFor: NOW.getTime() + 7_200_000,
          scheduledEndsAt: NOW.getTime() + 3_600_000,
        }),
      )
      .catch((e: unknown) => e);
    expect(normalizeError(error)).toMatchObject({
      code: "validation_failed",
      details: [{ path: "scheduledEndsAt", message: "Meeting end time must be after the start time" }],
    });
  });
});

describe("plan and Google cores", () => {
  it("getOrganizationPlanCore matches the public query and guards org access", async () => {
    const t = newConvex();
    await seedWorld(t, "pro");
    const [host, outsider] = [await actorOf(t, HOST), await actorOf(t, OUTSIDER)];
    const plan = await t.run((ctx) => getOrganizationPlanCore(ctx, host, ORG));
    expect(plan).toMatchObject({ planKey: "pro", features: { aiSummary: true } });
    await expect(t.run((ctx) => getOrganizationPlanCore(ctx, outsider, ORG))).rejects.toThrow("Forbidden");
  });

  it("the Google connection core never returns provider tokens", async () => {
    const t = newConvex();
    await seedWorld(t);
    await t.run((ctx) =>
      ctx.db.insert("user_integrations", {
        userTokenIdentifier: HOST.tokenIdentifier,
        provider: "google_calendar",
        accountEmail: "hana@gmail.test",
        accessToken: "ya29.SUPER-SECRET-ACCESS",
        refreshToken: "1//SUPER-SECRET-REFRESH",
        scope: ["calendar"],
        tokenExpiresAt: Date.now() + 3_600_000,
        status: "connected",
        connectedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const host = await actorOf(t, HOST);
    const connection = await t.run((ctx) => getGoogleCalendarConnectionCore(ctx, host, ORG));
    expect(connection).toMatchObject({ connected: true, accountEmail: "hana@gmail.test", hasRefreshToken: true });
    expect(JSON.stringify(connection)).not.toMatch(/SUPER-SECRET/);
  });
});
