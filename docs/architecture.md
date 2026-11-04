# Meetup: Architecture Plan

## Overview
Meetup follows a modern, serverless, and highly scalable architecture. The stack is designed for rapid iteration, real-time data sync, and seamless AI integration.

- **Frontend:** Next.js (App Router)
- **Database & Backend logic:** Convex
- **Authentication & User Management:** Clerk
- **Styling & UI:** Tailwind CSS + shadcn/ui

## System Components

### 1. Frontend Layer: Next.js (App Router)
Next.js acts as the core application framework, handling rendering, routing, and providing the UI.
- **Server Components (RSC):** Used by default for optimized performance, SEO, and secure data fetching (where applicable).
- **Client Components:** Used for interactive elements (dashboards, video players, real-time Convex subscriptions).
- **UI Architecture:** Built with Tailwind CSS and shadcn/ui on top of Radix UI primitives. The design system enforces "Soft Minimalism" and editorial typography setups.

### 2. Authentication & Tenancy Layer: Clerk
Clerk manages the entire user identity and organization lifecycle.
- **Authentication:** Handles Sign-up, Sign-in, and multifactor auth. 
- **Organizations (B2B/Tenancy):** Clerk Organizations feature acts as the core tenant boundary. Users belong to organizations, and all meeting data is associated with an organization.
- **Subscriptions & Billing:** Clerk integrates seamlessly with payment providers (e.g., Stripe) to gate features based on user/org subscription tiers (Free, Pro, Enterprise).
- **Middleware:** Next.js middleware using Clerk secures routes and redirects unauthenticated users automatically.

### 3. Database & Real-Time Sync Layer: Convex
Convex replaces a traditional database and API layer, providing a type-safe, real-time backend.
- **Document Store:** JSON-like documents store Users, Organizations, Meetings, Transcripts, and Insights.
- **Mutations & Queries:** Backend logic is encapsulated in Convex functions (TypeScript). 
- **Real-Time Subscriptions:** The Next.js frontend uses `useQuery` hooks to subscribe to query results. When a meeting transcript is processed by AI and saved to Convex, the UI updates instantly without polling.
- **Backend Auth Integration:** Clerk JWTs are passed securely to Convex to verify identity and organization context on every query/mutation, ensuring robust data isolation.

### 4. AI Processing Layer (External / Webhooks)
- **Ingestion:** Meetings, audio, or video files are ingested either directly or via third-party webhooks (e.g., Zoom/Google Meet integrations).
- **Processing:** Actions triggered within Convex (or via webhooks) call out to external AI APIs (e.g., OpenAI, AssemblyAI) to generate transcriptions, summaries, and action items.
- **Storage:** Results are written back to Convex, instantly completing the loop and updating the user's dashboard.

## Modular Data Flow
1. User logs in via **Clerk**.
2. **Next.js** authenticates the session and loads the UI.
3. Next.js connects to **Convex**, passing the Clerk JWT.
4. Convex validates the JWT and returns data (Meetings, Insights) scoped to the user's current Clerk Organization.
5. User initiates a meeting analysis -> **Convex Action** triggers AI processing -> **Convex Mutation** saves results -> **Next.js UI** updates in real-time.
