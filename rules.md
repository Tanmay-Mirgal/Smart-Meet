# Meetup: Production & Architecture Rules

This document outlines the strict engineering, design, and architecture rules for the Meetup project. Any code written or modified must adhere to these standards to maintain a robust, scalable, and premium application.

---

## 1. File & Project Architecture
- **Naming Conventions:** All files and directories must use `kebab-case` (e.g., `components/meeting/video-grid.tsx`, `hooks/use-webrtc.ts`).
- **Framework:** Next.js 15+ App Router (`app/` directory).
- **Component Colocation:** Keep smaller component-specific files (e.g., specific hooks or sub-components) next to the component they belong to when not reusable.
- **Root Directory:** Keep configuration minimal. Follow standard Next.js layouts (`layout.tsx`, `page.tsx`, `loading.tsx`, `error.tsx`).

---

## 2. Advanced TypeScript & Strict Typings
- **No `any` or `Unknown` Casting:** Use strict typings. If a type is unknown, use `unknown` and implement type guards/narrowing.
- **Discriminated Unions over Optionals:** Avoid objects with many optional properties if they represent distinct states. Use Discriminated Unions for complex component states or data fetching states:
  ```ts
  type APIState<T> =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'success'; data: T }
    | { status: 'error'; error: Error };
  ```
- **Generics for Reusability:** When building highly reusable utility functions or generic components (e.g., data tables, list renderers), use Generics to ensure end-to-end type safety.
- **Strict Null Checks:** Always handle `null` and `undefined` explicitly. Do not use the non-null assertion operator (`!`).
- **Interface Naming:** Do not prefix interfaces with `I` (e.g., use `MeetingProps` instead of `IMeetingProps`).

---

## 3. UI/UX & Design System Constraints (The Digital Curator)
All UI components **must** adhere to the "Editorial Intelligence / Soft Minimalism" rules defined in `docs/design.md`.

- **Library:** Use `shadcn/ui` with `lucide-react` icons. Do not bring in competing component libraries.
- **The "No-Line" Rule:** 1px solid borders for structural sectioning are prohibited. Use background tonal shifts (`surface`, `surface-container-low`, `surface-container-highest`) and padding to separate semantic blocks. Use "Ghost Borders" (e.g., `border-outline-variant/10`) only when defining elevated cards.
- **Glassmorphism & Depth:** Utilize soft backdrop-blurs (`backdrop-blur-md`) and translucent backgrounds (`bg-surface-variant/80`) for floating UI elements like navigation bars and controls. Use shadow classes sparingly; instead, rely on the stacking context of tonal layers.
- **Typography:**
  - Headers/Display: `font-sans` (Manrope) for authoritative, tech-forward impact.
  - Body/Metadata/Labels: `font-sans` (Inter) for functional density.
- **Colors:** Do not use plain tailwind colors (`blue-500`, `gray-900`); use the semantic design tokens wrapped in the Tailwind configuration (`bg-primary`, `text-on-surface`, `bg-error`, `text-on-surface-variant`).

---

## 4. Application Workflow & External Integration Layer
As dictated by `docs/application_workflow.md` and `docs/architecture.md`:

### A. Authentication & User Management (Clerk)
- **Gatekeeping:** Use Next.js Middleware with Clerk to secure routes.
- **Tenancy:** Always scope database queries to the active Clerk Organization ID. The user's active org dictates their data view.
- **Billing:** Gate premium UI features behind checks for the organization's subscription tier.

### B. Database & Real-time Connectivity (Convex)
- **Data Fetching:** Do not use traditional `fetch` loops for database operations. Use Convex's exported `useQuery` and `useMutation` hooks to guarantee real-time sync across the application.
- **Strict Typing:** All Convex queries and mutations must have heavily typed argument validators and return types matching the frontend expectations.
- **Signaling:** WebRTC signaling (ICE candidates, Session Descriptions) should be routed through Convex real-time mutations to replace the need for an external WebSocket/Socket.io server.

### C. WebRTC & Media Handling
- **Native APIs:** Use native `RTCPeerConnection` and `navigator.mediaDevices` housed inside custom, strictly typed hooks (`use-webrtc.ts`).
- **Graceful Degradation:** Always catch `.getUserMedia()` errors and provide fallback UI to the user (e.g., "Device not found" or "Permissions denied").
- **Resource Management:** Ensure cleanup functions in `useEffect` rigorously close tracks (`track.stop()`) and connections (`pc.close()`) to prevent memory/camera-light leaks.

---

## 5. Production Needs
- **Accessibility (a11y):** All interactive elements must have semantic tags (`<button>`, `<a>`) or aria equivalent roles. Support keyboard navigation. `shadcn/ui` components provide this out-of-the-box, but custom components must enforce it.
- **Error Boundaries:** Wrap major dashboard features (e.g., Meeting Workspace, Video Grid) in React Error Boundaries to prevent total application crash on unhandled exceptions in the real-time layer.
- **Loading States:** Avoid flashing content or layout shift. Use Convex hydration boundaries or Skeleton loaders (`shadcn/ui` Skeleton) for queries that are actively fetching.
