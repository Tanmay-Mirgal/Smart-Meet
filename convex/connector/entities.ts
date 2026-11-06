import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { webUrl } from "./config";
import { getUserInfo, type UserInfo } from "./subject";

/** ISO-8601 UTC. Client-supplied timestamps can be garbage, so never throw. */
export function iso(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

export function isoOpt(ms: number | undefined): string | undefined {
  return typeof ms === "number" ? iso(ms) : undefined;
}

export function parseMetadata(json: string | undefined): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export const meetingJoinUrl = (id: string) => webUrl(`/meeting/${id}`);
export const meetingDetailsUrl = (id: string) => webUrl(`/meeting/${id}/details`);
export const tasksUrl = () => webUrl("/tasks");

/** Per-request memo so a list of 200 meetings by one host costs one user lookup. */
export class SubjectCache {
  private readonly users = new Map<string, UserInfo>();

  constructor(private readonly ctx: QueryCtx) {}

  async user(tokenIdentifier: string): Promise<UserInfo> {
    const cached = this.users.get(tokenIdentifier);
    if (cached) return cached;
    const info = await getUserInfo(this.ctx, tokenIdentifier);
    this.users.set(tokenIdentifier, info);
    return info;
  }
}

export async function toMeetingEntity(meeting: Doc<"meetings">, cache: SubjectCache) {
  const host = await cache.user(meeting.hostUserTokenIdentifier);
  const id = String(meeting._id);
  return {
    id,
    title: meeting.title,
    purpose: meeting.purpose,
    description: meeting.description,
    status: meeting.status,
    scheduledFor: isoOpt(meeting.scheduledFor),
    scheduledEndsAt: isoOpt(meeting.scheduledEndsAt),
    scheduledTimeZone: meeting.scheduledTimeZone,
    startedAt: isoOpt(meeting.startedAt),
    endedAt: isoOpt(meeting.endedAt),
    isLocked: meeting.isLocked,
    host: { id: host.id, name: host.name },
    joinUrl: meetingJoinUrl(id),
    webUrl: meetingDetailsUrl(id),
    createdVia: meeting.createdVia,
    externalRef: meeting.externalRef,
    metadata: parseMetadata(meeting.metadataJson),
    createdAt: iso(meeting._creationTime),
    updatedAt: iso(meeting.lastActivityAt),
  };
}

export async function toTaskEntity(task: Doc<"tasks">, cache: SubjectCache) {
  const assignee = task.assigneeTokenIdentifier
    ? await cache.user(task.assigneeTokenIdentifier)
    : null;
  return {
    id: String(task._id),
    title: task.title,
    status: task.status,
    assignee:
      task.assigneeName || assignee
        ? { id: assignee?.id, name: task.assigneeName ?? assignee?.name ?? "" }
        : undefined,
    suggestedAssigneeName: task.suggestedAssigneeName,
    dueAt: isoOpt(task.dueAt),
    meetingId: task.meetingId ? String(task.meetingId) : undefined,
    source: task.source,
    completedAt: isoOpt(task.completedAt),
    webUrl: tasksUrl(),
    createdVia: task.createdVia,
    externalRef: task.externalRef,
    metadata: parseMetadata(task.metadataJson),
    createdAt: iso(task.createdAt),
    updatedAt: iso(task.updatedAt ?? task.createdAt),
  };
}
