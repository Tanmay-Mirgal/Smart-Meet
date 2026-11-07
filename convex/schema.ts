import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  meetingParticipantStatusValidator,
  meetingRoleValidator,
  meetingSettingsValidator,
  permissionsOverrideValidator,
} from "./lib/meetingPermissions";
import {
  createdViaValidator,
  externalRefValidator,
} from "./lib/connectorFields";

export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.string(),
    clerkId: v.string(),
    email: v.string(),
    fullName: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    // orgIds is kept for backwards compatibility but should NOT be used for
    // indexed queries — use user_org_memberships instead.
    orgIds: v.array(v.string()),
  })
    .index("by_tokenIdentifier", ["tokenIdentifier"])
    .index("by_clerkId", ["clerkId"])
    .index("by_email", ["email"]),

  // Explicit join table replacing the orgIds array-field scan.
  // Convex cannot index array fields for membership queries, so we maintain
  // a separate row per (user, org) pair with a composite index.
  user_org_memberships: defineTable({
    userTokenIdentifier: v.string(),
    orgId: v.string(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_userTokenIdentifier_and_orgId", ["userTokenIdentifier", "orgId"]),

  organizations: defineTable({
    clerkId: v.string(),
    name: v.string(),
    slug: v.string(),
    imageUrl: v.optional(v.string()),
  })
    .index("by_clerkId", ["clerkId"])
    .index("by_slug", ["slug"]),

  organization_billing_snapshots: defineTable({
    orgId: v.string(),
    planKey: v.union(
      v.literal("starter"),
      v.literal("custom"),
      v.literal("pro"),
    ),
    planName: v.string(),
    maxMeetings: v.union(v.number(), v.null()),
    features: v.object({
      unlimitedMeetings: v.boolean(),
      aiSummary: v.boolean(),
      notionExport: v.boolean(),
      recording: v.boolean(),
      googleCalendarSync: v.boolean(),
    }),
    syncedAt: v.number(),
    expiresAt: v.optional(v.number()),
    updatedByTokenIdentifier: v.string(),
  }).index("by_orgId", ["orgId"]),

  meetings: defineTable({
    orgId: v.string(),
    title: v.string(),
    purpose: v.string(),
    description: v.optional(v.string()),
    creatorTokenIdentifier: v.string(),
    creatorClerkId: v.string(),
    creatorName: v.string(),
    hostUserTokenIdentifier: v.string(),
    hostClerkId: v.string(),
    status: v.union(v.literal("scheduled"), v.literal("active"), v.literal("ended")),
    isLocked: v.boolean(),
    settings: meetingSettingsValidator,
    scheduledFor: v.optional(v.number()),
    scheduledEndsAt: v.optional(v.number()),
    scheduledTimeZone: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    googleCalendarSyncRequested: v.optional(v.boolean()),
    googleCalendarEventId: v.optional(v.string()),
    googleCalendarEventUrl: v.optional(v.string()),
    googleCalendarSyncStatus: v.optional(
      v.union(v.literal("pending"), v.literal("synced"), v.literal("failed")),
    ),
    googleCalendarLastSyncedAt: v.optional(v.number()),
    googleCalendarSyncError: v.optional(v.string()),
    lastActivityAt: v.number(),
    // Ecosystem connector (CP1) — additive, all optional.
    createdVia: v.optional(createdViaValidator),
    externalRef: v.optional(externalRefValidator),
    // Caller-defined metadata, JSON-encoded, <= 2 KB.
    metadataJson: v.optional(v.string()),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_and_status", ["orgId", "status"])
    .index("by_status", ["status"]),

  meeting_participants: defineTable({
    meetingId: v.id("meetings"),
    userTokenIdentifier: v.string(),
    clerkId: v.string(),
    name: v.string(),
    imageUrl: v.optional(v.string()),
    role: meetingRoleValidator,
    permissionsOverride: permissionsOverrideValidator,
    status: meetingParticipantStatusValidator,
    createdAt: v.number(),
    requestedAt: v.optional(v.number()),
    joinedAt: v.number(),
    admittedAt: v.optional(v.number()),
    leftAt: v.optional(v.number()),
    removedAt: v.optional(v.number()),
    rejectedAt: v.optional(v.number()),
    removedByParticipantId: v.optional(v.id("meeting_participants")),
    rejoinBlocked: v.boolean(),
    lastSeenAt: v.number(),
    isMutedByModerator: v.boolean(),
    isMicEnabled: v.boolean(),
    isCameraEnabled: v.boolean(),
    isScreenSharing: v.boolean(),
  })
    .index("by_meetingId_and_status", ["meetingId", "status"])
    .index("by_meetingId_and_userTokenIdentifier", ["meetingId", "userTokenIdentifier"])
    .index("by_meetingId_and_role", ["meetingId", "role"]),

  meeting_invites: defineTable({
    meetingId: v.id("meetings"),
    orgId: v.string(),
    email: v.string(),
    invitedUserTokenIdentifier: v.optional(v.string()),
    role: meetingRoleValidator,
    invitedByTokenIdentifier: v.string(),
    invitedByName: v.string(),
    // Backwards-compatible fields from legacy invite rows.
    token: v.optional(v.string()),
    sentAt: v.optional(v.number()),
    emailDeliveryStatus: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("sent"),
        v.literal("skipped"),
        v.literal("failed"),
      ),
    ),
    status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("accepted"),
        v.literal("declined"),
        v.literal("cancelled"),
        v.literal("expired"),
      ),
    ),
    expiresAt: v.optional(v.number()),
    lastSentAt: v.optional(v.number()),
    lastNotificationAt: v.optional(v.number()),
    acceptedAt: v.optional(v.number()),
    declinedAt: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    respondedAt: v.optional(v.number()),
    lastEmailAttemptAt: v.optional(v.number()),
    lastEmailError: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_meetingId", ["meetingId"])
    .index("by_meetingId_and_email", ["meetingId", "email"])
    .index("by_email", ["email"])
    .index("by_orgId_and_email", ["orgId", "email"])
    .index("by_invitedUserTokenIdentifier_and_createdAt", ["invitedUserTokenIdentifier", "createdAt"])
    .index("by_invitedUserTokenIdentifier_and_orgId", ["invitedUserTokenIdentifier", "orgId"])
    .index("by_invitedUserTokenIdentifier_and_meetingId", ["invitedUserTokenIdentifier", "meetingId"]),

  meeting_audit_logs: defineTable({
    meetingId: v.id("meetings"),
    actorParticipantId: v.optional(v.id("meeting_participants")),
    actorName: v.string(),
    action: v.string(),
    targetParticipantId: v.optional(v.id("meeting_participants")),
    targetName: v.optional(v.string()),
    metadata: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_meetingId_and_createdAt", ["meetingId", "createdAt"])
    .index("by_targetParticipantId", ["targetParticipantId"]),

  messages: defineTable({
    meetingId: v.id("meetings"),
    senderParticipantId: v.id("meeting_participants"),
    senderName: v.string(),
    body: v.string(),
    createdAt: v.number(),
  }).index("by_meetingId_and_createdAt", ["meetingId", "createdAt"]),

  transcripts: defineTable({
    meetingId: v.id("meetings"),
    speakerParticipantId: v.optional(v.id("meeting_participants")),
    speakerId: v.string(),
    speakerName: v.string(),
    text: v.string(),
    timestamp: v.number(),
    createdAt: v.number(),
    clientId: v.optional(v.string()),
  }).index("by_meetingId_and_timestamp", ["meetingId", "timestamp"]),

  meeting_assets: defineTable({
    meetingId: v.id("meetings"),
    type: v.union(v.literal("summary"), v.literal("recording")),
    content: v.optional(v.string()),
    key_points: v.optional(v.array(v.string())),
    decisions: v.optional(v.array(v.string())),
    action_items: v.optional(
      v.array(
        v.object({
          task: v.string(),
          assignee: v.union(v.string(), v.null()),
          due: v.union(v.string(), v.null()),
        }),
      ),
    ),
    storageId: v.optional(v.id("_storage")),
    updatedAt: v.number(),
    // Ecosystem connector (CP1) — bumped each time a *different* summary is saved.
    summaryVersion: v.optional(v.number()),
    language: v.optional(v.string()),
  }).index("by_meetingId_and_type", ["meetingId", "type"]),

  meeting_recordings: defineTable({
    meetingId: v.id("meetings"),
    orgId: v.string(),
    ownerParticipantId: v.optional(v.id("meeting_participants")),
    ownerTokenIdentifier: v.string(),
    startedAt: v.number(),
    stoppedAt: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    status: v.union(
      v.literal("recording"),
      v.literal("processing"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    storageId: v.optional(v.id("_storage")),
    storageProvider: v.optional(v.string()),
    storageLocation: v.optional(v.string()),
    playbackUrl: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    containerFormat: v.optional(v.string()),
    transcriptAssetId: v.optional(v.id("meeting_assets")),
    summaryAssetId: v.optional(v.id("meeting_assets")),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_meetingId_and_createdAt", ["meetingId", "createdAt"])
    .index("by_meetingId_and_status", ["meetingId", "status"]),

  meeting_whiteboards: defineTable({
    meetingId: v.id("meetings"),
    isOpen: v.boolean(),
    scene: v.optional(v.string()),
    updatedByTokenIdentifier: v.string(),
    updatedByName: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_meetingId", ["meetingId"]),

  notifications: defineTable({
    userTokenIdentifier: v.string(),
    orgId: v.string(),
    kind: v.optional(v.string()),
    title: v.optional(v.string()),
    message: v.string(),
    link: v.optional(v.string()),
    invitationId: v.optional(v.id("meeting_invites")),
    meetingId: v.optional(v.id("meetings")),
    isRead: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_userTokenIdentifier_and_orgId", ["userTokenIdentifier", "orgId"])
    .index("by_userTokenIdentifier_and_isRead", ["userTokenIdentifier", "isRead"])
    .index("by_userTokenIdentifier_and_invitationId", ["userTokenIdentifier", "invitationId"]),

  signals: defineTable({
    meetingId: v.id("meetings"),
    senderParticipantId: v.id("meeting_participants"),
    receiverParticipantId: v.id("meeting_participants"),
    kind: v.union(
      v.literal("offer"),
      v.literal("answer"),
      v.literal("ice-candidate"),
      v.literal("renegotiate"),
    ),
    payload: v.string(),
    createdAt: v.number(),
  })
    .index("by_receiverParticipantId_and_createdAt", ["receiverParticipantId", "createdAt"])
    .index("by_meetingId_and_createdAt", ["meetingId", "createdAt"]),

  meeting_reactions: defineTable({
    meetingId: v.id("meetings"),
    senderParticipantId: v.id("meeting_participants"),
    senderName: v.string(),
    emoji: v.union(
      v.literal("👍"),
      v.literal("❤️"),
      v.literal("👏"),
      v.literal("🎉"),
      v.literal("😂"),
      v.literal("😮"),
    ),
    createdAt: v.number(),
  })
    .index("by_meetingId_and_createdAt", ["meetingId", "createdAt"])
    .index("by_senderParticipantId_and_createdAt", ["senderParticipantId", "createdAt"]),

  tasks: defineTable({
    orgId: v.string(),
    meetingId: v.optional(v.id("meetings")),
    title: v.string(),
    status: v.union(v.literal("open"), v.literal("in_progress"), v.literal("done")),
    assigneeName: v.optional(v.string()),
    assigneeTokenIdentifier: v.optional(v.string()),
    suggestedAssigneeName: v.optional(v.string()),
    dueAt: v.optional(v.number()),
    source: v.union(v.literal("manual"), v.literal("summary")),
    completedAt: v.optional(v.number()),
    completedByTokenIdentifier: v.optional(v.string()),
    completedByName: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
    // Ecosystem connector (CP1) — additive, all optional.
    createdVia: v.optional(createdViaValidator),
    externalRef: v.optional(externalRefValidator),
    metadataJson: v.optional(v.string()),
  })
    .index("by_orgId_and_status", ["orgId", "status"])
    .index("by_orgId", ["orgId"])
    .index("by_meetingId", ["meetingId"]),

  integrations: defineTable({
    orgId: v.string(),
    key: v.string(),
    name: v.string(),
    category: v.string(),
    description: v.string(),
    connected: v.boolean(),
    updatedAt: v.number(),
  }).index("by_orgId", ["orgId"]),

  user_integrations: defineTable({
    userTokenIdentifier: v.string(),
    provider: v.literal("google_calendar"),
    accountEmail: v.string(),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    scope: v.array(v.string()),
    tokenExpiresAt: v.number(),
    status: v.union(
      v.literal("connected"),
      v.literal("error"),
      v.literal("revoked"),
    ),
    lastError: v.optional(v.string()),
    connectedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userTokenIdentifier_and_provider", ["userTokenIdentifier", "provider"])
    .index("by_provider_and_accountEmail", ["provider", "accountEmail"]),

  notion_integrations: defineTable({
    userTokenIdentifier: v.string(),
    orgId: v.string(),
    workspaceId: v.optional(v.string()),
    workspaceName: v.optional(v.string()),
    workspaceIcon: v.optional(v.string()),
    botId: v.string(),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    tokenType: v.optional(v.string()),
    duplicatedTemplateId: v.optional(v.string()),
    targetPageId: v.optional(v.string()),
    status: v.union(
      v.literal("connected"),
      v.literal("error"),
      v.literal("revoked"),
    ),
    lastError: v.optional(v.string()),
    connectedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userTokenIdentifier_and_orgId", ["userTokenIdentifier", "orgId"])
    .index("by_orgId", ["orgId"]),

  meeting_exports: defineTable({
    meetingId: v.id("meetings"),
    provider: v.literal("notion"),
    externalId: v.optional(v.string()),
    externalUrl: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("exported"),
      v.literal("failed"),
    ),
    lastError: v.optional(v.string()),
    exportedByTokenIdentifier: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_meetingId_and_provider", ["meetingId", "provider"]),

  summary_chunks: defineTable({
    meetingId: v.id("meetings"),
    chunkIndex: v.number(),
    summary: v.string(),
    key_points: v.array(v.string()),
    decisions: v.array(v.string()),
    createdAt: v.number(),
  })
    .index("by_meetingId", ["meetingId"])
    .index("by_meetingId_and_chunkIndex", ["meetingId", "chunkIndex"]),

  // ─────────────────────────────────────────────────────────────────────────
  // Ecosystem Connector Protocol v1 (CP1). See docs/CONNECTOR.md.
  // None of these tables are touched unless CONNECTOR_ENABLED=true.
  // Retention is enforced by the daily cron in convex/crons.ts.
  // ─────────────────────────────────────────────────────────────────────────

  // Single-use OAuth authorization codes (TTL 60 s). Only the HMAC is stored.
  connector_codes: defineTable({
    codeHash: v.string(),
    clientId: v.string(),
    userTokenIdentifier: v.string(),
    orgId: v.string(),
    scopes: v.array(v.string()),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    expiresAt: v.number(),
    // Set when the code is redeemed. A second redemption revokes `grantId`.
    usedAt: v.optional(v.number()),
    grantId: v.optional(v.id("connector_grants")),
  })
    .index("by_codeHash", ["codeHash"])
    .index("by_expiresAt", ["expiresAt"]),

  // One grant = one user's consent for one org with a set of scopes. The grant
  // row doubles as the refresh-token family: tokens rotate in place.
  connector_grants: defineTable({
    clientId: v.string(),
    userTokenIdentifier: v.string(),
    orgId: v.string(),
    scopes: v.array(v.string()),
    accessHash: v.string(),
    accessExpiresAt: v.number(),
    refreshHash: v.string(),
    refreshExpiresAt: v.number(),
    refreshFamilyId: v.string(),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    revokedReason: v.optional(v.string()),
  })
    .index("by_accessHash", ["accessHash"])
    .index("by_refreshHash", ["refreshHash"])
    .index("by_userTokenIdentifier_and_orgId", ["userTokenIdentifier", "orgId"])
    .index("by_orgId_and_revokedAt", ["orgId", "revokedAt"])
    .index("by_revokedAt", ["revokedAt"]),

  // Tombstones of rotated refresh tokens so re-use can be detected exactly
  // (token-family theft detection, RFC 6819 §5.2.2.3).
  connector_refresh_history: defineTable({
    refreshHash: v.string(),
    grantId: v.id("connector_grants"),
    retiredAt: v.number(),
  })
    .index("by_refreshHash", ["refreshHash"])
    .index("by_grantId", ["grantId"])
    .index("by_retiredAt", ["retiredAt"]),

  connector_webhooks: defineTable({
    grantId: v.id("connector_grants"),
    orgId: v.string(),
    url: v.string(),
    // Exact event types or `prefix.*`.
    events: v.array(v.string()),
    description: v.optional(v.string()),
    // AES-256-GCM, versioned. The plaintext secret is shown exactly once.
    secretEnc: v.string(),
    status: v.union(v.literal("active"), v.literal("disabled")),
    disabledReason: v.optional(v.string()),
    disabledAt: v.optional(v.number()),
    consecutiveFailures: v.number(),
    firstFailureAt: v.optional(v.number()),
    lastDeliveryAt: v.optional(v.number()),
    lastDeliveryStatus: v.optional(
      v.union(v.literal("succeeded"), v.literal("failed")),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_grantId", ["grantId"])
    .index("by_orgId_and_status", ["orgId", "status"]),

  // Transactional outbox AND the per-org event log served by GET /events.
  // `seq` is a gap-free, commit-ordered counter per org (see
  // connector_event_counters) so pollers can never skip an event.
  connector_events: defineTable({
    orgId: v.string(),
    seq: v.number(),
    eventId: v.string(),
    type: v.string(),
    occurredAt: v.number(),
    actor: v.object({
      id: v.string(),
      name: v.string(),
      kind: v.union(
        v.literal("user"),
        v.literal("system"),
        v.literal("connector"),
      ),
    }),
    externalRef: v.optional(externalRefValidator),
    data: v.any(),
    // Used for exactly-once emission and in-place coalescing.
    dedupeKey: v.optional(v.string()),
  })
    .index("by_orgId_and_seq", ["orgId", "seq"])
    .index("by_orgId_and_type", ["orgId", "type"])
    .index("by_orgId_and_dedupeKey", ["orgId", "dedupeKey"])
    .index("by_eventId", ["eventId"]),

  connector_event_counters: defineTable({
    orgId: v.string(),
    nextSeq: v.number(),
  }).index("by_orgId", ["orgId"]),

  connector_deliveries: defineTable({
    eventId: v.id("connector_events"),
    webhookId: v.id("connector_webhooks"),
    orgId: v.string(),
    // Stable across retries; sent as X-CP-Delivery.
    deliveryUuid: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    attempts: v.number(),
    nextAttemptAt: v.number(),
    lastAttemptAt: v.optional(v.number()),
    lastResponseCode: v.optional(v.number()),
    lastResponseBody: v.optional(v.string()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_status_and_nextAttemptAt", ["status", "nextAttemptAt"])
    .index("by_webhookId", ["webhookId"])
    .index("by_eventId", ["eventId"]),

  connector_operations: defineTable({
    grantId: v.id("connector_grants"),
    orgId: v.string(),
    action: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("canceled"),
    ),
    output: v.optional(v.any()),
    error: v.optional(
      v.object({ code: v.string(), message: v.string() }),
    ),
    createdAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("by_grantId", ["grantId"]),

  connector_idempotency: defineTable({
    grantId: v.id("connector_grants"),
    key: v.string(),
    requestHash: v.string(),
    status: v.number(),
    // JSON-encoded response body, replayed verbatim.
    response: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_grantId_and_key", ["grantId", "key"])
    .index("by_expiresAt", ["expiresAt"]),

  // Connector call log (CP1 §6). Never stores request payloads.
  connector_audit: defineTable({
    orgId: v.string(),
    grantId: v.id("connector_grants"),
    clientId: v.string(),
    userTokenIdentifier: v.string(),
    via: v.literal("connector"),
    action: v.string(),
    method: v.string(),
    status: v.number(),
    ok: v.boolean(),
    errorCode: v.optional(v.string()),
    requestId: v.string(),
    meetingId: v.optional(v.id("meetings")),
    createdAt: v.number(),
  })
    .index("by_orgId_and_createdAt", ["orgId", "createdAt"])
    .index("by_grantId_and_createdAt", ["grantId", "createdAt"])
    .index("by_createdAt", ["createdAt"]),

  // Fixed-window rate limit counters, shared across all instances.
  connector_ratelimits: defineTable({
    grantId: v.id("connector_grants"),
    // e.g. "rpm:29012345" (minute epoch) or "notif:29012345".
    bucket: v.string(),
    count: v.number(),
    expiresAt: v.number(),
  })
    .index("by_grantId_and_bucket", ["grantId", "bucket"])
    .index("by_expiresAt", ["expiresAt"]),
});
