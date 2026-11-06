import { convexTest } from "convex-test";
import schema from "../../convex/schema";
import { modules } from "./helpers";

export const ISSUER = "https://clerk.test";
export const ORG = "org_acme";
export const OTHER_ORG = "org_other";

export type TestUser = {
  subject: string;
  tokenIdentifier: string;
  name: string;
  email: string;
  firstName: string;
  lastName: string;
  orgId: string;
};

function user(subject: string, first: string, last: string, orgId: string): TestUser {
  return {
    subject,
    tokenIdentifier: `${ISSUER}|${subject}`,
    name: `${first} ${last}`,
    email: `${first.toLowerCase()}@example.com`,
    firstName: first,
    lastName: last,
    orgId,
  };
}

export const HOST = user("user_host", "Hana", "Host", ORG);
export const MEMBER = user("user_member", "Mia", "Member", ORG);
export const OUTSIDER = user("user_outsider", "Otto", "Outsider", OTHER_ORG);

export function newConvex() {
  return convexTest(schema, modules);
}

/** Schema-typed test client (keeps `ctx.db` index names type-checked in `t.run`). */
export type TestConvex = ReturnType<typeof newConvex>;

/** Acts as `who` — a Clerk-authenticated user, exactly as the browser would. */
export function as(t: TestConvex, who: TestUser) {
  return t.withIdentity({
    subject: who.subject,
    issuer: ISSUER,
    tokenIdentifier: who.tokenIdentifier,
    name: who.name,
    email: who.email,
    pictureUrl: `https://img.example.com/${who.subject}.png`,
  });
}

export type PlanSeed =
  | "starter" // no snapshot → default Starter plan (10 meetings, no paid features)
  | "pro" // unlimited meetings, every feature
  | { maxMeetings: number }; // paid-feature-less plan with a custom meeting cap

/** Two members of ORG, one outsider in OTHER_ORG, plus an optional billing snapshot. */
export async function seedWorld(t: TestConvex, plan: PlanSeed = "starter") {
  await t.run(async (ctx) => {
    for (const u of [HOST, MEMBER, OUTSIDER]) {
      await ctx.db.insert("users", {
        tokenIdentifier: u.tokenIdentifier,
        clerkId: u.subject,
        email: u.email,
        fullName: u.name,
        firstName: u.firstName,
        lastName: u.lastName,
        imageUrl: `https://img.example.com/${u.subject}.png`,
        orgIds: [u.orgId],
      });
      await ctx.db.insert("user_org_memberships", {
        userTokenIdentifier: u.tokenIdentifier,
        orgId: u.orgId,
      });
    }

    await ctx.db.insert("organizations", { clerkId: ORG, name: "Acme", slug: "acme" });
    await ctx.db.insert("organizations", { clerkId: OTHER_ORG, name: "Other", slug: "other" });

    if (plan === "starter") return;

    const features =
      plan === "pro"
        ? { unlimitedMeetings: true, aiSummary: true, notionExport: true, recording: true, googleCalendarSync: true }
        : { unlimitedMeetings: false, aiSummary: false, notionExport: false, recording: false, googleCalendarSync: false };

    await ctx.db.insert("organization_billing_snapshots", {
      orgId: ORG,
      planKey: plan === "pro" ? "pro" : "custom",
      planName: plan === "pro" ? "Pro" : "Custom",
      maxMeetings: plan === "pro" ? null : plan.maxMeetings,
      features,
      syncedAt: Date.now(),
      expiresAt: plan === "pro" ? Date.now() + 30 * 86_400_000 : undefined,
      updatedByTokenIdentifier: HOST.tokenIdentifier,
    });
  });
}
