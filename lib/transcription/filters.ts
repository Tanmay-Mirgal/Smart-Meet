import type { ScriptMode } from "@/lib/transcription/modes";

// Whisper sometimes echoes its own prompt back when it hears silence or noise.
const PROMPT_LEAK_SNIPPETS = [
  "output only the spoken words",
  "do not translate",
  "do not translate or paraphrase",
  "preserve names and technical terms",
];

const INSTRUCTION_ARTIFACTS = [
  "do not translate",
  "don't translate",
  "do not translate or paraphrase",
  "preserve names and technical terms",
  "keep names and technical terms as spoken",
  "keep code switching",
];

const LATIN = /[A-Za-z]/;
const DEVANAGARI = /[ऀ-ॿ]/;
const NEUTRAL = /[\d\s.,!?'"`~@#$%^&*()_\-+=:;<>/\\|[\]{}]/;

/** True when the text contains letters from a script the selected mode does not expect. */
export function hasUnsupportedScript(text: string, scriptMode: ScriptMode) {
  if (!text.trim()) return false;

  for (const ch of text) {
    if (NEUTRAL.test(ch)) continue;
    if (scriptMode === "latin_only") {
      if (LATIN.test(ch)) continue;
      return true;
    }
    if (LATIN.test(ch) || DEVANAGARI.test(ch)) continue;
    return true;
  }

  return false;
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

export function isPromptLeak(text: string, prompt: string | undefined) {
  const normalizedText = normalizeText(text);
  if (!normalizedText) return false;

  const normalizedPrompt = prompt ? normalizeText(prompt) : "";
  if (normalizedPrompt && normalizedText.length >= 24 && normalizedPrompt.includes(normalizedText)) {
    return true;
  }

  return PROMPT_LEAK_SNIPPETS.some((snippet) => normalizedText.includes(snippet));
}

export function isInstructionArtifact(text: string) {
  const normalizedText = normalizeText(text);
  if (!normalizedText) return false;

  return INSTRUCTION_ARTIFACTS.some(
    (artifact) => normalizedText === artifact || normalizedText.startsWith(artifact),
  );
}

/** Final gate for any provider's transcript: returns "" when the text is not usable speech. */
export function finalizeTranscript(text: string, scriptMode: ScriptMode, prompt?: string) {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  if (hasUnsupportedScript(trimmed, scriptMode)) return "";
  if (isPromptLeak(trimmed, prompt) || isInstructionArtifact(trimmed)) return "";
  return trimmed;
}
