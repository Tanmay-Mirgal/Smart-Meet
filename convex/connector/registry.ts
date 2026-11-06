/**
 * Single source of truth for the Meetup connector (CP1).
 *
 * Every action, resource and event is defined exactly once here with zod.
 * The same schemas (a) validate requests at runtime, (b) generate the
 * `inputSchema`/`outputSchema` entries in the manifest, and (c) generate the
 * OpenAPI 3.1 document. Nothing in this file imports Convex, so it runs
 * unchanged in unit tests.
 */
import { z } from "zod";
import type { ScopeName } from "./scopes";

// ── shared building blocks ──────────────────────────────────────────────────

const isoOut = z
  .iso.datetime()
  .meta({ description: "ISO-8601 UTC timestamp", examples: ["2026-01-01T10:00:00.000Z"] });

const isoIn = (description: string) =>
  z.iso
    .datetime({ offset: true })
    .meta({ description, examples: ["2026-03-02T09:30:00.000Z"] });

export const externalRefSchema = z
  .strictObject({
    hubProjectId: z.string().min(1).max(64).optional().meta({ description: "Hub project id" }),
    hubRunId: z.string().min(1).max(64).optional().meta({ description: "Hub workflow run id" }),
    hubStepId: z.string().min(1).max(64).optional().meta({ description: "Hub workflow step id" }),
  })
  .meta({
    title: "externalRef",
    description:
      "Correlation ids set by the Hub. Stored on the entity and echoed in every event about it (CP1 §3.3).",
    examples: [{ hubProjectId: "prj_123", hubRunId: "run_9", hubStepId: "step_2" }],
  });

export const MAX_METADATA_BYTES = 2048;

export const metadataSchema = z
  .record(z.string().max(64), z.unknown())
  .refine((value) => JSON.stringify(value).length <= MAX_METADATA_BYTES, {
    message: `metadata must be at most ${MAX_METADATA_BYTES} bytes when JSON-encoded`,
  })
  .meta({
    title: "metadata",
    description: "Free-form caller-defined object (<= 2 KB). Stored and returned verbatim.",
    examples: [{ source: "hub-workflow" }],
  });

const idOf = (description: string, example = "k57abc123def456") =>
  z.string().min(1).max(64).meta({ description, examples: [example] });

const emailIn = (description: string) =>
  z.email().max(254).meta({ description, examples: ["ada@example.com"] });

export const paginationQuery = {
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .meta({ description: "Page size (1–200).", default: 50 }),
  cursor: z
    .string()
    .max(512)
    .optional()
    .meta({ description: "Opaque cursor from a previous response's nextCursor." }),
};

const paginated = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z
      .string()
      .nullable()
      .meta({ description: "Pass as ?cursor= to get the next page; null when done." }),
  });

// ── entities ────────────────────────────────────────────────────────────────

export const meetingStatusSchema = z.enum(["scheduled", "active", "ended"]);

export const meetingSettingsSchema = z
  .strictObject({
    joinMode: z
      .enum(["organization_only", "invite_only", "anyone_with_link", "ask_to_join"])
      .optional()
      .meta({ description: "Who may join. Default: organization_only." }),
    allowScreenShare: z.boolean().optional().meta({ description: "Default true." }),
    allowWhiteboard: z.boolean().optional().meta({ description: "Default true." }),
    allowChat: z.boolean().optional().meta({ description: "Default true." }),
    allowReactions: z.boolean().optional().meta({ description: "Default true." }),
    allowRecording: z.boolean().optional().meta({ description: "Default true." }),
    allowParticipantsToUnmute: z.boolean().optional().meta({ description: "Default true." }),
    autoAdmitOrgUsers: z.boolean().optional().meta({ description: "Default true." }),
    lobbyEnabled: z.boolean().optional().meta({ description: "Default false." }),
  })
  .meta({ title: "settings", description: "Overrides for Meetup's default meeting settings." });

export const meetingEntity = z
  .object({
    id: z.string(),
    title: z.string(),
    purpose: z.string().meta({
      description:
        "Free text. Convention: brainstorm | design-review | standup | retro | planning | incident.",
    }),
    description: z.string().optional(),
    status: meetingStatusSchema,
    scheduledFor: isoOut.optional(),
    scheduledEndsAt: isoOut.optional(),
    scheduledTimeZone: z.string().optional(),
    startedAt: isoOut.optional(),
    endedAt: isoOut.optional(),
    isLocked: z.boolean(),
    host: z.object({ id: z.string(), name: z.string() }),
    joinUrl: z.string().meta({ description: "Link that opens the live meeting room." }),
    webUrl: z.string().meta({ description: "Deep link to the meeting details page." }),
    createdVia: z.literal("connector").optional(),
    externalRef: externalRefSchema.optional(),
    metadata: metadataSchema.optional(),
    createdAt: isoOut,
    updatedAt: isoOut,
  })
  .meta({ title: "Meeting" });

export const meetingDetailEntity = meetingEntity
  .extend({
    settings: meetingSettingsSchema.required(),
    durationMs: z.number(),
    participantCount: z.number().meta({ description: "People who have joined at least once." }),
    activeParticipants: z.number(),
    hasSummary: z.boolean(),
    googleCalendar: z.object({
      syncRequested: z.boolean(),
      status: z.enum(["pending", "synced", "failed"]).optional(),
      eventUrl: z.string().optional(),
    }),
    recording: z.object({
      allowed: z.boolean().meta({ description: "settings.allowRecording" }),
      recordingCount: z.number(),
      hasReadyRecording: z.boolean(),
    }),
  })
  .meta({ title: "MeetingDetail" });

const meetingRef = z
  .object({
    id: z.string(),
    title: z.string(),
    purpose: z.string(),
    status: meetingStatusSchema,
    scheduledFor: isoOut.optional(),
    startedAt: isoOut.optional(),
    endedAt: isoOut.optional(),
    webUrl: z.string(),
  })
  .meta({ title: "MeetingRef" });

export const taskStatusSchema = z.enum(["open", "in_progress", "done"]);

export const taskEntity = z
  .object({
    id: z.string(),
    title: z.string(),
    status: taskStatusSchema,
    assignee: z.object({ id: z.string().optional(), name: z.string() }).optional(),
    suggestedAssigneeName: z.string().optional(),
    dueAt: isoOut.optional(),
    meetingId: z.string().optional(),
    source: z.enum(["manual", "summary"]),
    completedAt: isoOut.optional(),
    webUrl: z.string(),
    createdVia: z.literal("connector").optional(),
    externalRef: externalRefSchema.optional(),
    metadata: metadataSchema.optional(),
    createdAt: isoOut,
    updatedAt: isoOut,
  })
  .meta({ title: "Task" });

const actionItemOut = z.object({
  task: z.string(),
  assignee: z.string().nullable(),
  due: z.string().nullable(),
});

export const summaryEntity = z
  .object({
    summary: z.string(),
    keyPoints: z.array(z.string()),
    decisions: z.array(z.string()),
    actionItems: z.array(actionItemOut),
    version: z.number().meta({ description: "Increments each time a different summary is saved." }),
    language: z.string().optional(),
    generatedAt: isoOut,
  })
  .meta({ title: "Summary" });

// ── actions ─────────────────────────────────────────────────────────────────

export type ActionDef = {
  name: string;
  description: string;
  scopes: ScopeName[];
  async: boolean;
  idempotent: true;
  input: z.ZodType;
  output: z.ZodType;
};

const meetingIdField = idOf("Meeting id", "k17f3a9b2c4d5e6f");

export const ACTIONS = [
  {
    name: "meetings.create",
    description:
      "Schedule a meeting, or start an instant one when scheduledFor is omitted. Creates it as the connected user (the host). Counts against the organization's plan meeting cap.",
    scopes: ["meetup:meetings:write"],
    async: false,
    idempotent: true,
    input: z
      .strictObject({
        title: z.string().trim().min(1).max(200).meta({ description: "Meeting title", examples: ["Sprint planning"] }),
        purpose: z.string().trim().max(200).optional().meta({
          description:
            "Free text. Convention so the Hub can filter triggers: brainstorm | design-review | standup | retro | planning | incident.",
          examples: ["design-review"],
        }),
        description: z.string().trim().max(2000).optional().meta({ description: "Agenda or notes" }),
        scheduledFor: isoIn("Start time. Omit for an instant meeting that starts now.").optional(),
        scheduledEndsAt: isoIn("End time; must be after scheduledFor.").optional(),
        scheduledTimeZone: z.string().max(64).optional().meta({
          description: "IANA time zone used when rendering invites",
          examples: ["Asia/Kolkata"],
        }),
        inviteEmails: z.array(emailIn("Invitee email")).max(50).optional().meta({
          title: "inviteEmails",
          description: "People to invite by email (Meetup sends the invitation email as it does today).",
        }),
        settings: meetingSettingsSchema.optional(),
        syncWithGoogleCalendar: z.boolean().optional().meta({
          description:
            "Create a Google Calendar event. Only works for scheduled meetings, on paid plans, when the connected user has linked Google Calendar.",
          default: false,
        }),
        metadata: metadataSchema.optional(),
        externalRef: externalRefSchema.optional(),
      })
      .meta({ title: "meetings.create input" }),
    output: z.object({
      meeting: z.object({
        id: z.string(),
        title: z.string(),
        status: meetingStatusSchema,
        scheduledFor: isoOut.optional(),
        joinUrl: z.string(),
        webUrl: z.string(),
      }),
    }),
  },
  {
    name: "meetings.end",
    description:
      "End a meeting. Host-only, exactly as in the Meetup UI: if the connected user is not the host this returns 403 forbidden.",
    scopes: ["meetup:meetings:write"],
    async: false,
    idempotent: true,
    input: z.strictObject({ meetingId: meetingIdField }).meta({ title: "meetings.end input" }),
    output: z.object({
      meeting: z.object({ id: z.string(), status: meetingStatusSchema, endedAt: isoOut.optional(), webUrl: z.string() }),
    }),
  },
  {
    name: "meetings.invite",
    description:
      "Invite people to a meeting by email. Already-invited addresses are skipped. Same rule as the Meetup UI: the connected user must be a host or co-host AND present in the meeting (joined), otherwise 403 forbidden — a connector never bypasses it. To invite people at creation time, use inviteEmails on meetings.create instead.",
    scopes: ["meetup:meetings:write"],
    async: false,
    idempotent: true,
    input: z
      .strictObject({
        meetingId: meetingIdField,
        emails: z
          .array(emailIn("Invitee email"))
          .min(1)
          .max(50)
          .meta({ description: "Email addresses to invite (1–50)." }),
        role: z.enum(["host", "co_host", "participant", "viewer"]).optional().meta({
          description: "Meeting role for the invitees. Default: participant.",
          default: "participant",
        }),
      })
      .meta({ title: "meetings.invite input" }),
    output: z.object({
      invited: z.array(z.string()).meta({ description: "Emails that were newly invited" }),
      webUrl: z.string(),
    }),
  },
  {
    name: "meetings.generateSummary",
    description:
      "Generate the AI summary, key points, decisions and action items from the meeting transcript on the server (no browser needed). Asynchronous: poll the returned operation. Requires the organization's aiSummary plan feature. If a summary already exists and force is false, the existing summary is returned.",
    scopes: ["meetup:summaries:read", "meetup:meetings:write"],
    async: true,
    idempotent: true,
    input: z
      .strictObject({
        meetingId: meetingIdField,
        force: z.boolean().optional().meta({
          description: "Regenerate even if a summary exists (emits meeting.summary.ready again).",
          default: false,
        }),
        language: z.string().min(2).max(35).optional().meta({
          description: "BCP-47 language for the summary text, e.g. 'hi' or 'en'. Default: the transcript language.",
          examples: ["en"],
        }),
      })
      .meta({ title: "meetings.generateSummary input" }),
    output: z.object({
      meetingId: z.string(),
      status: z.enum(["generated", "existing"]),
      version: z.number(),
      summary: z.string(),
      actionItemCount: z.number(),
      tasksCreated: z.number(),
      webUrl: z.string(),
    }),
  },
  {
    name: "tasks.create",
    description:
      "Create a task. If assigneeEmail matches an organization member the task is assigned to them; otherwise it is created unassigned with suggestedAssigneeName.",
    scopes: ["meetup:tasks:write"],
    async: false,
    idempotent: true,
    input: z
      .strictObject({
        title: z.string().trim().min(1).max(300).meta({ description: "Task title", examples: ["Ship the onboarding redesign"] }),
        meetingId: meetingIdField.optional().meta({ description: "Link the task to a meeting" }),
        assigneeEmail: emailIn("Organization member to assign").optional(),
        dueAt: isoIn("Due date/time").optional(),
        metadata: metadataSchema.optional(),
        externalRef: externalRefSchema.optional(),
      })
      .meta({ title: "tasks.create input" }),
    output: z.object({ task: taskEntity }),
  },
  {
    name: "tasks.createFromSummary",
    description:
      "Create tasks from a meeting's action items. Titles that already exist for the meeting are skipped (de-duplicated case-insensitively).",
    scopes: ["meetup:tasks:write"],
    async: false,
    idempotent: true,
    input: z
      .strictObject({
        meetingId: meetingIdField,
        actionItems: z
          .array(
            z.strictObject({
              title: z.string().trim().min(1).max(300),
              assigneeName: z.string().max(200).nullable().optional().meta({
                description: "Matched against member names/emails; kept as a suggestion if unmatched.",
              }),
            }),
          )
          .min(1)
          .max(100)
          .meta({ description: "Action items to turn into tasks (1–100)." }),
        externalRef: externalRefSchema.optional(),
      })
      .meta({ title: "tasks.createFromSummary input" }),
    output: z.object({ tasks: z.array(taskEntity), skippedDuplicates: z.number() }),
  },
  {
    name: "tasks.update",
    description: "Update a task's status, assignee, due date or title. Emits task.updated, and task.completed when it becomes done.",
    scopes: ["meetup:tasks:write"],
    async: false,
    idempotent: true,
    input: z
      .strictObject({
        taskId: idOf("Task id"),
        status: taskStatusSchema.optional().meta({ description: "New status: open | in_progress | done." }),
        assigneeEmail: emailIn("Organization member to assign").nullable().optional().meta({
          description: "Email of an organization member, or null to unassign.",
        }),
        dueAt: isoIn("Due date/time").nullable().optional().meta({ description: "New due date/time, or null to clear it." }),
        title: z.string().trim().min(1).max(300).optional().meta({ description: "New task title." }),
      })
      .meta({ title: "tasks.update input" }),
    output: z.object({ task: taskEntity }),
  },
  {
    name: "notifications.create",
    description:
      "Send an in-app notification (it appears in the recipient's Meetup notification bell). Recipient must belong to the connected organization. Limited to 60 per minute per connection.",
    scopes: ["meetup:notifications:write"],
    async: false,
    idempotent: true,
    input: z
      .strictObject({
        userEmail: emailIn("Recipient email").optional(),
        userId: idOf("Recipient user id (from GET /members)").optional(),
        title: z.string().trim().min(1).max(120).meta({ description: "Short notification title.", examples: ["Deployment is live"] }),
        message: z.string().trim().min(1).max(500).meta({
          description: "Notification body shown in the bell.",
          examples: ["Your deployment to production finished successfully."],
        }),
        link: z.string().max(500).optional().meta({
          description: "Where clicking the notification goes. Absolute https URL or an app-relative path.",
        }),
        meetingId: meetingIdField.optional(),
      })
      .refine((value) => Boolean(value.userEmail) !== Boolean(value.userId), {
        message: "Provide exactly one of userEmail or userId",
        path: ["userEmail"],
      })
      .meta({ title: "notifications.create input" }),
    output: z.object({ notification: z.object({ id: z.string(), createdAt: isoOut }) }),
  },
] as const satisfies readonly ActionDef[];

export type ActionName = (typeof ACTIONS)[number]["name"];
export const ACTION_NAMES: ActionName[] = ACTIONS.map((a) => a.name);

export function getAction(name: string): (typeof ACTIONS)[number] | undefined {
  return ACTIONS.find((action) => action.name === name);
}

// ── resources ───────────────────────────────────────────────────────────────

export type ResourceDef = {
  name: string;
  description: string;
  method: "GET";
  /** Relative to /api/connect/v1. `{id}` is the only path parameter syntax. */
  path: string;
  scopes: ScopeName[];
  query: z.ZodType;
  output: z.ZodType;
};

const emptyQuery = z.strictObject({});

export const RESOURCES = [
  {
    name: "orgs.get",
    description: "The organization this connection is pinned to.",
    method: "GET",
    path: "/orgs",
    scopes: ["meetup:orgs:read"],
    query: emptyQuery,
    output: z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string().optional(),
      imageUrl: z.string().optional(),
      webUrl: z.string(),
    }),
  },
  {
    name: "members.list",
    description: "People in the organization, for mapping assignees by email.",
    method: "GET",
    path: "/members",
    scopes: ["meetup:members:read"],
    query: z.strictObject({ ...paginationQuery }),
    output: paginated(
      z.object({
        id: z.string(),
        name: z.string(),
        email: z.string().nullable(),
        imageUrl: z.string().optional(),
      }),
    ),
  },
  {
    name: "meetings.list",
    description: "Meetings in the organization, newest first.",
    method: "GET",
    path: "/meetings",
    scopes: ["meetup:meetings:read"],
    query: z.strictObject({
      status: meetingStatusSchema.optional(),
      purpose: z.string().max(200).optional().meta({ description: "Exact (case-insensitive) match on purpose." }),
      from: isoIn("Only meetings created at or after this time").optional(),
      to: isoIn("Only meetings created before this time").optional(),
      ...paginationQuery,
    }),
    output: paginated(meetingEntity),
  },
  {
    name: "meetings.get",
    description: "One meeting with its settings, host, participant counts, timings, calendar and recording flags.",
    method: "GET",
    path: "/meetings/{id}",
    scopes: ["meetup:meetings:read"],
    query: emptyQuery,
    output: meetingDetailEntity,
  },
  {
    name: "meetings.participants",
    description: "Everyone who has been part of the meeting.",
    method: "GET",
    path: "/meetings/{id}/participants",
    scopes: ["meetup:meetings:read"],
    query: z.strictObject({ ...paginationQuery }),
    output: paginated(
      z.object({
        id: z.string(),
        name: z.string(),
        email: z.string().optional(),
        role: z.enum(["host", "co_host", "participant", "viewer"]),
        status: z.enum(["waiting", "joined", "left", "removed", "rejected"]),
        joinedAt: isoOut.optional(),
        leftAt: isoOut.optional(),
      }),
    ),
  },
  {
    name: "meetings.transcript",
    description: "Transcript segments in spoken order. The most sensitive meeting data — needs its own scope.",
    method: "GET",
    path: "/meetings/{id}/transcript",
    scopes: ["meetup:transcripts:read"],
    query: z.strictObject({ ...paginationQuery }),
    output: paginated(
      z.object({
        id: z.string(),
        speakerId: z.string(),
        speaker: z.string(),
        text: z.string(),
        timestamp: isoOut,
      }),
    ),
  },
  {
    name: "meetings.summary",
    description: "The meeting summary, key points, decisions and action items. 404 if none exists yet.",
    method: "GET",
    path: "/meetings/{id}/summary",
    scopes: ["meetup:summaries:read"],
    query: emptyQuery,
    output: summaryEntity,
  },
  {
    name: "meetings.recordings",
    description:
      "Recordings with status, duration and a short-lived (10 minute) signed playback URL. Never a permanent link.",
    method: "GET",
    path: "/meetings/{id}/recordings",
    scopes: ["meetup:recordings:read"],
    query: z.strictObject({ ...paginationQuery }),
    output: paginated(
      z.object({
        id: z.string(),
        status: z.enum(["recording", "processing", "ready", "failed"]),
        startedAt: isoOut,
        stoppedAt: isoOut.optional(),
        durationMs: z.number().optional(),
        mimeType: z.string().optional(),
        playbackUrl: z.string().optional(),
        playbackUrlExpiresAt: isoOut.optional(),
        errorMessage: z.string().optional(),
      }),
    ),
  },
  {
    name: "meetings.whiteboard",
    description: "The Excalidraw scene of the meeting whiteboard (size-capped).",
    method: "GET",
    path: "/meetings/{id}/whiteboard",
    scopes: ["meetup:meetings:read"],
    query: emptyQuery,
    output: z.object({
      isOpen: z.boolean(),
      scene: z.unknown().nullable().meta({ description: "Excalidraw scene JSON, or null if never used." }),
      updatedAt: isoOut.nullable(),
      truncated: z.boolean().meta({ description: "True when the scene exceeded the response cap and was omitted." }),
    }),
  },
  {
    name: "tasks.list",
    description: "Tasks in the organization, newest first.",
    method: "GET",
    path: "/tasks",
    scopes: ["meetup:tasks:read"],
    query: z.strictObject({
      status: taskStatusSchema.optional(),
      meetingId: z.string().max(64).optional(),
      assigneeEmail: z.email().optional(),
      ...paginationQuery,
    }),
    output: paginated(taskEntity),
  },
  {
    name: "insights.get",
    description:
      "Dashboard aggregates for the organization over a time range. Bounded: meeting counts are capped at 500 and task counts at 1000 per status.",
    method: "GET",
    path: "/insights",
    scopes: ["meetup:meetings:read"],
    query: z.strictObject({
      range: z.enum(["7d", "30d", "90d", "all"]).default("30d").meta({ description: "Time range", default: "30d" }),
    }),
    output: z.object({
      range: z.string(),
      meetings: z.object({ total: z.number(), scheduled: z.number(), active: z.number(), ended: z.number() }),
      averageDurationMs: z.number().nullable(),
      tasks: z.object({ open: z.number(), inProgress: z.number(), done: z.number() }),
      timeline: z.array(z.object({ id: z.string(), title: z.string(), status: meetingStatusSchema, createdAt: isoOut })),
    }),
  },
] as const satisfies readonly ResourceDef[];

export type ResourceName = (typeof RESOURCES)[number]["name"];

// ── events ──────────────────────────────────────────────────────────────────

export type EventDef = {
  type: string;
  description: string;
  scopes: ScopeName[];
  data: z.ZodType;
};

const lifecycleData = z.object({
  meeting: meetingRef,
  host: z.object({ id: z.string(), name: z.string() }),
  participantCount: z.number().optional(),
});

export const EVENTS = [
  {
    type: "meeting.scheduled",
    description: "A meeting was scheduled for a future time.",
    scopes: ["meetup:meetings:read"],
    data: lifecycleData,
  },
  {
    type: "meeting.started",
    description: "A meeting became live (instant meeting created, or first admitted join of a scheduled one).",
    scopes: ["meetup:meetings:read"],
    data: lifecycleData,
  },
  {
    type: "meeting.ended",
    description: "A meeting was ended.",
    scopes: ["meetup:meetings:read"],
    data: lifecycleData,
  },
  {
    type: "meeting.summary.ready",
    description:
      "A summary was saved (from the browser or generated by the connector). Emitted exactly once per summary version; re-emitted only when a different summary is saved (e.g. regenerated with force). This is the Hub's primary trigger.",
    scopes: ["meetup:summaries:read"],
    data: z.object({
      meeting: meetingRef.extend({ host: z.object({ id: z.string(), name: z.string(), email: z.string().optional() }) }),
      version: z.number(),
      summary: z.string(),
      keyPoints: z.array(z.string()),
      decisions: z.array(z.string()),
      actionItems: z.array(actionItemOut),
      participants: z.array(z.object({ name: z.string(), email: z.string().optional() })),
      language: z.string().optional(),
    }),
  },
  {
    type: "meeting.transcript.ready",
    description:
      "The final transcript is stored. Emitted once, at the later of (endedAt + 60 s) and (last transcript write + 60 s) — i.e. debounced.",
    scopes: ["meetup:transcripts:read"],
    data: z.object({ meeting: meetingRef, segments: z.number(), durationMs: z.number() }),
  },
  {
    type: "recording.ready",
    description: "A recording finished processing.",
    scopes: ["meetup:recordings:read"],
    data: z.object({
      meeting: meetingRef,
      recording: z.object({ id: z.string(), durationMs: z.number().optional(), mimeType: z.string().optional() }),
    }),
  },
  {
    type: "recording.failed",
    description: "A recording failed.",
    scopes: ["meetup:recordings:read"],
    data: z.object({
      meeting: meetingRef,
      recording: z.object({ id: z.string(), durationMs: z.number().optional(), mimeType: z.string().optional() }),
    }),
  },
  {
    type: "task.created",
    description: "A task was created.",
    scopes: ["meetup:tasks:read"],
    data: z.object({ task: taskEntity, meetingId: z.string().optional() }),
  },
  {
    type: "task.updated",
    description:
      "A task changed. Coalesced: updates to the same task within 5 seconds that have not been delivered yet are merged into the latest state.",
    scopes: ["meetup:tasks:read"],
    data: z.object({ task: taskEntity, meetingId: z.string().optional() }),
  },
  {
    type: "task.completed",
    description: "A task moved to done.",
    scopes: ["meetup:tasks:read"],
    data: z.object({ task: taskEntity, meetingId: z.string().optional() }),
  },
] as const satisfies readonly EventDef[];

export type EventType = (typeof EVENTS)[number]["type"];
export const EVENT_TYPES: EventType[] = EVENTS.map((e) => e.type);

export function getEventDef(type: string) {
  return EVENTS.find((event) => event.type === type);
}

/** Scope(s) a grant needs in order to *read* entities of this event type. */
export function getEventScopes(type: string): ScopeName[] {
  return [...(getEventDef(type)?.scopes ?? [])];
}

/** Subscriptions accept exact types and `prefix.*` (CP1 §5). */
const PATTERN_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*(\.\*)?$/;

export function isValidEventPattern(pattern: string): boolean {
  if (!PATTERN_RE.test(pattern)) return false;
  return EVENT_TYPES.some((type) => matchesEventPattern(pattern, type));
}

export function matchesEventPattern(pattern: string, type: string): boolean {
  if (pattern === type) return true;
  if (pattern.endsWith(".*")) {
    return type.startsWith(pattern.slice(0, -1));
  }
  return false;
}

export function matchesAnyPattern(patterns: readonly string[], type: string) {
  return patterns.some((pattern) => matchesEventPattern(pattern, type));
}

// ── JSON Schema ─────────────────────────────────────────────────────────────

export function toJsonSchema(schema: z.ZodType, io: "input" | "output" = "input") {
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io,
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return jsonSchema;
}

/** Recursively removes keys a strict object schema does not declare. */
export function stripUnknownFields(jsonSchema: unknown, value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = (jsonSchema as { items?: unknown } | undefined)?.items;
    return value.map((entry) => stripUnknownFields(items, entry));
  }
  if (value === null || typeof value !== "object") return value;

  const schema = jsonSchema as
    | { properties?: Record<string, unknown>; additionalProperties?: unknown }
    | undefined;
  if (!schema?.properties) return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key in schema.properties) {
      out[key] = stripUnknownFields(schema.properties[key], entry);
    } else if (schema.additionalProperties !== false) {
      out[key] = entry; // free-form objects (e.g. metadata) keep their keys
    }
  }
  return out;
}
