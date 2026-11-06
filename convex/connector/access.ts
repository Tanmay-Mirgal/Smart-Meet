import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Actor } from "../lib/actor";
import { assertMeetingAccess } from "../lib/auth";
import { notFound, toConvexError } from "./errors";

type Ctx = QueryCtx | MutationCtx;

/** Throws a CP1 404. Foreign, malformed and missing ids are deliberately identical. */
export function missing(what: string): never {
  throw toConvexError(notFound(`${what} not found`));
}

/**
 * Resolves a caller-supplied meeting id inside the grant's tenant. An id from
 * another organization, a malformed id and a deleted id all produce the same
 * 404 (never 403), so ids cannot be probed across tenants.
 */
export async function loadMeetingInOrg(
  ctx: Ctx,
  grant: Doc<"connector_grants">,
  actor: Actor,
  rawId: string,
): Promise<Doc<"meetings">> {
  const id = ctx.db.normalizeId("meetings", rawId);
  const meeting = id ? await ctx.db.get(id) : null;
  if (!meeting || meeting.orgId !== grant.orgId) return missing("Meeting");
  // The rule the UI applies. For an org member it always passes, but keeping
  // it here means a future stricter rule applies to the connector too.
  await assertMeetingAccess(ctx, actor.tokenIdentifier, meeting._id);
  return meeting;
}

export async function loadTaskInOrg(
  ctx: Ctx,
  grant: Doc<"connector_grants">,
  rawId: string,
): Promise<Doc<"tasks">> {
  const id = ctx.db.normalizeId("tasks", rawId);
  const task = id ? await ctx.db.get(id) : null;
  if (!task || task.orgId !== grant.orgId) return missing("Task");
  return task;
}
