import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { assertMeetingAccess, assertOrgAccess, requireIdentity } from "../lib/auth";
import { normalizeInviteEmail, resolveInviteStatus } from "../lib/invitations";
import {
  formatCalendarDateTimeInTimeZone,
  resolveScheduledEndsAt,
} from "../../lib/meeting-schedule";
import {
  buildPublicAppUrl,
  getPublicAppUrl,
} from "../../lib/public-app-url";

const GOOGLE_PROVIDER = "google_calendar" as const;
const NOTION_PROVIDER = "notion" as const;
const GOOGLE_SYNC_STATUS_VALIDATOR = v.union(
  v.literal("pending"),
  v.literal("synced"),
  v.literal("failed"),
);
const GOOGLE_CONNECTION_STATUS_VALIDATOR = v.union(
  v.literal("connected"),
  v.literal("error"),
  v.literal("revoked"),
);
const NOTION_CONNECTION_STATUS_VALIDATOR = v.union(
  v.literal("connected"),
  v.literal("error"),
  v.literal("revoked"),
);
const MEETING_EXPORT_STATUS_VALIDATOR = v.union(
  v.literal("pending"),
  v.literal("exported"),
  v.literal("failed"),
);
const NOTION_VERSION = "2026-03-11";
const NOTION_API_BASE_URL = "https://api.notion.com/v1";
const NOTION_PAGE_TEXT_LIMIT = 1800;
const NOTION_BLOCK_BATCH_SIZE = 100;

type GoogleConnection = Doc<"user_integrations">;
type NotionConnection = Doc<"notion_integrations">;
type NotionExportConnection = NotionConnection & { targetPageId: string };
type GoogleCalendarSyncContext = {
  meeting: Doc<"meetings">;
  connection: GoogleConnection | null;
  attendeeEmails: string[];
};
type NotionRichText = {
  type: "text";
  text: {
    content: string;
    link?: {
      url: string;
    };
  };
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    color?:
      | "default"
      | "gray"
      | "brown"
      | "orange"
      | "yellow"
      | "green"
      | "blue"
      | "purple"
      | "pink"
      | "red";
  };
};
type NotionBlock = {
  object: "block";
  type:
    | "heading_2"
    | "heading_3"
    | "paragraph"
    | "bulleted_list_item"
    | "numbered_list_item"
    | "to_do"
    | "divider";
  heading_2?: { rich_text: NotionRichText[] };
  heading_3?: { rich_text: NotionRichText[] };
  paragraph?: { rich_text: NotionRichText[] };
  bulleted_list_item?: { rich_text: NotionRichText[] };
  numbered_list_item?: { rich_text: NotionRichText[] };
  to_do?: { rich_text: NotionRichText[]; checked: boolean };
  divider?: Record<string, never>;
};
type NotionPageCreateResponse = {
  id: string;
  url?: string;
};

function formatLogTimestamp(timestamp?: number | null) {
  if (typeof timestamp !== "number" || Number.isNaN(timestamp)) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

function isGoogleCalendarAuthError(message?: string) {
  if (!message) {
    return false;
  }

  const normalized = message.toLowerCase();
  return (
    normalized.includes("invalid_grant") ||
    normalized.includes("invalid credentials") ||
    normalized.includes("login required") ||
    normalized.includes("refresh token") ||
    normalized.includes("unauthorized") ||
    normalized.includes("access token")
  );
}

function isUsableGoogleCalendarConnection(connection: GoogleConnection | null) {
  if (!connection || connection.status === "revoked") {
    return false;
  }

  if (connection.status === "connected") {
    return true;
  }

  return !isGoogleCalendarAuthError(connection.lastError);
}

function getMeetingJoinUrl(meetingId: Id<"meetings">) {
  return buildPublicAppUrl(`/meeting/${meetingId}`);
}

function buildGoogleEventDescription(
  meeting: Pick<
    Doc<"meetings">,
    "title" | "purpose" | "description"
  > & { _id: Id<"meetings"> },
) {
  const joinUrl = getMeetingJoinUrl(meeting._id);
  const sections = [
    joinUrl ? `Join meeting: ${joinUrl}` : null,
    `Meeting: ${meeting.title}`,
    meeting.purpose ? `Purpose: ${meeting.purpose}` : null,
    meeting.description ? `Notes: ${meeting.description}` : null,
  ].filter((value): value is string => Boolean(value));

  return sections.join("\n\n");
}

function isNotionAuthError(message?: string, status?: number) {
  if (status === 401) {
    return true;
  }

  if (!message) {
    return false;
  }

  const normalized = message.toLowerCase();
  return (
    normalized.includes("unauthorized") ||
    normalized.includes("access token") ||
    normalized.includes("refresh token") ||
    normalized.includes("invalid_grant")
  );
}

function normalizeNotionPageId(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const decoded = decodeURIComponent(trimmed);
  const match = decoded.match(
    /([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/,
  );

  if (!match) {
    throw new Error("Enter a valid Notion page URL or page ID");
  }

  const compact = match[1].replace(/-/g, "").toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function chunkText(value: string, maxLength = NOTION_PAGE_TEXT_LIMIT) {
  const text = value.trim();
  if (!text) {
    return [];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength);
    const splitIndex = Math.max(
      candidate.lastIndexOf("\n"),
      candidate.lastIndexOf(" "),
    );
    const boundary = splitIndex > maxLength * 0.5 ? splitIndex : maxLength;
    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function createRichTextFragment(
  content: string,
  options?: {
    link?: string;
    annotations?: NotionRichText["annotations"];
  },
): NotionRichText | null {
  if (!content.trim()) {
    return null;
  }

  return {
    type: "text",
    text: {
      content,
      ...(options?.link ? { link: { url: options.link } } : {}),
    },
    ...(options?.annotations ? { annotations: options.annotations } : {}),
  };
}

function createRichText(
  content: string,
  link?: string,
  annotations?: NotionRichText["annotations"],
): NotionRichText[] {
  const fragment = createRichTextFragment(content, { link, annotations });
  return fragment ? [fragment] : [];
}

function createMarkdownRichText(content: string): NotionRichText[] {
  const text = content.trim();
  if (!text) {
    return [];
  }

  const tokenRegex =
    /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*)/g;
  const richText: NotionRichText[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(tokenRegex)) {
    const [token, , linkLabel, linkUrl, boldText, codeText, italicText] = match;
    const tokenIndex = match.index ?? 0;

    if (tokenIndex > lastIndex) {
      richText.push(...createRichText(text.slice(lastIndex, tokenIndex)));
    }

    if (linkLabel && linkUrl) {
      richText.push(...createRichText(linkLabel, linkUrl));
    } else if (boldText) {
      richText.push(...createRichText(boldText, undefined, { bold: true }));
    } else if (codeText) {
      richText.push(...createRichText(codeText, undefined, { code: true }));
    } else if (italicText) {
      richText.push(...createRichText(italicText, undefined, { italic: true }));
    } else {
      richText.push(...createRichText(token));
    }

    lastIndex = tokenIndex + token.length;
  }

  if (lastIndex < text.length) {
    richText.push(...createRichText(text.slice(lastIndex)));
  }

  return richText.length > 0 ? richText : createRichText(text);
}

function createBlockFromRichText(
  type:
    | "paragraph"
    | "bulleted_list_item"
    | "numbered_list_item"
    | "to_do",
  richText: NotionRichText[],
  options?: {
    checked?: boolean;
  },
) {
  if (richText.length === 0) {
    return null;
  }

  if (type === "paragraph") {
    return {
      object: "block" as const,
      type,
      paragraph: { rich_text: richText },
    };
  }

  if (type === "bulleted_list_item") {
    return {
      object: "block" as const,
      type,
      bulleted_list_item: { rich_text: richText },
    };
  }

  if (type === "numbered_list_item") {
    return {
      object: "block" as const,
      type,
      numbered_list_item: { rich_text: richText },
    };
  }

  return {
    object: "block" as const,
    type,
    to_do: {
      rich_text: richText,
      checked: options?.checked ?? false,
    },
  };
}

function createTextBlocks(
  type: "paragraph" | "bulleted_list_item" | "numbered_list_item" | "to_do",
  value: string,
  options?: {
    link?: string;
    checked?: boolean;
    markdown?: boolean;
  },
) {
  return chunkText(value).map<NotionBlock>((chunk) => {
    const richText = options?.markdown
      ? createMarkdownRichText(chunk)
      : createRichText(chunk, options?.link);
    return createBlockFromRichText(type, richText, {
      checked: options?.checked,
    })!;
  });
}

function createHeadingBlock(
  level: "heading_2" | "heading_3",
  value: string,
): NotionBlock {
  const richText = createRichText(value.slice(0, NOTION_PAGE_TEXT_LIMIT));
  if (level === "heading_2") {
    return {
      object: "block",
      type: level,
      heading_2: { rich_text: richText },
    };
  }

  return {
    object: "block",
    type: level,
    heading_3: { rich_text: richText },
  };
}

function createLabeledListItem(
  label: string,
  value: string,
  options?: {
    link?: string;
  },
) {
  const richText = [
    ...createRichText(`${label}: `, undefined, { bold: true }),
    ...(options?.link ? createRichText(value, options.link) : createMarkdownRichText(value)),
  ];
  const block = createBlockFromRichText("bulleted_list_item", richText);
  return block ? [block] : [];
}

function createSectionBlocks(
  title: string,
  body: NotionBlock[],
) {
  if (body.length === 0) {
    return [];
  }

  return [createHeadingBlock("heading_2", title), ...body];
}

function formatMeetingTimestamp(
  timestamp?: number,
  timeZone?: string,
) {
  if (typeof timestamp !== "number") {
    return null;
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(timestamp);
}

type NotionMeetingExportMeeting = {
  _id: Id<"meetings">;
  title: string;
  purpose: string;
  description?: string;
  status: "scheduled" | "active" | "ended";
  orgId: string;
  scheduledFor?: number;
  scheduledEndsAt?: number;
  scheduledTimeZone?: string;
  summary: string | null;
  key_points: string[];
  decisions: string[];
  action_items: Array<{ task: string; assignee?: string | null; due?: string | null }>;
};

type NotionMeetingTranscript = {
  speakerName: string;
  text: string;
  timestamp: number;
};

type NotionMeetingRecording = {
  playbackUrl?: string | null;
  startedAt: number;
  status: string;
};

type CleanTranscriptEntry = {
  speakerName: string;
  text: string;
  timestamp: number;
};

const GENERIC_MEETING_LABELS = new Set([
  "call",
  "check",
  "discussion",
  "meeting",
  "quick call",
  "sync",
  "test",
]);

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function stripMarkdown(value: string) {
  return normalizeWhitespace(
    value
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_~`>#]/g, " ")
      .replace(/\s+/g, " "),
  );
}

function sentenceCase(value: string) {
  const trimmed = normalizeWhitespace(value);
  if (!trimmed) {
    return "";
  }

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function dedupeStrings(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalizeWhitespace(value).toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(sentenceCase(value));
  }

  return result;
}

function normalizeHeadingToken(value: string) {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

function extractMarkdownSection(markdown: string | null, headings: string[]) {
  if (!markdown) {
    return "";
  }

  const targetHeadings = new Set(headings.map(normalizeHeadingToken));
  const lines = markdown.split(/\r?\n/);
  const captured: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const headingMatch = line.trim().match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      const normalizedHeading = normalizeHeadingToken(headingMatch[1]);
      if (targetHeadings.has(normalizedHeading)) {
        inSection = true;
        continue;
      }

      if (inSection) {
        break;
      }
    }

    if (inSection) {
      captured.push(line);
    }
  }

  return stripMarkdown(captured.join(" "));
}

function splitIntoSentences(value: string) {
  return stripMarkdown(value)
    .split(/(?<=[.!?])\s+/)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);
}

function isGenericMeetingLabel(value?: string | null) {
  const normalized = normalizeWhitespace(value ?? "").toLowerCase();
  return !normalized || GENERIC_MEETING_LABELS.has(normalized);
}

function detectPrimaryIssue(text: string) {
  const lower = text.toLowerCase();

  if (
    /(audio|sound|voice|hear|hearing|mic|microphone)/.test(lower)
    && /(issue|problem|not|get|hear|missing|fail|can'?t|cannot)/.test(lower)
  ) {
    return "a likely audio delivery issue during the call";
  }

  if (
    /(camera|video|screen|presentation)/.test(lower)
    && /(issue|problem|not|missing|fail|can'?t|cannot)/.test(lower)
  ) {
    return "a likely camera or video delivery issue during the call";
  }

  if (/(whiteboard|diagram|canvas|draw)/.test(lower)) {
    return "collaborative whiteboard review and live editing";
  }

  return null;
}

function inferMeetingTitle(
  meeting: Pick<NotionMeetingExportMeeting, "title" | "purpose" | "summary">,
  transcripts: NotionMeetingTranscript[],
) {
  const combinedText = [
    meeting.title,
    meeting.purpose,
    meeting.summary ?? "",
    ...transcripts.map((line) => line.text),
  ].join(" ");
  const primaryIssue = detectPrimaryIssue(combinedText);

  if (!isGenericMeetingLabel(meeting.title)) {
    return sentenceCase(meeting.title);
  }

  if (primaryIssue?.includes("audio")) {
    return "Audio and Connectivity Check";
  }

  if (primaryIssue?.includes("camera") || primaryIssue?.includes("video")) {
    return "Video and Connectivity Check";
  }

  if (primaryIssue?.includes("whiteboard")) {
    return "Whiteboard Working Session";
  }

  if (!isGenericMeetingLabel(meeting.purpose)) {
    return sentenceCase(meeting.purpose);
  }

  return "Meeting Notes";
}

function inferMeetingPurpose(
  meeting: Pick<NotionMeetingExportMeeting, "purpose" | "summary">,
  transcripts: NotionMeetingTranscript[],
) {
  if (!isGenericMeetingLabel(meeting.purpose)) {
    return sentenceCase(meeting.purpose);
  }

  const combinedText = [meeting.summary ?? "", ...transcripts.map((line) => line.text)].join(" ");
  const primaryIssue = detectPrimaryIssue(combinedText);

  if (primaryIssue?.includes("audio")) {
    return "Quick call to validate meeting connectivity and troubleshoot audio delivery.";
  }

  if (primaryIssue?.includes("camera") || primaryIssue?.includes("video")) {
    return "Quick call to validate meeting connectivity and troubleshoot camera or video delivery.";
  }

  if (primaryIssue?.includes("whiteboard")) {
    return "Review and validate the shared whiteboard experience.";
  }

  return "Exploratory check-in with no clearly defined agenda.";
}

function formatDuration(durationMs?: number | null) {
  if (!durationMs || durationMs < 60_000) {
    return null;
  }

  const totalMinutes = Math.round(durationMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) {
    return `${hours} hr ${minutes} min`;
  }
  if (hours > 0) {
    return `${hours} hr`;
  }
  return `${minutes} min`;
}

function deriveDurationLabel(
  meeting: Pick<NotionMeetingExportMeeting, "scheduledFor" | "scheduledEndsAt">,
  transcripts: NotionMeetingTranscript[],
) {
  if (
    typeof meeting.scheduledFor === "number"
    && typeof meeting.scheduledEndsAt === "number"
    && meeting.scheduledEndsAt > meeting.scheduledFor
  ) {
    return formatDuration(meeting.scheduledEndsAt - meeting.scheduledFor);
  }

  if (transcripts.length >= 2) {
    const timestamps = transcripts
      .map((line) => line.timestamp)
      .filter((timestamp) => typeof timestamp === "number" && !Number.isNaN(timestamp))
      .sort((a, b) => a - b);

    if (timestamps.length >= 2) {
      return formatDuration(timestamps[timestamps.length - 1] - timestamps[0]);
    }
  }

  return null;
}

function deriveParticipants(transcripts: NotionMeetingTranscript[]) {
  return dedupeStrings(
    transcripts
      .map((line) => normalizeWhitespace(line.speakerName))
      .filter(Boolean),
  );
}

function seemsLikeGreetingNoise(text: string) {
  const normalized = text.toLowerCase().replace(/[^a-z\s]/g, " ");
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return true;
  }

  const greetingTokens = new Set([
    "hello",
    "halo",
    "hi",
    "hey",
    "okay",
    "ok",
    "hmm",
    "mm",
    "man",
    "ya",
  ]);

  const unique = new Set(tokens);
  if (tokens.length >= 3 && unique.size <= 2) {
    return true;
  }

  return tokens.every((token) => greetingTokens.has(token));
}

function normalizeTranscriptLine(text: string) {
  const trimmed = normalizeWhitespace(text);
  if (!trimmed) {
    return null;
  }

  if (/seeing that you are speaking.*not getting the sound/i.test(trimmed)) {
    return "Could see the other participant speaking but could not hear audio, and asked whether the issue was with the call.";
  }

  if (/नहीं.*आ\s*रहा/i.test(trimmed)) {
    return "Reported that the audio was not coming through.";
  }

  if (/आया कोई/i.test(trimmed)) {
    return "Asked whether anyone had joined the call.";
  }

  if (seemsLikeGreetingNoise(trimmed)) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (
    /(all bold|i have eyes|now they that i like or be with that|वैकवार)/i.test(trimmed)
    || (trimmed.length < 12 && !/(audio|sound|hear|mic|camera|video|issue|problem)/.test(lower))
  ) {
    return null;
  }

  return sentenceCase(trimmed);
}

function buildCleanTranscript(
  transcripts: NotionMeetingTranscript[],
): {
  entries: CleanTranscriptEntry[];
  noisy: boolean;
  summaries: Array<{ speakerName: string; text: string }>;
} {
  const cleanedEntries: CleanTranscriptEntry[] = [];
  const speakerOrder: string[] = [];
  const rawBySpeaker = new Map<string, string[]>();
  const cleanedBySpeaker = new Map<string, string[]>();

  for (const line of transcripts) {
    const speakerName = normalizeWhitespace(line.speakerName) || "Unknown speaker";
    if (!speakerOrder.includes(speakerName)) {
      speakerOrder.push(speakerName);
    }

    rawBySpeaker.set(speakerName, [...(rawBySpeaker.get(speakerName) ?? []), line.text]);

    const normalizedLine = normalizeTranscriptLine(line.text);
    if (!normalizedLine) {
      continue;
    }

    cleanedEntries.push({
      speakerName,
      text: normalizedLine,
      timestamp: line.timestamp,
    });
    cleanedBySpeaker.set(speakerName, [
      ...(cleanedBySpeaker.get(speakerName) ?? []),
      normalizedLine,
    ]);
  }

  const noisy =
    transcripts.length > 0
    && (cleanedEntries.length === 0 || cleanedEntries.length <= Math.ceil(transcripts.length * 0.35));

  const summaries = speakerOrder.flatMap((speakerName) => {
    const cleanedLines = dedupeStrings(cleanedBySpeaker.get(speakerName) ?? []);
    const rawLines = (rawBySpeaker.get(speakerName) ?? []).map((line) => line.toLowerCase());
    const combined = cleanedLines.join(" ").toLowerCase();

    if (
      /(audio|sound|hear|speaking)/.test(combined)
      && /(not|issue|problem|could not|couldn'?t)/.test(combined)
    ) {
      return [{
        speakerName,
        text: "Observed that the other participant appeared to be speaking, but audio was not coming through and raised it as the main issue.",
      }];
    }

    if (
      cleanedLines.some((line) => /joined the call/i.test(line))
      || rawLines.some((line) => /hello|halo|camera|आया कोई/i.test(line))
    ) {
      return [{
        speakerName,
        text: "Appeared to be testing whether participants, audio, and camera were working correctly.",
      }];
    }

    if (cleanedLines.length > 0) {
      return [{
        speakerName,
        text: cleanedLines.slice(0, 2).join(" "),
      }];
    }

    return [];
  });

  return {
    entries: cleanedEntries,
    noisy,
    summaries,
  };
}

function detectDominantSpeaker(entries: CleanTranscriptEntry[]) {
  if (entries.length === 0) {
    return null;
  }

  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.speakerName, (counts.get(entry.speakerName) ?? 0) + 1);
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (!top) {
    return null;
  }

  if (!second || top[1] >= second[1] * 1.5) {
    return top[0];
  }

  return null;
}

function sanitizeInsight(value: string) {
  return sentenceCase(
    stripMarkdown(value)
      .replace(/^[-*•]\s*/, "")
      .replace(/\bappears to be\b/gi, "is")
      .replace(/\bseems to be\b/gi, "is")
      .replace(/\bpotentially\b/gi, "")
      .replace(/\s{2,}/g, " "),
  );
}

function buildFallbackActionItems(args: {
  primaryIssue: string | null;
  participants: string[];
  dominantSpeaker: string | null;
  meetingQuality: "structured" | "exploratory" | "unstructured";
}) {
  const defaultOwner = args.dominantSpeaker ?? args.participants[0] ?? "Unassigned";

  if (args.primaryIssue?.includes("audio")) {
    return [
      {
        task: "Reproduce and investigate the reported audio issue in a controlled test call",
        owner: defaultOwner,
        deadline: null,
      },
    ];
  }

  if (args.meetingQuality !== "structured") {
    return [
      {
        task: "Schedule a follow-up meeting with a clear agenda and test checklist",
        owner: defaultOwner,
        deadline: null,
      },
    ];
  }

  return [];
}

function buildNotionMeetingBlocks(args: {
  meeting: NotionMeetingExportMeeting;
  transcripts: NotionMeetingTranscript[];
  recordings: NotionMeetingRecording[];
}) {
  const joinUrl = getMeetingJoinUrl(args.meeting._id);
  const detailUrl = buildPublicAppUrl(`/meeting/${args.meeting._id}/details`);
  const statusLabel =
    args.meeting.status.charAt(0).toUpperCase() + args.meeting.status.slice(1);
  const participants = deriveParticipants(args.transcripts);
  const cleanTranscript = buildCleanTranscript(args.transcripts);
  const dominantSpeaker = detectDominantSpeaker(cleanTranscript.entries);
  const combinedSignalText = [
    args.meeting.title,
    args.meeting.purpose,
    args.meeting.summary ?? "",
    ...args.meeting.key_points,
    ...args.meeting.decisions,
    ...cleanTranscript.entries.map((entry) => entry.text),
  ].join(" ");
  const primaryIssue = detectPrimaryIssue(combinedSignalText);
  const meetingQuality: "structured" | "exploratory" | "unstructured" =
    cleanTranscript.entries.length <= 2 && args.meeting.decisions.length === 0
      ? "unstructured"
      : args.meeting.decisions.length === 0 && args.meeting.action_items.length <= 1
        ? "exploratory"
        : "structured";

  const summaryOverview = extractMarkdownSection(args.meeting.summary, ["Overview"]);
  const summaryRisks = extractMarkdownSection(args.meeting.summary, [
    "Risks",
    "Risks/Blockers",
    "Blockers",
  ]);

  const dateLabel =
    formatMeetingTimestamp(
      args.meeting.scheduledFor ?? args.transcripts[0]?.timestamp ?? args.recordings[0]?.startedAt,
      args.meeting.scheduledTimeZone,
    ) ?? "Not available";
  const durationLabel =
    deriveDurationLabel(args.meeting, args.transcripts) ?? "Not available";
  const participantLabel = participants.length > 0 ? participants.join(", ") : "Not captured";
  const purposeLabel = inferMeetingPurpose(args.meeting, args.transcripts);
  const recordingLink = args.recordings.find((recording) => recording.playbackUrl)?.playbackUrl;

  const executiveSummary = dedupeStrings([
    primaryIssue
      ? `The meeting focused on ${primaryIssue}.`
      : "The meeting was primarily a short check-in rather than a deep working session.",
    meetingQuality === "unstructured"
      ? "The call was unstructured and low-signal, with limited discussion beyond basic troubleshooting."
      : meetingQuality === "exploratory"
        ? "The conversation was exploratory and did not reach a clearly structured conclusion."
        : "The conversation stayed focused enough to surface concrete follow-ups.",
    dominantSpeaker
      ? `${dominantSpeaker} drove most of the discussion, while the rest of the participation was comparatively light.`
      : "Participation was limited and relatively evenly distributed.",
    summaryOverview
      ? splitIntoSentences(summaryOverview)[0] ?? ""
      : "",
    args.meeting.decisions.length === 0
      ? "No firm decisions were made during the call."
      : `The clearest decision was: ${sanitizeInsight(args.meeting.decisions[0])}`,
  ]).slice(0, 5);

  const keyInsights = dedupeStrings([
    ...args.meeting.key_points.map(sanitizeInsight),
    primaryIssue
      ? `The strongest signal in the meeting was ${primaryIssue}.`
      : "",
    cleanTranscript.noisy
      ? "Transcript quality was noisy, so only high-signal content was retained in the final notes."
      : "",
    meetingQuality === "unstructured"
      ? "The call felt more like a live troubleshooting check than a planned project discussion."
      : "",
  ]).filter(Boolean);

  const risks = dedupeStrings([
    summaryRisks,
    primaryIssue
      ? `There may still be unresolved follow-up needed around ${primaryIssue.replace(/^a likely /, "")}.`
      : "",
    cleanTranscript.noisy
      ? "The transcript included heavy filler and fragmented multilingual lines, which reduced note quality and clarity."
      : "",
    meetingQuality !== "structured"
      ? "The lack of a clear agenda made it harder to isolate next steps during the call."
      : "",
  ]).filter(Boolean);

  const decisions = dedupeStrings(args.meeting.decisions.map(sanitizeInsight));
  const actionItems = (
    args.meeting.action_items.length > 0
      ? args.meeting.action_items.map((item) => ({
          task: sentenceCase(stripMarkdown(item.task)),
          owner: normalizeWhitespace(item.assignee ?? "") || "Unassigned",
          deadline: normalizeWhitespace(item.due ?? "") || null,
        }))
      : buildFallbackActionItems({
          primaryIssue,
          participants,
          dominantSpeaker,
          meetingQuality,
        })
  ).filter((item) => item.task);

  const metadataBlocks: NotionBlock[] = [
    ...createLabeledListItem("Status", statusLabel),
    ...createLabeledListItem("Date", dateLabel),
    ...createLabeledListItem("Participants", participantLabel),
    ...createLabeledListItem("Duration (if available)", durationLabel),
    ...createLabeledListItem("Purpose", purposeLabel),
  ];

  const linkBlocks: NotionBlock[] = [
    ...(joinUrl
      ? createLabeledListItem("Join Meeting", "Open live room", { link: joinUrl })
      : createLabeledListItem("Join Meeting", "Not available")),
    ...(recordingLink
      ? createLabeledListItem("Recording", "Open recording", { link: recordingLink })
      : createLabeledListItem("Recording", "Not available")),
    ...(detailUrl
      ? createLabeledListItem("Related Docs", "Open meeting details", { link: detailUrl })
      : createLabeledListItem("Related Docs", "Not available")),
  ];

  const executiveSummaryBlocks = executiveSummary.flatMap((item) =>
    createTextBlocks("bulleted_list_item", item),
  );
  const keyInsightBlocks = (keyInsights.length > 0 ? keyInsights : ["No high-signal insights captured."])
    .flatMap((item) => createTextBlocks("bulleted_list_item", item));
  const riskBlocks = (risks.length > 0 ? risks : ["No significant blockers were captured."])
    .flatMap((item) => createTextBlocks("bulleted_list_item", item));
  const decisionBlocks =
    decisions.length > 0
      ? decisions.flatMap((item) => createTextBlocks("bulleted_list_item", item))
      : createTextBlocks("paragraph", "No clear decisions made");
  const actionItemBlocks =
    actionItems.length > 0
      ? actionItems.flatMap((item) => {
          const formatted = [
            item.task,
            item.owner,
            item.deadline || null,
          ].filter(Boolean).join(" — ");
          return createTextBlocks("to_do", formatted, { checked: false });
        })
      : createTextBlocks("to_do", "No action items captured — Unassigned", {
          checked: false,
        });

  const cleanTranscriptBlocks = (
    cleanTranscript.noisy ? cleanTranscript.summaries : cleanTranscript.entries
  ).flatMap((line) => {
    const richText = [
      ...createRichText(line.speakerName, undefined, { bold: true }),
      ...createRichText(": "),
      ...createMarkdownRichText(line.text),
    ];
    const block = createBlockFromRichText("paragraph", richText);
    return block ? [block] : [];
  });

  return [
    ...createSectionBlocks("📌 Metadata", metadataBlocks),
    ...createSectionBlocks("🔗 Links", linkBlocks),
    ...createSectionBlocks("🧾 Executive Summary", executiveSummaryBlocks),
    ...createSectionBlocks("🧠 Key Insights", keyInsightBlocks),
    ...createSectionBlocks("⚠️ Risks / Blockers", riskBlocks),
    ...createSectionBlocks("✅ Decisions Made", decisionBlocks),
    ...createSectionBlocks("🎯 Action Items", actionItemBlocks),
    ...createSectionBlocks("🗣 Clean Transcript", cleanTranscriptBlocks),
  ];
}

function buildNotionMeetingPageTitle(
  meeting: Pick<NotionMeetingExportMeeting, "title" | "purpose" | "summary" | "scheduledFor" | "scheduledTimeZone">,
  transcripts: NotionMeetingTranscript[],
) {
  const scheduledLabel = formatMeetingTimestamp(
    meeting.scheduledFor,
    meeting.scheduledTimeZone,
  );
  const parts = [inferMeetingTitle(meeting, transcripts)];
  if (scheduledLabel) {
    parts.push(scheduledLabel);
  }
  return parts.join(" | ").slice(0, NOTION_PAGE_TEXT_LIMIT);
}

type NotionApiRequestOptions = {
  method: "GET" | "POST" | "PATCH";
  path: string;
  accessToken: string;
  body?: Record<string, unknown>;
};

async function notionApiRequest<T>({
  method,
  path,
  accessToken,
  body,
}: NotionApiRequestOptions): Promise<T> {
  const response = await fetch(`${NOTION_API_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const payload = (await response.json().catch(() => null)) as
    | (T & { message?: string; code?: string })
    | { message?: string; code?: string }
    | null;

  if (!response.ok) {
    const error = new Error(
      payload && "message" in payload && payload.message
        ? payload.message
        : "Notion request failed",
    ) as Error & {
      status?: number;
      code?: string;
    };
    error.status = response.status;
    error.code = payload && "code" in payload ? payload.code : undefined;
    throw error;
  }

  return payload as T;
}

async function exchangeNotionRefreshToken(connection: NotionConnection) {
  const clientId = process.env.NOTION_CLIENT_ID;
  const clientSecret = process.env.NOTION_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Notion environment variables are not configured");
  }

  if (!connection.refreshToken) {
    throw new Error("Notion refresh token is missing");
  }

  const response = await fetch(`${NOTION_API_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: connection.refreshToken,
    }),
  });

  const payload = (await response.json()) as
    | {
        access_token?: string;
        refresh_token?: string;
        bot_id?: string;
        workspace_name?: string | null;
        workspace_icon?: string | null;
        workspace_id?: string | null;
        duplicated_template_id?: string | null;
        token_type?: string;
      }
    | {
        error?: string;
        error_description?: string;
      };

  if (!response.ok || !("access_token" in payload) || !payload.access_token) {
    throw new Error(
      "error_description" in payload && payload.error_description
        ? payload.error_description
        : "Unable to refresh Notion access token",
    );
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? connection.refreshToken,
    botId: payload.bot_id ?? connection.botId,
    workspaceName: payload.workspace_name ?? connection.workspaceName,
    workspaceIcon: payload.workspace_icon ?? connection.workspaceIcon,
    workspaceId: payload.workspace_id ?? connection.workspaceId,
    duplicatedTemplateId:
      payload.duplicated_template_id ?? connection.duplicatedTemplateId,
    tokenType: payload.token_type ?? connection.tokenType,
  };
}

async function exchangeGoogleRefreshToken(connection: GoogleConnection) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Google Calendar environment variables are not configured");
  }

  if (!connection.refreshToken) {
    throw new Error("Google Calendar refresh token is missing");
  }

  console.info("[google-calendar] Refreshing access token", {
    connectionId: connection._id,
    accountEmail: connection.accountEmail,
    tokenExpiresAt: formatLogTimestamp(connection.tokenExpiresAt),
    hasGoogleClientId: Boolean(clientId),
    hasGoogleClientSecret: Boolean(clientSecret),
    hasRefreshToken: Boolean(connection.refreshToken),
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: connection.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const payload = (await response.json()) as
    | {
        access_token?: string;
        expires_in?: number;
        refresh_token?: string;
      }
    | {
        error?: string;
        error_description?: string;
      };

  if (!response.ok || !("access_token" in payload) || !payload.access_token) {
    console.error("[google-calendar] Access token refresh failed", {
      connectionId: connection._id,
      accountEmail: connection.accountEmail,
      status: response.status,
      error:
        "error_description" in payload && payload.error_description
          ? payload.error_description
          : "Unable to refresh Google Calendar token",
    });
    throw new Error(
      "error_description" in payload && payload.error_description
        ? payload.error_description
        : "Unable to refresh Google Calendar token",
    );
  }

  console.info("[google-calendar] Access token refresh succeeded", {
    connectionId: connection._id,
    accountEmail: connection.accountEmail,
    tokenExpiresAt: formatLogTimestamp(
      Date.now() + Math.max(payload.expires_in ?? 3600, 60) * 1000,
    ),
    receivedRefreshToken: Boolean(payload.refresh_token),
  });

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? connection.refreshToken,
    tokenExpiresAt: Date.now() + Math.max(payload.expires_in ?? 3600, 60) * 1000,
  };
}

export const getGoogleCalendarConnection = query({
  args: {
    orgId: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    await assertOrgAccess(ctx, identity.tokenIdentifier, args.orgId);

    const connection = await ctx.db
      .query("user_integrations")
      .withIndex("by_userTokenIdentifier_and_provider", (q) =>
        q
          .eq("userTokenIdentifier", identity.tokenIdentifier)
          .eq("provider", GOOGLE_PROVIDER),
      )
      .unique();

    if (!connection || connection.status === "revoked") {
      return {
        connected: false,
        provider: GOOGLE_PROVIDER,
        hasRefreshToken: false,
        hasGoogleClientId: Boolean(process.env.GOOGLE_CLIENT_ID),
        hasGoogleClientSecret: Boolean(process.env.GOOGLE_CLIENT_SECRET),
        hasConfiguredCalendarId: Boolean(process.env.GOOGLE_CALENDAR_ID),
        publicAppUrlConfigured: Boolean(getPublicAppUrl()),
        publicAppUrl: getPublicAppUrl() ?? undefined,
      } as const;
    }

    const hasAuthError = !isUsableGoogleCalendarConnection(connection);
    const warning =
      connection.lastError && !hasAuthError ? connection.lastError : undefined;
    const publicAppUrl = getPublicAppUrl();

    return {
      connected: !hasAuthError,
      provider: GOOGLE_PROVIDER,
      accountEmail: connection.accountEmail,
      status: hasAuthError ? "error" : "connected",
      scope: connection.scope,
      tokenExpiresAt: connection.tokenExpiresAt,
      connectedAt: connection.connectedAt,
      updatedAt: connection.updatedAt,
      lastError: hasAuthError ? connection.lastError : undefined,
      warning,
      hasRefreshToken: Boolean(connection.refreshToken),
      hasGoogleClientId: Boolean(process.env.GOOGLE_CLIENT_ID),
      hasGoogleClientSecret: Boolean(process.env.GOOGLE_CLIENT_SECRET),
      hasConfiguredCalendarId: Boolean(process.env.GOOGLE_CALENDAR_ID),
      publicAppUrlConfigured: Boolean(publicAppUrl),
      publicAppUrl: publicAppUrl ?? undefined,
    } as const;
  },
});

export const connectGoogleCalendar = mutation({
  args: {
    orgId: v.string(),
    accountEmail: v.string(),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    scope: v.array(v.string()),
    tokenExpiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    await assertOrgAccess(ctx, identity.tokenIdentifier, args.orgId);

    const existing = await ctx.db
      .query("user_integrations")
      .withIndex("by_userTokenIdentifier_and_provider", (q) =>
        q
          .eq("userTokenIdentifier", identity.tokenIdentifier)
          .eq("provider", GOOGLE_PROVIDER),
      )
      .unique();

    const now = Date.now();
    const payload = {
      userTokenIdentifier: identity.tokenIdentifier,
      provider: GOOGLE_PROVIDER,
      accountEmail: normalizeInviteEmail(args.accountEmail),
      accessToken: args.accessToken,
      refreshToken: args.refreshToken ?? existing?.refreshToken,
      scope: args.scope,
      tokenExpiresAt: args.tokenExpiresAt,
      status: "connected" as const,
      lastError: undefined,
      connectedAt: existing?.connectedAt ?? now,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return existing._id;
    }

    return await ctx.db.insert("user_integrations", payload);
  },
});

export const disconnectGoogleCalendar = mutation({
  args: {
    orgId: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    await assertOrgAccess(ctx, identity.tokenIdentifier, args.orgId);

    const existing = await ctx.db
      .query("user_integrations")
      .withIndex("by_userTokenIdentifier_and_provider", (q) =>
        q
          .eq("userTokenIdentifier", identity.tokenIdentifier)
          .eq("provider", GOOGLE_PROVIDER),
      )
      .unique();

    if (!existing) {
      return { disconnected: false } as const;
    }

    await ctx.db.delete(existing._id);
    return { disconnected: true } as const;
  },
});

export const getNotionConnection = query({
  args: {
    orgId: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    await assertOrgAccess(ctx, identity.tokenIdentifier, args.orgId);

    const connection = await ctx.db
      .query("notion_integrations")
      .withIndex("by_userTokenIdentifier_and_orgId", (q) =>
        q
          .eq("userTokenIdentifier", identity.tokenIdentifier)
          .eq("orgId", args.orgId),
      )
      .unique();

    if (!connection || connection.status === "revoked") {
      return {
        connected: false,
        provider: NOTION_PROVIDER,
        hasNotionClientId: Boolean(process.env.NOTION_CLIENT_ID),
        hasNotionClientSecret: Boolean(process.env.NOTION_CLIENT_SECRET),
        publicAppUrlConfigured: Boolean(getPublicAppUrl()),
        publicAppUrl: getPublicAppUrl() ?? undefined,
      } as const;
    }

    const hasAuthError = connection.status === "error" && isNotionAuthError(connection.lastError);
    const warning =
      connection.lastError && !hasAuthError ? connection.lastError : undefined;

    return {
      connected: connection.status === "connected" && !hasAuthError,
      provider: NOTION_PROVIDER,
      workspaceId: connection.workspaceId,
      workspaceName: connection.workspaceName,
      workspaceIcon: connection.workspaceIcon,
      botId: connection.botId,
      targetPageId: connection.targetPageId,
      status: connection.status,
      connectedAt: connection.connectedAt,
      updatedAt: connection.updatedAt,
      lastError: hasAuthError ? connection.lastError : undefined,
      warning,
      hasRefreshToken: Boolean(connection.refreshToken),
      hasNotionClientId: Boolean(process.env.NOTION_CLIENT_ID),
      hasNotionClientSecret: Boolean(process.env.NOTION_CLIENT_SECRET),
      publicAppUrlConfigured: Boolean(getPublicAppUrl()),
      publicAppUrl: getPublicAppUrl() ?? undefined,
    } as const;
  },
});

export const connectNotion = mutation({
  args: {
    orgId: v.string(),
    workspaceId: v.optional(v.string()),
    workspaceName: v.optional(v.string()),
    workspaceIcon: v.optional(v.string()),
    botId: v.string(),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    tokenType: v.optional(v.string()),
    duplicatedTemplateId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    await assertOrgAccess(ctx, identity.tokenIdentifier, args.orgId);

    const existing = await ctx.db
      .query("notion_integrations")
      .withIndex("by_userTokenIdentifier_and_orgId", (q) =>
        q
          .eq("userTokenIdentifier", identity.tokenIdentifier)
          .eq("orgId", args.orgId),
      )
      .unique();

    const now = Date.now();
    const payload = {
      userTokenIdentifier: identity.tokenIdentifier,
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      workspaceName: args.workspaceName,
      workspaceIcon: args.workspaceIcon,
      botId: args.botId,
      accessToken: args.accessToken,
      refreshToken: args.refreshToken ?? existing?.refreshToken,
      tokenType: args.tokenType,
      duplicatedTemplateId: args.duplicatedTemplateId,
      targetPageId: existing?.targetPageId,
      status: "connected" as const,
      lastError: undefined,
      connectedAt: existing?.connectedAt ?? now,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return existing._id;
    }

    return await ctx.db.insert("notion_integrations", payload);
  },
});

export const disconnectNotion = mutation({
  args: {
    orgId: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    await assertOrgAccess(ctx, identity.tokenIdentifier, args.orgId);

    const existing = await ctx.db
      .query("notion_integrations")
      .withIndex("by_userTokenIdentifier_and_orgId", (q) =>
        q
          .eq("userTokenIdentifier", identity.tokenIdentifier)
          .eq("orgId", args.orgId),
      )
      .unique();

    if (!existing) {
      return { disconnected: false } as const;
    }

    await ctx.db.delete(existing._id);
    return { disconnected: true } as const;
  },
});

export const updateNotionTargetPage = mutation({
  args: {
    orgId: v.string(),
    targetPageId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    await assertOrgAccess(ctx, identity.tokenIdentifier, args.orgId);

    const connection = await ctx.db
      .query("notion_integrations")
      .withIndex("by_userTokenIdentifier_and_orgId", (q) =>
        q
          .eq("userTokenIdentifier", identity.tokenIdentifier)
          .eq("orgId", args.orgId),
      )
      .unique();

    if (!connection) {
      throw new Error("Connect Notion before saving an export destination");
    }

    const normalizedTargetPageId = args.targetPageId
      ? normalizeNotionPageId(args.targetPageId) ?? undefined
      : undefined;

    await ctx.db.patch(connection._id, {
      targetPageId: normalizedTargetPageId,
      updatedAt: Date.now(),
      lastError: undefined,
      status: "connected",
    });

    return {
      targetPageId: normalizedTargetPageId ?? null,
    } as const;
  },
});

export const getMeetingNotionExport = query({
  args: {
    meetingId: v.id("meetings"),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    await assertMeetingAccess(ctx, identity.tokenIdentifier, args.meetingId);

    return await ctx.db
      .query("meeting_exports")
      .withIndex("by_meetingId_and_provider", (q) =>
        q.eq("meetingId", args.meetingId).eq("provider", NOTION_PROVIDER),
      )
      .unique();
  },
});

export const getNotionConnectionForExport = internalQuery({
  args: {
    orgId: v.string(),
    userTokenIdentifier: v.string(),
  },
  handler: async (ctx, args): Promise<NotionConnection | null> => {
    return await ctx.db
      .query("notion_integrations")
      .withIndex("by_userTokenIdentifier_and_orgId", (q) =>
        q
          .eq("userTokenIdentifier", args.userTokenIdentifier)
          .eq("orgId", args.orgId),
      )
      .unique();
  },
});

export const updateNotionConnectionState = internalMutation({
  args: {
    connectionId: v.id("notion_integrations"),
    accessToken: v.optional(v.string()),
    refreshToken: v.optional(v.string()),
    workspaceId: v.optional(v.string()),
    workspaceName: v.optional(v.string()),
    workspaceIcon: v.optional(v.string()),
    botId: v.optional(v.string()),
    tokenType: v.optional(v.string()),
    duplicatedTemplateId: v.optional(v.string()),
    targetPageId: v.optional(v.string()),
    status: v.optional(NOTION_CONNECTION_STATUS_VALIDATOR),
    lastError: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const patch: {
      accessToken?: string;
      refreshToken?: string;
      workspaceId?: string;
      workspaceName?: string;
      workspaceIcon?: string;
      botId?: string;
      tokenType?: string;
      duplicatedTemplateId?: string;
      targetPageId?: string;
      status?: "connected" | "error" | "revoked";
      lastError?: string;
      updatedAt: number;
    } = {
      updatedAt: Date.now(),
    };

    if (typeof args.accessToken === "string") {
      patch.accessToken = args.accessToken;
    }
    if (typeof args.refreshToken === "string") {
      patch.refreshToken = args.refreshToken;
    }
    if (typeof args.workspaceId === "string") {
      patch.workspaceId = args.workspaceId;
    }
    if (typeof args.workspaceName === "string") {
      patch.workspaceName = args.workspaceName;
    }
    if (typeof args.workspaceIcon === "string") {
      patch.workspaceIcon = args.workspaceIcon;
    }
    if (typeof args.botId === "string") {
      patch.botId = args.botId;
    }
    if (typeof args.tokenType === "string") {
      patch.tokenType = args.tokenType;
    }
    if (typeof args.duplicatedTemplateId === "string") {
      patch.duplicatedTemplateId = args.duplicatedTemplateId;
    }
    if (typeof args.targetPageId === "string") {
      patch.targetPageId = args.targetPageId;
    }
    if (args.status) {
      patch.status = args.status;
    }
    if (args.lastError !== undefined) {
      patch.lastError = args.lastError ?? undefined;
    }

    await ctx.db.patch(args.connectionId, patch);
  },
});

export const upsertMeetingExportState = internalMutation({
  args: {
    meetingId: v.id("meetings"),
    provider: v.literal("notion"),
    status: MEETING_EXPORT_STATUS_VALIDATOR,
    exportedByTokenIdentifier: v.string(),
    externalId: v.optional(v.string()),
    externalUrl: v.optional(v.string()),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("meeting_exports")
      .withIndex("by_meetingId_and_provider", (q) =>
        q.eq("meetingId", args.meetingId).eq("provider", args.provider),
      )
      .unique();

    const now = Date.now();
    const payload = {
      provider: args.provider,
      status: args.status,
      exportedByTokenIdentifier: args.exportedByTokenIdentifier,
      externalId: args.externalId,
      externalUrl: args.externalUrl,
      lastError: args.lastError,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return existing._id;
    }

    return await ctx.db.insert("meeting_exports", {
      meetingId: args.meetingId,
      ...payload,
      createdAt: now,
    });
  },
});

export const exportMeetingToNotion = action({
  args: {
    meetingId: v.id("meetings"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ pageId: string; pageUrl: string | null }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthenticated");
    }

    const meeting: {
      _id: Id<"meetings">;
      title: string;
      purpose: string;
      description?: string;
      status: "scheduled" | "active" | "ended";
      orgId: string;
      scheduledFor?: number;
      scheduledEndsAt?: number;
      scheduledTimeZone?: string;
      summary: string | null;
      key_points: string[];
      decisions: string[];
      action_items: Array<{ task: string; assignee?: string | null; due?: string | null }>;
    } = await ctx.runQuery(api.meetings.index.get, {
      meetingId: args.meetingId,
    });
    const billing: {
      features: {
        notionExport: boolean;
      };
    } = await ctx.runQuery(api.billing.index.getOrganizationPlan, {
      orgId: meeting.orgId,
    });

    if (!billing.features.notionExport) {
      throw new Error("Notion export is only available on paid workspace plans");
    }

    const connection = await ctx.runQuery(
      internal.integrations.index.getNotionConnectionForExport,
      {
        orgId: meeting.orgId,
        userTokenIdentifier: identity.tokenIdentifier,
      },
    );

    if (!connection || connection.status === "revoked") {
      throw new Error("Connect Notion before exporting this meeting");
    }

    if (!connection.targetPageId) {
      throw new Error("Choose a Notion parent page before exporting");
    }

    const transcripts: Array<{ speakerName: string; text: string; timestamp: number }> =
      await ctx.runQuery(api.transcripts.index.list, {
      meetingId: args.meetingId,
    });
    const recordings: Array<{
      playbackUrl?: string | null;
      startedAt: number;
      status: string;
    }> = await ctx.runQuery(api.recordings.index.listByMeeting, {
        meetingId: args.meetingId,
      });

    await ctx.runMutation(internal.integrations.index.upsertMeetingExportState, {
      meetingId: args.meetingId,
      provider: NOTION_PROVIDER,
      status: "pending",
      exportedByTokenIdentifier: identity.tokenIdentifier,
    });

    const blocks = buildNotionMeetingBlocks({
      meeting,
      transcripts,
      recordings,
    });

    let activeConnection: NotionExportConnection = {
      ...connection,
      targetPageId: connection.targetPageId,
    };

    const createOrAppendPage = async (
      currentConnection: NotionExportConnection,
    ): Promise<NotionPageCreateResponse> => {
      const [firstChunk, ...remainingChunks] = Array.from(
        { length: Math.ceil(blocks.length / NOTION_BLOCK_BATCH_SIZE) },
        (_, index) =>
          blocks.slice(
            index * NOTION_BLOCK_BATCH_SIZE,
            (index + 1) * NOTION_BLOCK_BATCH_SIZE,
          ),
      ).filter((chunk) => chunk.length > 0);

      const createdPage: NotionPageCreateResponse = await notionApiRequest<NotionPageCreateResponse>({
        method: "POST",
        path: "/pages",
        accessToken: currentConnection.accessToken,
        body: {
          icon: {
            type: "emoji",
            emoji: "🧠",
          },
          parent: {
            page_id: currentConnection.targetPageId,
          },
          properties: {
            title: {
              title: createRichText(buildNotionMeetingPageTitle(meeting, transcripts)),
            },
          },
          children: firstChunk,
        },
      });

      for (const chunk of remainingChunks) {
        await notionApiRequest({
          method: "PATCH",
          path: `/blocks/${createdPage.id}/children`,
          accessToken: currentConnection.accessToken,
          body: {
            children: chunk,
          },
        });
      }

      return createdPage;
    };

    try {
      const createdPage = await createOrAppendPage(activeConnection);
      await ctx.runMutation(internal.integrations.index.upsertMeetingExportState, {
        meetingId: args.meetingId,
        provider: NOTION_PROVIDER,
        status: "exported",
        exportedByTokenIdentifier: identity.tokenIdentifier,
        externalId: createdPage.id,
        externalUrl: createdPage.url,
      });
      await ctx.runMutation(internal.integrations.index.updateNotionConnectionState, {
        connectionId: activeConnection._id,
        status: "connected",
        lastError: undefined,
      });

      return {
        pageId: createdPage.id,
        pageUrl: createdPage.url ?? null,
      } as const;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to export meeting to Notion";
      const status =
        error instanceof Error && "status" in error
          ? (error as Error & { status?: number }).status
          : undefined;

      if (activeConnection.refreshToken && isNotionAuthError(message, status)) {
        try {
          const refreshed = await exchangeNotionRefreshToken(activeConnection);
          await ctx.runMutation(internal.integrations.index.updateNotionConnectionState, {
            connectionId: activeConnection._id,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            workspaceId: refreshed.workspaceId ?? undefined,
            workspaceName: refreshed.workspaceName ?? undefined,
            workspaceIcon: refreshed.workspaceIcon ?? undefined,
            botId: refreshed.botId,
            tokenType: refreshed.tokenType ?? undefined,
            duplicatedTemplateId: refreshed.duplicatedTemplateId ?? undefined,
            status: "connected",
            lastError: undefined,
          });

          activeConnection = {
            ...activeConnection,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            workspaceId: refreshed.workspaceId ?? activeConnection.workspaceId,
            workspaceName: refreshed.workspaceName ?? activeConnection.workspaceName,
            workspaceIcon: refreshed.workspaceIcon ?? activeConnection.workspaceIcon,
            botId: refreshed.botId,
            tokenType: refreshed.tokenType ?? activeConnection.tokenType,
            duplicatedTemplateId:
              refreshed.duplicatedTemplateId ?? activeConnection.duplicatedTemplateId,
            status: "connected",
            lastError: undefined,
          };

          const createdPage = await createOrAppendPage(activeConnection);
          await ctx.runMutation(internal.integrations.index.upsertMeetingExportState, {
            meetingId: args.meetingId,
            provider: NOTION_PROVIDER,
            status: "exported",
            exportedByTokenIdentifier: identity.tokenIdentifier,
            externalId: createdPage.id,
            externalUrl: createdPage.url,
          });

          return {
            pageId: createdPage.id,
            pageUrl: createdPage.url ?? null,
          } as const;
        } catch (refreshError) {
          const refreshMessage =
            refreshError instanceof Error
              ? refreshError.message
              : "Unable to refresh Notion access token";

          await ctx.runMutation(internal.integrations.index.updateNotionConnectionState, {
            connectionId: activeConnection._id,
            status: "error",
            lastError: refreshMessage,
          });
          await ctx.runMutation(internal.integrations.index.upsertMeetingExportState, {
            meetingId: args.meetingId,
            provider: NOTION_PROVIDER,
            status: "failed",
            exportedByTokenIdentifier: identity.tokenIdentifier,
            lastError: refreshMessage,
          });
          throw new Error(refreshMessage);
        }
      }

      await ctx.runMutation(internal.integrations.index.updateNotionConnectionState, {
        connectionId: activeConnection._id,
        status: isNotionAuthError(message, status) ? "error" : activeConnection.status,
        lastError: message,
      });
      await ctx.runMutation(internal.integrations.index.upsertMeetingExportState, {
        meetingId: args.meetingId,
        provider: NOTION_PROVIDER,
        status: "failed",
        exportedByTokenIdentifier: identity.tokenIdentifier,
        lastError: message,
      });
      throw new Error(message);
    }
  },
});

export const getMeetingGoogleCalendarSyncContext = internalQuery({
  args: {
    meetingId: v.id("meetings"),
  },
  handler: async (ctx, args): Promise<GoogleCalendarSyncContext | null> => {
    const meeting = await ctx.db.get(args.meetingId);
    if (!meeting) {
      return null;
    }

    const connection = await ctx.db
      .query("user_integrations")
      .withIndex("by_userTokenIdentifier_and_provider", (q) =>
        q
          .eq("userTokenIdentifier", meeting.hostUserTokenIdentifier)
          .eq("provider", GOOGLE_PROVIDER),
      )
      .unique();

    const attendeeEmails = new Set<string>();
    for await (const invite of ctx.db
      .query("meeting_invites")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", args.meetingId))) {
      const status = resolveInviteStatus(invite);
      if (status === "cancelled" || status === "declined" || status === "expired") {
        continue;
      }

      attendeeEmails.add(normalizeInviteEmail(invite.email));
    }

    return {
      meeting,
      connection,
      attendeeEmails: [...attendeeEmails],
    };
  },
});

export const updateGoogleCalendarConnectionState = internalMutation({
  args: {
    connectionId: v.id("user_integrations"),
    accessToken: v.optional(v.string()),
    refreshToken: v.optional(v.string()),
    tokenExpiresAt: v.optional(v.number()),
    status: v.optional(GOOGLE_CONNECTION_STATUS_VALIDATOR),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: {
      accessToken?: string;
      refreshToken?: string;
      tokenExpiresAt?: number;
      status?: "connected" | "error" | "revoked";
      lastError?: string;
      updatedAt: number;
    } = {
      updatedAt: Date.now(),
    };

    if (typeof args.accessToken === "string") {
      patch.accessToken = args.accessToken;
    }
    if (typeof args.refreshToken === "string") {
      patch.refreshToken = args.refreshToken;
    }
    if (typeof args.tokenExpiresAt === "number") {
      patch.tokenExpiresAt = args.tokenExpiresAt;
    }
    if (args.status) {
      patch.status = args.status;
    }
    if (typeof args.lastError === "string") {
      patch.lastError = args.lastError;
    }

    await ctx.db.patch(args.connectionId, patch);
  },
});

export const updateMeetingGoogleCalendarSyncState = internalMutation({
  args: {
    meetingId: v.id("meetings"),
    syncRequested: v.optional(v.boolean()),
    status: GOOGLE_SYNC_STATUS_VALIDATOR,
    eventId: v.optional(v.string()),
    eventUrl: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.meetingId, {
      googleCalendarSyncRequested: args.syncRequested,
      googleCalendarSyncStatus: args.status,
      googleCalendarEventId: args.eventId,
      googleCalendarEventUrl: args.eventUrl,
      googleCalendarLastSyncedAt: Date.now(),
      googleCalendarSyncError: args.error,
    });
  },
});

export const syncMeetingToGoogleCalendar = internalAction({
  args: {
    meetingId: v.id("meetings"),
  },
  handler: async (ctx, args) => {
    const syncContext: GoogleCalendarSyncContext | null = await ctx.runQuery(
      internal.integrations.index.getMeetingGoogleCalendarSyncContext,
      {
        meetingId: args.meetingId,
      },
    );

    if (!syncContext) {
      return null;
    }

    const { meeting, attendeeEmails } = syncContext;
    let connection = syncContext.connection;
    const publicAppUrl = getPublicAppUrl();

    console.info("[google-calendar] Starting meeting sync", {
      meetingId: args.meetingId,
      meetingTitle: meeting.title,
      syncRequested: meeting.googleCalendarSyncRequested ?? false,
      existingEventId: meeting.googleCalendarEventId ?? null,
      scheduledFor: formatLogTimestamp(meeting.scheduledFor),
      scheduledEndsAt: formatLogTimestamp(meeting.scheduledEndsAt),
      scheduledTimeZone: meeting.scheduledTimeZone ?? "UTC",
      attendeeCount: attendeeEmails.length,
      connectionStatus: connection?.status ?? null,
      connectionAccountEmail: connection?.accountEmail ?? null,
      connectionTokenExpiresAt: formatLogTimestamp(connection?.tokenExpiresAt),
      hasRefreshToken: Boolean(connection?.refreshToken),
      hasGoogleClientId: Boolean(process.env.GOOGLE_CLIENT_ID),
      hasGoogleClientSecret: Boolean(process.env.GOOGLE_CLIENT_SECRET),
      hasConfiguredCalendarId: Boolean(process.env.GOOGLE_CALENDAR_ID),
      publicAppUrlConfigured: Boolean(publicAppUrl),
      publicAppUrl: publicAppUrl ?? null,
    });

    if (!meeting.scheduledFor) {
      console.warn("[google-calendar] Skipping sync because meeting is not scheduled", {
        meetingId: args.meetingId,
      });
      await ctx.runMutation(
        internal.integrations.index.updateMeetingGoogleCalendarSyncState,
        {
          meetingId: args.meetingId,
          syncRequested: meeting.googleCalendarSyncRequested,
          status: "failed",
          error: "Meeting is not scheduled, so it cannot be synced to Google Calendar.",
        },
      );
      return null;
    }

    if (!connection || connection.status !== "connected") {
      console.warn("[google-calendar] Skipping sync because Google Calendar is not connected", {
        meetingId: args.meetingId,
        connectionStatus: connection?.status ?? null,
        connectionAccountEmail: connection?.accountEmail ?? null,
      });
      await ctx.runMutation(
        internal.integrations.index.updateMeetingGoogleCalendarSyncState,
        {
          meetingId: args.meetingId,
          syncRequested: meeting.googleCalendarSyncRequested,
          status: "failed",
          error: "Google Calendar is not connected for this host.",
        },
      );
      return null;
    }

    try {
      if (connection.tokenExpiresAt <= Date.now() + 60_000) {
        const refreshed = await exchangeGoogleRefreshToken(connection);
        await ctx.runMutation(
          internal.integrations.index.updateGoogleCalendarConnectionState,
          {
            connectionId: connection._id,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            tokenExpiresAt: refreshed.tokenExpiresAt,
            status: "connected",
            lastError: undefined,
          },
        );

        connection = {
          ...connection,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          tokenExpiresAt: refreshed.tokenExpiresAt,
          status: "connected",
          lastError: undefined,
        };
      }

      const timeZone = meeting.scheduledTimeZone ?? "UTC";
      const scheduledEndsAt = resolveScheduledEndsAt(
        meeting.scheduledFor,
        meeting.scheduledEndsAt,
      );
      const joinUrl = getMeetingJoinUrl(meeting._id);
      if (!joinUrl) {
        console.warn(
          "[google-calendar] Public app URL is missing. Creating the event without a join link.",
          {
            meetingId: args.meetingId,
            publicAppUrlConfigured: Boolean(publicAppUrl),
          },
        );
      }
      const eventPayload = {
        summary: meeting.title,
        description: buildGoogleEventDescription({
          _id: meeting._id,
          title: meeting.title,
          purpose: meeting.purpose,
          description: meeting.description,
        }),
        location: joinUrl ?? undefined,
        source: joinUrl
          ? {
              title: "Meetup",
              url: joinUrl,
            }
          : undefined,
        start: {
          dateTime: formatCalendarDateTimeInTimeZone(
            meeting.scheduledFor,
            timeZone,
          ),
          timeZone,
        },
        end: {
          dateTime: formatCalendarDateTimeInTimeZone(
            scheduledEndsAt,
            timeZone,
          ),
          timeZone,
        },
        attendees: attendeeEmails.map((email) => ({ email })),
        guestsCanInviteOthers: false,
        guestsCanModify: false,
      };

      const endpoint = meeting.googleCalendarEventId
        ? `https://www.googleapis.com/calendar/v3/calendars/primary/events/${meeting.googleCalendarEventId}`
        : "https://www.googleapis.com/calendar/v3/calendars/primary/events";
      const method = meeting.googleCalendarEventId ? "PATCH" : "POST";

      console.info("[google-calendar] Sending event request", {
        meetingId: args.meetingId,
        method,
        endpoint,
        attendeeCount: attendeeEmails.length,
        hasJoinUrl: Boolean(joinUrl),
      });

      const response = await fetch(endpoint, {
        method,
        headers: {
          Authorization: `Bearer ${connection.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(eventPayload),
      });

      const payload = (await response.json()) as
        | {
            id?: string;
            htmlLink?: string;
            error?: {
              message?: string;
            };
          }
        | {
            error?: {
              message?: string;
            };
          };

      if (!response.ok || !("id" in payload) || !payload.id) {
        console.error("[google-calendar] Event sync failed", {
          meetingId: args.meetingId,
          status: response.status,
          error: payload.error?.message ?? "Unable to sync Google Calendar event",
        });
        throw new Error(payload.error?.message ?? "Unable to sync Google Calendar event");
      }

      console.info("[google-calendar] Event sync succeeded", {
        meetingId: args.meetingId,
        eventId: payload.id,
        eventUrl: payload.htmlLink ?? null,
      });

      await ctx.runMutation(
        internal.integrations.index.updateMeetingGoogleCalendarSyncState,
        {
          meetingId: args.meetingId,
          syncRequested: true,
          status: "synced",
          eventId: payload.id,
          eventUrl: payload.htmlLink,
          error: undefined,
        },
      );

      return payload.id;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to sync Google Calendar";

      console.error("[google-calendar] Meeting sync failed", {
        meetingId: args.meetingId,
        connectionId: connection?._id ?? null,
        error: message,
      });

      if (connection?._id && isGoogleCalendarAuthError(message)) {
        await ctx.runMutation(
          internal.integrations.index.updateGoogleCalendarConnectionState,
          {
            connectionId: connection._id,
            status: "error",
            lastError: message,
          },
        );
      }

      await ctx.runMutation(
        internal.integrations.index.updateMeetingGoogleCalendarSyncState,
        {
          meetingId: args.meetingId,
          syncRequested: meeting.googleCalendarSyncRequested,
          status: "failed",
          error: message,
        },
      );
      return null;
    }
  },
});
