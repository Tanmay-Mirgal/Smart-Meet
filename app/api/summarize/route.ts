import Groq from "groq-sdk";
import { NextResponse } from "next/server";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import {
  SUMMARY_TIMEOUT_MS,
  buildSummaryRequest,
  normalizeTranscript,
  parseSummaryJson,
  type SummaryPayload as SharedSummaryPayload,
  type TranscriptInput,
} from "@/lib/summarizer";

// The prompt, model and JSON repair are shared with the connector's server-side
// summarizer (lib/summarizer.ts) so the two paths can never drift apart.
export type SummaryPayload = SharedSummaryPayload;

const REQUEST_TIMEOUT_MS = SUMMARY_TIMEOUT_MS;
const SUMMARY_RATE_LIMIT = 30;
const SUMMARY_RATE_WINDOW_MS = 60_000;

export async function POST(req: Request) {
  const ip = getClientIp(req);
  if (
    isRateLimited(
      `summarize:${ip}`,
      SUMMARY_RATE_LIMIT,
      SUMMARY_RATE_WINDOW_MS,
    )
  ) {
    return NextResponse.json(
      { error: "Too many summary requests. Please retry in a minute." },
      { status: 429 },
    );
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GROQ_API_KEY is not configured" }, { status: 500 });
  }

  let transcript: TranscriptInput[];
  try {
    const payload = (await req.json()) as { transcript?: TranscriptInput[] };
    transcript = payload.transcript ?? [];
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const normalized = normalizeTranscript(transcript);

  if (normalized.length === 0) {
    return NextResponse.json({ error: "No transcript provided" }, { status: 400 });
  }

  const groq = new Groq({ apiKey, maxRetries: 0, timeout: REQUEST_TIMEOUT_MS });

  try {
    const completion = await groq.chat.completions.create(
      buildSummaryRequest(normalized),
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );

    const content = completion.choices[0]?.message?.content;
    const parsed = parseSummaryJson(content);

    if (!parsed) {
      return NextResponse.json({ error: "Groq returned an invalid response" }, { status: 502 });
    }

    return NextResponse.json(parsed);
  } catch (error) {
    if (error instanceof Groq.APIConnectionTimeoutError) {
      return NextResponse.json({ error: "Summary generation timed out" }, { status: 504 });
    }
    if (error instanceof Groq.APIError) {
      return NextResponse.json({ error: error.message || "Groq request failed" }, { status: error.status || 502 });
    }
    console.error("API Summarize Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
