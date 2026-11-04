/** Plan copy shared by the marketing site and the in-app billing page. */

export const FREE_FEATURES = [
  "Up to 10 meetings",
  "Live meeting rooms",
  "Team invitations & chat",
  "Real-time whiteboard",
  "Basic dashboard",
] as const;

export const PRO_FEATURES = [
  "Unlimited meetings",
  "AI-powered summaries",
  "Action item tracking",
  "Minutes of meetings (PDF)",
  "Notion export",
  "Browser recordings",
  "Google Calendar sync",
  "Priority support",
] as const;

export const PRO_PRICE = {
  usd: 10,
  inr: 849,
} as const;
