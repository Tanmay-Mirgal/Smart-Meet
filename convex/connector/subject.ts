import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getCurrentUserRecord } from "../lib/auth";

type Ctx = QueryCtx | MutationCtx;

export type TenantInfo = { id: string; name: string; kind: "organization" };
export type UserInfo = { id: string; email: string | null; name: string };

/** Tenant = Clerk organization. The org row only exists once Clerk's webhook has synced it. */
export async function getTenantInfo(ctx: Ctx, orgId: string): Promise<TenantInfo> {
  const organization = await ctx.db
    .query("organizations")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", orgId))
    .unique();
  return { id: orgId, name: organization?.name ?? "Workspace", kind: "organization" };
}

export async function getUserInfo(ctx: Ctx, tokenIdentifier: string): Promise<UserInfo> {
  const user = await getCurrentUserRecord(ctx, tokenIdentifier);
  const name =
    user?.fullName?.trim() ||
    [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() ||
    user?.email ||
    "Meetup User";
  return {
    id: user ? String(user._id) : tokenIdentifier,
    email: user?.email?.trim() || null,
    name,
  };
}
