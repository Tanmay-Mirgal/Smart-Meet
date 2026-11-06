// NOTE: shared by the Next.js route (app/api/summarize) and the Convex connector
// action that summarizes server-side, so it must stay free of Next.js / browser
// imports. The prompt, model and JSON repair live HERE only — never fork them.

export type TranscriptInput = {
  sender: string;
  text: string;
};

export type ActionItem = {
  task: string;
  assignee: string | null;
  due: string | null;
};

export type SummaryPayload = {
  summary: string;
  key_points: string[];
  decisions: string[];
  action_items: ActionItem[];
  /** Flat list of task titles — kept for backwards compatibility with createTasksFromSummary */
  actionItems: string[];
};

export const SUMMARY_MODEL = "llama-3.3-70b-versatile";
export const SUMMARY_TIMEOUT_MS = 20_000;
/** The prompt only ever sees this many transcript lines. */
export const SUMMARY_MAX_LINES = 500;
export const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

export function sanitizeInput(value: string) {
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sanitizes transcript lines and drops empty ones. */
export function normalizeTranscript(
  transcript: Array<{ sender?: string; text?: string }>,
): TranscriptInput[] {
  return transcript
    .map((entry) => ({
      sender: sanitizeInput(entry.sender ?? ""),
      text: sanitizeInput(entry.text ?? ""),
    }))
    .filter((entry) => entry.sender && entry.text);
}

export function parseSummaryJson(content: string | null | undefined): SummaryPayload | null {
  if (!content) return null;

  try {
    // Strip markdown code fences the model sometimes wraps output in
    const cleaned = content.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    if (!summary) return null;

    const toStringArray = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean)
        : [];

    const rawItems = Array.isArray(parsed.action_items) ? parsed.action_items : [];
    const action_items: ActionItem[] = rawItems.map((item) => {
      if (typeof item === "string") return { task: item, assignee: null, due: null };
      const obj = item as Record<string, unknown>;
      return {
        task: typeof obj.task === "string" ? obj.task.trim() : String(obj),
        assignee: typeof obj.assignee === "string" ? obj.assignee.trim() : null,
        due: typeof obj.due === "string" ? obj.due.trim() : null,
      };
    });

    return {
      summary,
      key_points: toStringArray(parsed.key_points),
      decisions: toStringArray(parsed.decisions),
      action_items,
      actionItems: action_items.map((item) => item.task).filter(Boolean),
    };
  } catch {
    return null;
  }
}

/**
 * The exact chat-completion request used for every summary. With no `language`
 * the prompt is byte-for-byte what the browser flow has always sent.
 */
export function buildSummaryRequest(
  transcript: TranscriptInput[],
  options: { language?: string } = {},
) {
  const formattedTranscript = transcript
    .slice(0, SUMMARY_MAX_LINES)
    .map((e) => `${e.sender}: ${e.text}`)
    .join("\n");

  const rules = [
    "Rules:",
    "- summary: use markdown with ## sub-headings (Overview, Risks/Blockers if any)",
    "- key_points: top 3-5 discussion highlights",
    "- decisions: concrete decisions made (empty array if none)",
    "- action_items: deduplicated, concrete, actionable tasks",
  ];
  if (options.language) {
    rules.push(`- write every text value in the language with BCP-47 code "${options.language}"`);
  }

  return {
    model: SUMMARY_MODEL,
    temperature: 0.2,
    max_completion_tokens: 1500,
    response_format: { type: "json_object" as const },
    messages: [
      {
        role: "system" as const,
        content: [
          "You are an expert meeting assistant. Return ONLY valid JSON with no extra text.",
          "Respond with exactly this shape:",
          JSON.stringify({
            summary: "concise professional markdown summary (2-4 paragraphs)",
            key_points: ["bullet point 1", "bullet point 2"],
            decisions: ["decision made 1"],
            action_items: [{ task: "short task title", assignee: "name or null", due: "date string or null" }],
          }),
          ...rules,
        ].join(" "),
      },
      {
        role: "user" as const,
        content: `Summarize the following meeting transcript:\n\n${formattedTranscript}`,
      },
    ],
  };
}

export class SummarizerError extends Error {
  readonly kind: "timeout" | "upstream" | "invalid";
  readonly status?: number;

  constructor(message: string, kind: "timeout" | "upstream" | "invalid", status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Calls Groq over plain `fetch` (works in the Convex runtime, where the SDK the
 * Next route uses is not needed) with the shared request and parser.
 */
export async function requestSummary(
  apiKey: string,
  transcript: TranscriptInput[],
  options: { language?: string } = {},
): Promise<SummaryPayload> {
  let response: Response;
  try {
    response = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildSummaryRequest(transcript, options)),
      signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new SummarizerError("Summary generation timed out", "timeout");
    }
    throw new SummarizerError("Could not reach the summarization service", "upstream");
  }

  if (!response.ok) {
    throw new SummarizerError(`Summarization service error (${response.status})`, "upstream", response.status);
  }

  const payload = (await response.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  } | null;
  const parsed = parseSummaryJson(payload?.choices?.[0]?.message?.content);
  if (!parsed) {
    throw new SummarizerError("The summarization service returned an invalid response", "invalid");
  }
  return parsed;
}
