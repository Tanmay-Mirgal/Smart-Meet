import { mutation, query } from "../_generated/server";
import { v, type ObjectType } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { actorFromIdentity, type Actor } from "../lib/actor";
import type { ExternalRef } from "../lib/connectorFields";
import {
  assertMeetingAccess,
  assertOrgAccess,
  getCurrentUserRecord,
  hasOrgAccess,
  requireIdentity,
} from "../lib/auth";

type ConvexCtx = QueryCtx | MutationCtx;
type OrgMemberOption = {
  tokenIdentifier: string;
  name: string;
  email: string | null;
};

const taskStatusValidator = v.union(
  v.literal("open"),
  v.literal("in_progress"),
  v.literal("done"),
);

function normalizeLookupValue(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function getMemberDisplayName(user: Doc<"users"> | null) {
  if (!user) {
    return null;
  }

  const fullName = user.fullName?.trim();
  if (fullName) {
    return fullName;
  }

  const fallbackName = [user.firstName, user.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  return fallbackName || user.email.trim() || null;
}

async function listOrganizationMembers(
  ctx: ConvexCtx,
  orgId: string,
): Promise<OrgMemberOption[]> {
  const memberships = await ctx.db
    .query("user_org_memberships")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .take(200);

  const seen = new Set<string>();
  const members: OrgMemberOption[] = [];

  for (const membership of memberships) {
    if (seen.has(membership.userTokenIdentifier)) {
      continue;
    }

    seen.add(membership.userTokenIdentifier);
    const user = await getCurrentUserRecord(ctx, membership.userTokenIdentifier);
    const name = getMemberDisplayName(user);

    if (!user || !name) {
      continue;
    }

    members.push({
      tokenIdentifier: user.tokenIdentifier,
      name,
      email: user.email?.trim() || null,
    });
  }

  members.sort((left, right) => left.name.localeCompare(right.name));
  return members;
}

function buildMemberLookup(members: OrgMemberOption[]) {
  const lookup = new Map<string, OrgMemberOption>();

  for (const member of members) {
    for (const key of [member.name, member.email]) {
      const normalized = normalizeLookupValue(key);
      if (!normalized || lookup.has(normalized)) {
        continue;
      }

      lookup.set(normalized, member);
    }
  }

  return lookup;
}

async function resolveAssignedMember(
  ctx: ConvexCtx,
  orgId: string,
  assigneeTokenIdentifier: string | null | undefined,
) {
  if (!assigneeTokenIdentifier) {
    return {
      assigneeName: undefined,
      assigneeTokenIdentifier: undefined,
    };
  }

  const hasAccess = await hasOrgAccess(ctx, assigneeTokenIdentifier, orgId);
  if (!hasAccess) {
    throw new Error("Assignee must belong to this workspace");
  }

  const user = await getCurrentUserRecord(ctx, assigneeTokenIdentifier);
  const name = getMemberDisplayName(user);
  if (!user || !name) {
    throw new Error("Assignee is unavailable");
  }

  return {
    assigneeName: name,
    assigneeTokenIdentifier: user.tokenIdentifier,
  };
}

const listTasksArgs = {
  orgId: v.string(),
  status: v.optional(taskStatusValidator),
};

export async function listTasksCore(
  ctx: QueryCtx,
  actor: Actor,
  args: ObjectType<typeof listTasksArgs>,
) {
  await assertOrgAccess(ctx, actor.tokenIdentifier, args.orgId);
  const status = args.status ?? "open";
  return await ctx.db
    .query("tasks")
    .withIndex("by_orgId_and_status", (q) =>
      q.eq("orgId", args.orgId).eq("status", status),
    )
    .order("desc")
    .take(50);
}

export const list = query({
  args: listTasksArgs,
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    return await listTasksCore(ctx, actorFromIdentity(identity), args);
  },
});

const createTaskArgs = {
  orgId: v.string(),
  meetingId: v.optional(v.id("meetings")),
  title: v.string(),
  assigneeTokenIdentifier: v.optional(v.string()),
  dueAt: v.optional(v.number()),
};

/** What the browser sends, plus optional fields only the connector sets. */
export type CreateTaskInput = ObjectType<typeof createTaskArgs> & {
  suggestedAssigneeName?: string;
  createdVia?: "connector";
  externalRef?: ExternalRef;
  metadataJson?: string;
};

export async function createTaskCore(
  ctx: MutationCtx,
  actor: Actor,
  args: CreateTaskInput,
) {
  await assertOrgAccess(ctx, actor.tokenIdentifier, args.orgId);
  if (args.meetingId) {
    await assertMeetingAccess(ctx, actor.tokenIdentifier, args.meetingId);
  }

  const assignee = await resolveAssignedMember(
    ctx,
    args.orgId,
    args.assigneeTokenIdentifier,
  );
  const now = Date.now();

  return await ctx.db.insert("tasks", {
    orgId: args.orgId,
    meetingId: args.meetingId,
    title: args.title,
    status: "open",
    assigneeName: assignee.assigneeName,
    assigneeTokenIdentifier: assignee.assigneeTokenIdentifier,
    suggestedAssigneeName: args.suggestedAssigneeName,
    dueAt: args.dueAt,
    source: "manual",
    createdAt: now,
    updatedAt: now,
    createdVia: args.createdVia,
    externalRef: args.externalRef,
    metadataJson: args.metadataJson,
  });
}

export const create = mutation({
  args: createTaskArgs,
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    return await createTaskCore(ctx, actorFromIdentity(identity), args);
  },
});

const createTasksFromSummaryArgs = {
  orgId: v.string(),
  meetingId: v.id("meetings"),
  actionItems: v.array(
    v.object({
      title: v.string(),
      assigneeName: v.optional(v.union(v.string(), v.null())),
    }),
  ),
};

export type CreateTasksFromSummaryInput = ObjectType<typeof createTasksFromSummaryArgs> & {
  createdVia?: "connector";
  externalRef?: ExternalRef;
};

export async function createTasksFromSummaryCore(
  ctx: MutationCtx,
  actor: Actor,
  args: CreateTasksFromSummaryInput,
) {
  await assertOrgAccess(ctx, actor.tokenIdentifier, args.orgId);
  await assertMeetingAccess(ctx, actor.tokenIdentifier, args.meetingId);

  const normalizedItems = args.actionItems
    .map((item) => ({
      title: item.title.trim(),
      assigneeName: item.assigneeName?.trim() || null,
    }))
    .filter((item) => item.title);

  if (normalizedItems.length === 0) {
    return [];
  }

  const existingTasks = await ctx.db
    .query("tasks")
    .withIndex("by_meetingId", (q) => q.eq("meetingId", args.meetingId))
    .take(100);

  const existingTitleSet = new Set(
    existingTasks.map((task) => task.title.trim().toLowerCase()),
  );
  const members = await listOrganizationMembers(ctx, args.orgId);
  const memberLookup = buildMemberLookup(members);

  const now = Date.now();
  const createdTaskIds: Id<"tasks">[] = [];

  for (const item of normalizedItems) {
    const normalizedTitle = item.title.toLowerCase();
    if (existingTitleSet.has(normalizedTitle)) {
      continue;
    }

    const suggestedAssigneeName = item.assigneeName || undefined;
    const matchedMember = suggestedAssigneeName
      ? memberLookup.get(normalizeLookupValue(suggestedAssigneeName)) ?? null
      : null;

    const taskId = await ctx.db.insert("tasks", {
      orgId: args.orgId,
      meetingId: args.meetingId,
      title: item.title,
      status: "open",
      assigneeName: matchedMember?.name,
      assigneeTokenIdentifier: matchedMember?.tokenIdentifier,
      suggestedAssigneeName:
        suggestedAssigneeName && !matchedMember ? suggestedAssigneeName : undefined,
      source: "summary",
      createdAt: now,
      updatedAt: now,
      createdVia: args.createdVia,
      externalRef: args.externalRef,
    });

    existingTitleSet.add(normalizedTitle);
    createdTaskIds.push(taskId);
  }

  return createdTaskIds;
}

export const createFromSummary = mutation({
  args: createTasksFromSummaryArgs,
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    return await createTasksFromSummaryCore(ctx, actorFromIdentity(identity), args);
  },
});

const updateTaskArgs = {
  taskId: v.id("tasks"),
  status: taskStatusValidator,
  assigneeTokenIdentifier: v.optional(v.union(v.string(), v.null())),
};

/**
 * The browser always sends a status; the connector may update any subset of
 * fields, so every field except the id is optional here.
 */
export type UpdateTaskInput = Omit<ObjectType<typeof updateTaskArgs>, "status"> & {
  status?: ObjectType<typeof updateTaskArgs>["status"];
  /** null clears the due date. */
  dueAt?: number | null;
  title?: string;
};

export async function updateTaskCore(
  ctx: MutationCtx,
  actor: Actor,
  args: UpdateTaskInput,
) {
  const task = await ctx.db.get(args.taskId);

  if (!task) {
    throw new Error("Task not found");
  }

  const currentUser = await assertOrgAccess(
    ctx,
    actor.tokenIdentifier,
    task.orgId,
  );
  const assignee =
    args.assigneeTokenIdentifier === undefined
      ? {
          assigneeName: task.assigneeName,
          assigneeTokenIdentifier: task.assigneeTokenIdentifier,
        }
      : await resolveAssignedMember(ctx, task.orgId, args.assigneeTokenIdentifier);
  const now = Date.now();
  const nextStatus = args.status ?? task.status;

  const patch: Partial<Doc<"tasks">> = {
    status: nextStatus,
    assigneeName: assignee.assigneeName,
    assigneeTokenIdentifier: assignee.assigneeTokenIdentifier,
    updatedAt: now,
  };

  if (args.title !== undefined) {
    patch.title = args.title;
  }
  if (args.dueAt !== undefined) {
    patch.dueAt = args.dueAt ?? undefined;
  }

  if (task.status !== "done" && nextStatus === "done") {
    patch.completedAt = now;
    patch.completedByTokenIdentifier = actor.tokenIdentifier;
    patch.completedByName =
      getMemberDisplayName(currentUser) ?? actor.displayName;
  } else if (task.status === "done" && nextStatus !== "done") {
    patch.completedAt = undefined;
    patch.completedByTokenIdentifier = undefined;
    patch.completedByName = undefined;
  }

  if (
    args.assigneeTokenIdentifier !== undefined
    && assignee.assigneeTokenIdentifier
  ) {
    patch.suggestedAssigneeName = undefined;
  }

  await ctx.db.patch(task._id, patch);
  return task._id;
}

export const updateTask = mutation({
  args: updateTaskArgs,
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    return await updateTaskCore(ctx, actorFromIdentity(identity), args);
  },
});

export const listByMeeting = query({
  args: {
    meetingId: v.id("meetings"),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    await assertMeetingAccess(ctx, identity.tokenIdentifier, args.meetingId);

    return await ctx.db
      .query("tasks")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", args.meetingId))
      .order("desc")
      .take(100);
  },
});

export const listOrgMembers = query({
  args: {
    orgId: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    await assertOrgAccess(ctx, identity.tokenIdentifier, args.orgId);
    return await listOrganizationMembers(ctx, args.orgId);
  },
});
