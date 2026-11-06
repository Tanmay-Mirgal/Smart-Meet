import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SUMMARY_MAX_LINES,
  SUMMARY_MODEL,
  SummarizerError,
  buildSummaryRequest,
  normalizeTranscript,
  parseSummaryJson,
  requestSummary,
  sanitizeInput,
} from "../../lib/summarizer";

afterEach(() => vi.unstubAllGlobals());

// The system prompt exactly as app/api/summarize shipped it before the extraction.
const ORIGINAL_SYSTEM_PROMPT =
  'You are an expert meeting assistant. Return ONLY valid JSON with no extra text. Respond with exactly this shape: {"summary":"concise professional markdown summary (2-4 paragraphs)","key_points":["bullet point 1","bullet point 2"],"decisions":["decision made 1"],"action_items":[{"task":"short task title","assignee":"name or null","due":"date string or null"}]} Rules: - summary: use markdown with ## sub-headings (Overview, Risks/Blockers if any) - key_points: top 3-5 discussion highlights - decisions: concrete decisions made (empty array if none) - action_items: deduplicated, concrete, actionable tasks';

describe("shared summary prompt", () => {
  it("is byte-for-byte what the browser flow has always sent", () => {
    const request = buildSummaryRequest([
      { sender: "Ann", text: "hello" },
      { sender: "Bob", text: "world" },
    ]);
    expect(request.model).toBe("llama-3.3-70b-versatile");
    expect(SUMMARY_MODEL).toBe("llama-3.3-70b-versatile");
    expect(request.temperature).toBe(0.2);
    expect(request.max_completion_tokens).toBe(1500);
    expect(request.response_format).toEqual({ type: "json_object" });
    expect(request.messages[0]).toEqual({ role: "system", content: ORIGINAL_SYSTEM_PROMPT });
    expect(request.messages[1]).toEqual({
      role: "user",
      content: "Summarize the following meeting transcript:\n\nAnn: hello\nBob: world",
    });
  });

  it("only adds a language rule when one is requested", () => {
    const plain = buildSummaryRequest([{ sender: "A", text: "x" }]);
    const hindi = buildSummaryRequest([{ sender: "A", text: "x" }], { language: "hi" });
    expect(plain.messages[0].content).not.toMatch(/BCP-47/);
    expect(hindi.messages[0].content).toBe(
      `${ORIGINAL_SYSTEM_PROMPT} - write every text value in the language with BCP-47 code "hi"`,
    );
  });

  it("only ever sends the first 500 lines", () => {
    const lines = Array.from({ length: 600 }, (_, i) => ({ sender: "S", text: `line ${i}` }));
    const content = buildSummaryRequest(lines).messages[1].content;
    expect(content.split("\n").filter((l) => l.startsWith("S: ")).length).toBe(SUMMARY_MAX_LINES);
    expect(content).toContain("line 499");
    expect(content).not.toContain("line 500");
  });
});

describe("transcript normalisation and JSON repair", () => {
  it("sanitises control characters and drops empty lines", () => {
    expect(sanitizeInput("a\u0000b\n\n  c\t")).toBe("a b c");
    expect(
      normalizeTranscript([
        { sender: " Ann ", text: "hi\nthere" },
        { sender: "", text: "no speaker" },
        { sender: "Bob", text: "   " },
      ]),
    ).toEqual([{ sender: "Ann", text: "hi there" }]);
  });

  it("strips markdown fences and tolerates string action items", () => {
    const parsed = parseSummaryJson(
      '```json\n{"summary":" Done ","key_points":["a",3,"b"],"decisions":[],"action_items":["Ship it",{"task":"Docs","assignee":"Mia","due":"Friday"}]}\n```',
    );
    expect(parsed).toEqual({
      summary: "Done",
      key_points: ["a", "b"],
      decisions: [],
      action_items: [
        { task: "Ship it", assignee: null, due: null },
        { task: "Docs", assignee: "Mia", due: "Friday" },
      ],
      actionItems: ["Ship it", "Docs"],
    });
  });

  it("rejects empty, malformed and summary-less output", () => {
    expect(parseSummaryJson(null)).toBeNull();
    expect(parseSummaryJson("not json")).toBeNull();
    expect(parseSummaryJson('{"summary":"  "}')).toBeNull();
  });
});

describe("requestSummary (server-side call)", () => {
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("posts the shared request to Groq with the API key and parses the answer", async () => {
    const fetchMock = vi.fn(async () =>
      reply({ choices: [{ message: { content: '{"summary":"S","key_points":["k"],"decisions":[],"action_items":[]}' } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestSummary("gsk_test", [{ sender: "A", text: "x" }]);
    expect(result.summary).toBe("S");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gsk_test");
    expect(JSON.parse(init.body as string)).toEqual(buildSummaryRequest([{ sender: "A", text: "x" }]));
  });

  it("classifies upstream, invalid and timeout failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({}, 503)));
    await expect(requestSummary("k", [{ sender: "A", text: "x" }])).rejects.toMatchObject({
      kind: "upstream",
      status: 503,
    });

    vi.stubGlobal("fetch", vi.fn(async () => reply({ choices: [{ message: { content: "garbage" } }] })));
    await expect(requestSummary("k", [{ sender: "A", text: "x" }])).rejects.toMatchObject({ kind: "invalid" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      }),
    );
    const error = await requestSummary("k", [{ sender: "A", text: "x" }]).catch((e) => e);
    expect(error).toBeInstanceOf(SummarizerError);
    expect(error.kind).toBe("timeout");
  });
});
