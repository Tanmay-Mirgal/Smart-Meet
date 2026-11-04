
Here is a **clean, production-grade Codex prompt (in proper Markdown)** that you can directly use to optimize your current implementation, improve architecture, and extend features — based strictly on your existing system snapshot .

---

# 🚀 Codex Optimization Prompt — Meetup (Next.js + Convex + WebRTC + AI)

## 📌 Context

You are working on a **real-time AI-powered meeting platform** built with:

* Next.js 16 (App Router) + React 19
* Convex (database + realtime backend)
* Clerk (authentication + organizations)
* WebRTC (peer-to-peer media)
* Groq APIs (Whisper transcription + LLM summarization)

The system already supports:

* Authentication + org-based tenancy
* Real-time meetings with WebRTC
* Chat, transcripts, summaries, and tasks
* Convex-powered reactive state
* AI summaries with action items
* Basic notifications, insights, and task management

However, this is still a **prototype system** with limitations in:

* Security & authorization
* WebRTC reliability (STUN-only)
* Task workflows
* Integrations (partial)
* Meeting lifecycle rules
* Scalability & performance

---

# 🎯 Objective

Refactor and optimize the current implementation to:

1. Improve **performance and scalability**
2. Enforce **proper architecture and separation of concerns**
3. Harden **security and authorization**
4. Enhance **real-time reliability (WebRTC + Convex)**
5. Extend **product features to production-level**
6. Ensure **all integrations work correctly and are production-ready**

---

# ⚙️ PART 1 — Code & Architecture Optimization

## 🔹 1. Convex Backend Improvements

### Problems

* Weak authorization checks
* Overloaded mutations
* Missing indexing strategies
* Realtime subscriptions may over-fetch

### Required Improvements

* Implement **strict org-level and meeting-level authorization guards**
* Add **row-level security patterns**
* Split large mutations into:
  * command handlers
  * validation layer
  * domain services
* Introduce **Convex indexes** for:
  * meetings by orgId + status
  * transcripts by meetingId + timestamp
  * messages by meetingId + createdAt
* Implement:

```ts
assertOrgAccess(user, orgId)
assertMeetingAccess(user, meetingId)
```

---

## 🔹 2. WebRTC Optimization

### Problems

* STUN-only → fails behind NAT/firewalls
* Convex used as signaling store → latency risk
* Mesh architecture → not scalable

### Required Improvements

* Add **TURN server support** (e.g., Coturn)
* Implement:
  * fallback ICE configuration
* Optimize signaling:
  * batch ICE candidates
  * reduce DB writes
* Add connection state monitoring:

```ts
pc.onconnectionstatechange
```

* Optional (advanced):
  * introduce **SFU (Selective Forwarding Unit)** architecture

---

## 🔹 3. Transcription Pipeline Optimization

### Problems

* Only local mic transcription
* No speaker separation
* No streaming pipeline

### Required Improvements

* Add:
  * multi-speaker tagging
  * speaker diarization logic (even heuristic)
* Introduce:
  * streaming transcription (WebSocket-based)
* Batch processing optimization:
  * adaptive chunking
  * retry + fallback mechanism

---

## 🔹 4. AI Summarization Improvements

### Problems

* Entire transcript sent → inefficient
* No incremental intelligence

### Required Improvements

* Implement:
  * chunk-based summarization pipeline
  * summary merging strategy
* Add:
  * incremental summary updates
* Cache summaries using:

```ts
summary_chunks
```

---

## 🔹 5. Frontend Optimization (React + Next.js)

### Problems

* Over-reliance on Convex subscriptions
* Possible unnecessary re-renders

### Required Improvements

* Use:
  * React memoization (`useMemo`, `useCallback`)
  * component splitting
* Introduce:
  * suspense boundaries
  * lazy loading for heavy components
* Optimize:
  * participant grid rendering
  * transcript rendering (virtualization)

---

# 🔐 PART 2 — Security Hardening

## Required Fixes

* Enforce:
  * org isolation (strict)
  * meeting access validation
* Validate all:
  * Convex mutations
  * API routes
* Prevent:
  * unauthorized transcript access
  * message injection
* Add:
  * rate limiting for APIs
  * input sanitization
* Secure:
  * Groq API calls (server-only usage)

---

# ⚡ PART 3 — Performance & Scaling

## Required Improvements

* Reduce Convex writes:
  * batch signals
  * batch transcript inserts
* Introduce:
  * caching layer (client + server)
* Optimize:
  * dashboard queries
  * insights queries
* Add:
  * background jobs (cron-like system)
    * scheduled meetings
    * reminders
    * summary generation

---

# 🧩 PART 4 — Feature Enhancements (HIGH VALUE)

## 🔹 1. Meeting System

* Do NOT end meeting when a user leaves
* Add:
  * host role
  * co-host support
* Meeting states:
  * scheduled → active → ended → archived

---

## 🔹 2. Recording System

* Implement:
  * media recording (MediaRecorder API)
  * upload to storage (S3 / Cloudflare R2)
* Store in:

```ts
meeting_assets.type = "recording"
```

* Add playback UI in meeting details

---

## 🔹 3. Task Management (Upgrade to Full System)

Add:

* edit tasks
* mark complete
* assign users
* due dates
* priority levels
* task comments

---

## 🔹 4. Integrations (MAKE THEM REAL)

Implement actual working integrations:

### Google Calendar

* create events
* sync scheduled meetings

### Zoom / Meet

* external meeting links

### Slack

* send:
  * meeting alerts
  * summary messages

---

## 🔹 5. Notifications System Upgrade

* Add:
  * real-time push notifications
  * email notifications
  * reminder system

---

## 🔹 6. Insights & Analytics (AI-powered)

Add:

* speaker talk-time analysis
* sentiment analysis
* keyword extraction
* meeting productivity score

---

## 🔹 7. Search & UX Improvements

* transcript search
* filters (speaker, time)
* timeline UI
* highlight key moments

---

# 🧠 PART 5 — Advanced AI Features

Add:

* real-time AI assistant inside meeting
* ask questions on transcript
* auto-generated follow-ups
* meeting Q&A chatbot

---

# 🧱 PART 6 — DevOps & Reliability

## Required Improvements

* Add:
  * error boundaries
  * logging system (Sentry)
* Improve:
  * environment handling
* Ensure:
  * production build stability
* Add:
  * retry logic for APIs
  * fallback states

---

# 📦 PART 7 — Deliverables Expected from Codex

1. Refactored backend logic (Convex modules)
2. Improved WebRTC hook
3. Secure API routes
4. Optimized React components
5. Integration implementations
6. New feature modules (tasks, recordings, analytics)
7. Scalable architecture patterns

---

# ⚠️ Constraints

* Do NOT break existing functionality
* Maintain:
  * Clerk auth integration
  * Convex backend compatibility
  * Next.js App Router structure
* All changes must be:
  * backward compatible
  * production-ready
  * scalable

---

# ✅ Final Goal

Transform this system from a **prototype meeting tool → production-grade AI meeting platform** with:

* strong real-time performance
* secure multi-tenant architecture
* reliable media + AI pipelines
* full collaboration workflows
* working integrations

---

If you want, I can next:

* convert this into **step-by-step implementation tasks**
* or generate **actual optimized code for Convex/WebRTC parts**
* or design **system architecture v2 diagram (very useful for interviews + projects)**
