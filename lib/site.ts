/** Single source of truth for brand + SEO copy. */

export const SITE_NAME = "Meetup";
export const SITE_DOMAIN = "meetup.tanmaymirgal.dev";
export const SITE_TAGLINE = "Meetings that write their own minutes";

export const SITE_DESCRIPTION =
  "Meetup is the AI meeting workspace for modern teams — live video rooms, real-time Hindi, Marathi and English transcription, instant AI summaries, action items and ready-to-send minutes of meeting. Free to start.";

export const SITE_KEYWORDS = [
  "meetup",
  "AI meeting assistant",
  "AI meeting notes",
  "meeting transcription",
  "real-time transcription",
  "Hindi transcription",
  "Marathi transcription",
  "AI meeting summaries",
  "minutes of meeting generator",
  "action item tracker",
  "online meeting tool",
  "video meeting workspace",
];

/** Brand colours as hex, for places CSS variables can't reach (manifest, OG image, Razorpay checkout). */
export const BRAND_COLORS = {
  ink: "#0B0A12",
  primary: "#7C5CFF",
  warm: "#FF7552",
} as const;
