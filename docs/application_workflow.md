# Application Workflow: Meetup

## 1. Onboarding & Authentication Workflow
- **Landing Page:** User arrives at the Marketing page outlining the value of Meetup (pricing, features).
- **Sign Up / Sign In:** User clicks "Get Started" and is redirected to Clerk's hosted or custom-styled Auth UI.
- **Organization Setup:** Upon first login, Clerk prompts the user to create an Organization (Workspace) or join an existing one. 
- **Subscription Check:** Validates the organization's tier via Clerk+Stripe. Free tiers have usage limits (e.g., 5 meeting transcripts/month).

## 2. Main Dashboard (Meeting Workspace)
- **Default View:** User lands on the Dashboard, an "Editorial" style grid of recent meetings, upcoming schedules, and macro-level AI insights.
- **Data Hydration:** The dashboard uses Convex `useQuery` to fetch meeting data for the active Organization ID in real-time.
- **Navigation:** Sidebar navigation routes between Dashboard, All Meetings, Team Insights, and Settings.

## 3. The Core Loop: Meeting Ingestion & Analysis
- **Step A: Capture**
  - User records a meeting (uploading A/V file) OR connects an integration (e.g., Zoom bot).
  - Webhook or client mutation uploads the raw data to a secure storage bucket (e.g., Convex Storage).
- **Step B: Processing**
  - Convex `mutation` fires, creating a "Pending" meeting record.
  - A background Convex `action` calls an AI transcription service (e.g., AssemblyAI or Whisper API).
  - The UI (via real-time Convex subscription) shows the meeting status as "Processing" with an AI Pulse indicator.
- **Step C: Analysis & Synthesis**
  - Once transcribed, another AI pass generates the Meeting Summary, Action Items, and Sentiment Analysis.
  - Results are written back to the Convex database.
- **Step D: Real-Time Reveal**
  - The UI updates instantly. The user sees the meeting transition from "Processing" to "Ready" without refreshing the page.

## 4. Meeting Details & Insights
- **The "Digital Curator" View:** User clicks into a completed meeting. 
- **Layout:**
  - **Left/Top:** High-level AI Summary & Action Items presented as premium editorial cards.
  - **Right/Bottom:** The full interactive transcript. Clicking a transcript line jumps the embedded video/audio player to the corresponding timestamp.
- **Interaction:** User can edit action items, highlight key quotes, or "share" a polished meeting brief with external stakeholders via a public/private link securely managed by Convex rules.

## 5. Account & Org Management
- **Settings:** Rendered via Clerk's `<OrganizationProfile />` and `<UserProfile />` components (styled to match the application).
- **Billing:** Users upgrade via a Stripe Customer Portal embedded or linked from the settings page, automatically updating the Clerk metadata upon successful payment.
