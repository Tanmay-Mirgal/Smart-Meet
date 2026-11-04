# Application Architecture Document

## Overview
This document outlines the architecture, technology stack, and file system structure of the **Meetup** application. The application is a real-time collaborative platform that allows users to create, schedule, and join video meetings directly within the app, transcribe conversations, and manage meeting assets and organizations.

## Tech Stack
- **Frontend Framework**: Next.js 16 (App Router) & React 19
- **Backend & Database**: Convex (Serverless functions and real-time database)
- **Authentication**: Clerk (with Convex integration)
- **Styling**: Tailwind CSS v4
- **UI Components**: Shadcn UI, Radix UI primitives, Base UI
- **Icons**: Lucide React
- **Real-time Communication**: Native WebRTC (for peer-to-peer audio/video streaming)

---

## High-Level Architecture Flow
1. **Authentication (Clerk)**: Users authenticate via Clerk. Route protection is handled via Next.js middleware (`proxy.ts`), which ensures unauthorized users cannot access the dashboard or meeting rooms. 
2. **Data Sync (Convex)**: The user and organization data is synchronized between Clerk and the Convex database either via direct mutations from the client or through webhooks.
3. **Dashboard & Organization**: Upon login, users land on the Dashboard where they can manage their organizations, view insights, handle tasks, and see upcoming/past meetings.
4. **Meeting Room & WebRTC**:
   - The user joins a meeting interface (`app/(meeting-room)/meeting/`).
   - A custom WebRTC hook (`hooks/use-webrtc.ts`) manages access to user media (camera/microphone).
   - Peer connections are established directly between participants utilizing Google's STUN servers. Convex acts as the signaling server to exchange ICE candidates and session descriptions real-time.
5. **Real-time Engine**: All chat, live transcripts, notifications, and meeting states are managed by Convex queries and mutations, providing a reactive end-to-end experience.

---

## File System & Directory Structure

```text
meetup/
├── app/                        # Next.js App Router root
│   ├── (auth)/                 # Route group for Clerk Sign-in/Sign-up pages
│   ├── (dashboard)/            # Dashboard routes (insights, meetings, settings, tasks, organization)
│   ├── (meeting-room)/         # Active video meeting room UI
│   ├── (onboarding)/           # New user onboarding flow
│   ├── api/                    # Next.js API Routes (e.g., Clerk webhooks)
│   ├── providers/              # React Context Providers (ConvexClientProvider, Theme provider, etc.)
│   └── layout.tsx & page.tsx   # Root layout and landing page
│
├── components/                 # React Components
│   ├── ui/                     # Reusable Shadcn UI components (buttons, dialogs, cards, etc.)
│   ├── dashboard/              # Dashboard-specific widgets and layouts
│   ├── meeting/                # Meeting room specific components (video grids, controls)
│   ├── layout/                 # Structural components (Sidebar, Topbar)
│   └── providers.tsx           # Global provider wrapper export
│
├── convex/                     # Backend Logic & Database
│   ├── schema.ts               # Defines tables (users, organizations, meetings, transcripts, etc.)
│   ├── auth.config.ts          # Clerk JWT validation config for Convex
│   ├── http.ts                 # HTTP endpoints for Convex (e.g., webhook receivers)
│   ├── users.ts, meetings.ts   # Serverless functions (queries/mutations) for respective domains
│   └── notifications.ts        # Notification management logic
│
├── hooks/                      # Custom React Hooks
│   ├── use-webrtc.ts           # Handles WebRTC local streams, peer connections, and track management
│   ├── use-transcription.ts    # Speech-to-text logic for active meetings
│   └── use-mobile.ts           # Responsive layout hook
│
├── lib/                        # Utility functions
│   └── utils.ts                # Tailwind class merging (`cn`)
│
├── proxy.ts                    # Next.js Middleware (Clerk route protection logic)
└── package.json                # Project dependencies and scripts
```

---

## Database Schema (Convex)
The application utilizes a strongly-typed schema defined in `convex/schema.ts`.

### 1. `users`
- Stores user data synchronized from Clerk.
- Fields: `clerkId`, `email`, `firstName`, `lastName`, `imageUrl`, `orgIds` (Array of organization IDs).

### 2. `organizations`
- Represents tenant workspaces/organizations.
- Fields: `clerkId`, `name`, `slug`, `imageUrl`.

### 3. `meetings`
- Central entity representing a video conference.
- Fields: 
  - `orgId`, `creatorId`: References to organization and the user who created it.
  - `title`, `purpose`, `description`.
  - `status`: Literal union of `"scheduled" | "active" | "ended"`.
  - `scheduledFor`, `startedAt`, `endedAt`: Timestamps of the meeting lifecycle.

### 4. `transcripts`
- Stores active transcriptions tied to a specific meeting.
- Fields: `meetingId`, `speakerId`, `speakerName`, `text`, `timestamp`.

### 5. `meeting_assets`
- Stores generated assets from a finished meeting.
- Fields: `meetingId`, `type` (`"summary"` | `"recording"`), `content` (Markdown), and an optional `storageId` for larger binary files referencing Convex's generic storage.

### 6. `notifications`
- App-wide user alerts.
- Fields: `userId`, `orgId`, `message`, `link`, `isRead`, `createdAt`.
