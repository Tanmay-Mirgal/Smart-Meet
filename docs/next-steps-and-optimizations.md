# Meetup: Next Features and Optimization Roadmap

This document lists the highest-value improvements that can be implemented next in this application. It is split into:

- product/features to expand the platform
- engineering optimizations to improve reliability, scale, and performance

The suggestions assume the current app already supports:

- organizations and users
- meeting creation and scheduling
- WebRTC audio/video/screen share
- chat and transcript capture
- AI summary generation
- task generation from summaries
- meeting roles, permissions, lobby, and moderation

## 1. Highest-Value Product Features

### A. Invite Management UI

Current gap:
- invite-only access exists server-side, but there is no dedicated invite management surface

Implement:
- invite people by email in meeting creation flow
- invite panel inside the meeting settings modal
- resend/cancel invites
- invite status: pending, accepted, expired

Why it matters:
- completes the permissions system
- makes invite-only meetings usable in practice

### B. Recording and Playback

Implement:
- cloud recording metadata model
- start/stop recording controls for host/co-host
- meeting recordings tab in meeting details
- playback with transcript and summary sync

Why it matters:
- turns meetings into durable assets, not just live sessions

### C. Reactions and Raise Hand

Implement:
- emoji reactions
- raise-hand queue
- host/co-host “lower hand” action
- transient realtime events for reactions

Why it matters:
- improves meeting UX without heavy backend cost

### D. Breakout Rooms

Implement:
- create breakout sessions from a main meeting
- move participants between rooms
- room timers and broadcast announcements

Why it matters:
- strong differentiator for team workshops and training meetings

### E. Calendar and External Meeting Integrations

Implement:
- Google Calendar / Outlook sync
- auto-create meeting links from calendar events
- import attendee list from scheduled event
- post-meeting summary delivery to Slack/Email/Notion

Why it matters:
- integrates the product into real team workflows

### F. Meeting Templates

Implement:
- recurring defaults for settings, agenda, permissions, invitees
- templates for standup, interview, sales call, review, workshop

Why it matters:
- reduces setup friction
- standardizes operations across orgs

### G. Post-Meeting Intelligence

Implement:
- searchable meeting knowledge base
- action item ownership tracking
- decision log timeline
- cross-meeting topic clustering

Why it matters:
- makes the app useful even after the call ends

## 2. Permissions System Follow-Ups

These are the most important follow-ups after the newly added roles system.

### A. Temporary Permissions

Implement:
- allow screen share for 5 minutes
- allow unmute temporarily
- temporary presenter role

Suggested model:
- `expiresAt` on permission override records

### B. Custom Role Templates

Implement:
- org-defined custom roles
- reusable permission bundles

Suggested model:
- `meeting_role_templates` table at org scope
- meeting participant rows reference template + overrides

### C. Invite Audit and Role History

Implement:
- who invited whom
- who promoted/demoted whom
- who muted/removed whom

Suggested UI:
- audit tab in meeting details

## 3. Realtime and WebRTC Improvements

### A. TURN Hardening

Implement:
- managed TURN infrastructure
- multiple TURN regions
- health fallback strategy

Why:
- required for reliable corporate/firewalled environments

### B. Simulcast / Adaptive Quality

Implement:
- simulcast encodings for camera
- dynamic downscaling for large meetings
- prioritize active speaker and presentation track

Why:
- essential for 20+ participant meetings

### C. Active Speaker Detection

Implement:
- serverless/local audio level detection
- active speaker highlight
- dominant speaker pinning

Why:
- improves call readability immediately

### D. Network Resilience

Implement:
- better reconnect/backoff flow
- participant “reconnecting” state
- stale peer cleanup metrics

Why:
- reduces silent media failure states

### E. Device Management

Implement:
- mic/camera/speaker selector
- device hot-swap
- preview before join

Why:
- needed for production-grade meetings

## 4. Dashboard and Collaboration Enhancements

### A. Better Dashboard Signals

Implement:
- live participant counts
- waiting room alerts
- meeting health summary
- “needs follow-up” meetings

### B. Search Everywhere

Implement:
- search meetings, transcripts, summaries, tasks, participants
- filter by org member, date, meeting type

### C. Notification Center Expansion

Implement:
- lobby requests
- role changes
- meeting started/ending soon
- task assignment notifications

## 5. Scalability and Performance Optimizations

### A. Query Pagination

Current risk:
- several list queries use fixed `take(...)`

Optimize:
- paginate participants, transcripts, messages, notifications, audit logs
- use cursor-based pagination for large rooms and history views

### B. Reduce N+1 Convex Queries

Current risk:
- dashboard summary lookups do per-meeting asset reads

Optimize:
- store `latestSummaryAt` / `hasSummary` on meeting
- denormalize small dashboard-safe fields

### C. Transcript and Summary Chunking

Optimize:
- batch transcript writes more aggressively
- chunk long transcript processing
- add background summarization for long meetings

### D. Memoize Expensive UI Lists

Optimize:
- virtualize transcript and chat lists
- avoid re-rendering all participant tiles on every participant state change
- split participant state from media state where possible

### E. Media Resource Lifecycle

Optimize:
- stronger cleanup on role/status transitions
- stop local capture immediately when lobby/removed state occurs
- avoid unnecessary peer rebuilds when participant metadata changes

## 6. Reliability and Security Optimizations

### A. Convex Access Hardening

Implement:
- replace remaining `assertOrgAccess` hard-fail dashboard-style queries with safe empty-state queries where appropriate
- keep mutations strict, but keep read models resilient

### B. Stronger Moderation Enforcement

Implement:
- if user is muted by host, block local unmute until permission returns
- if removed from meeting, immediately tear down signaling/media client-side

### C. Input Validation and Abuse Controls

Implement:
- rate limits on chat and signaling write paths
- payload size limits for messages/transcript chunks
- invite spam protections

### D. Audit and Incident Visibility

Implement:
- admin-facing moderation audit screen
- suspicious event logging
- error tagging by org/meeting/user

## 7. Observability and QA

### A. Structured Logging

Implement:
- structured logs for meeting lifecycle, join decisions, moderation actions, signaling state changes

### B. Product Analytics

Track:
- join success rate
- lobby-to-admit conversion
- screen share success/failure
- summary generation latency
- reconnect rate

### C. Automated Testing

Add:
- unit tests for permission resolution
- Convex handler tests for join modes and moderation
- component tests for people panel and waiting room
- Playwright flows for join, admit, promote, mute, remove, lock meeting

## 8. UX Improvements

### A. Pre-Join Screen

Implement:
- camera/mic preview
- device checks
- join settings preview

### B. Better In-Meeting Layout Controls

Implement:
- pin participant
- focus presentation mode
- compact people rail
- floating transcript

### C. Cleaner Meeting Details

Implement:
- summary, transcript, tasks, recording, audit tabs
- export transcript and summary

## 9. Suggested Build Order

### Phase 1: Complete the Core Meeting Experience

1. Invite management UI
2. pre-join screen
3. active speaker detection
4. better device management
5. client enforcement for lobby/removed states

### Phase 2: Improve Team Workflow Value

1. recording and playback
2. notification center expansion
3. search across summaries and transcripts
4. calendar integrations
5. meeting templates

### Phase 3: Scale and Differentiate

1. simulcast/adaptive quality
2. breakout rooms
3. custom role templates
4. knowledge base and cross-meeting intelligence

## 10. Best Optimization Wins for This Codebase Right Now

If you want the best return with the least churn, do these next:

1. Add invite management UI to complete the new permissions backend
2. Make dashboard/read queries resilient to membership sync lag everywhere
3. Add automated tests for join modes, lobby, mute/remove, and host transfer
4. Add pre-join device preview and selector
5. Implement active speaker detection and pin/focus layout
6. Denormalize dashboard summary fields to avoid N+1 reads
7. Add pagination/virtualization for transcripts, notifications, and messages
8. Improve TURN/network resilience for real-world usage

## 11. If You Want a More Ambitious Direction

This app can evolve into one of three product directions:

### A. Meeting Operations Platform

Focus on:
- permissions
- moderation
- compliance
- audit logs
- recording

### B. AI Meeting Workspace

Focus on:
- summaries
- decisions
- tasks
- search
- post-meeting intelligence

### C. Internal Team Collaboration Suite

Focus on:
- calendar integrations
- notifications
- templates
- recurring workflows
- org-wide analytics

The strongest path for this codebase is probably:

- short term: Meeting Operations Platform
- medium term: AI Meeting Workspace

