export const TRANSCRIPTION_MODES = [
  "auto",
  "hindi_english_marathi",
  "hindi_english",
  "hindi",
  "marathi",
  "english",
] as const;

export type TranscriptionMode = (typeof TRANSCRIPTION_MODES)[number];

/** Which scripts a transcript may contain before it is treated as noise. */
export type ScriptMode = "devanagari_latin" | "latin_only";

export interface ModeProfile {
  /** ISO language hint for Whisper; undefined lets the model detect it. */
  whisperLanguage: string | undefined;
  whisperPrompt: string;
  scriptMode: ScriptMode;
  /** BCP-47 code (or "multi") sent to NVIDIA Riva ASR. */
  nvidiaLanguage: string;
  /**
   * Whether NVIDIA's Parakeet multilingual model covers every language in this mode.
   * It supports Hindi (hi-IN) and English but not Marathi, so Marathi modes stay on Whisper
   * when the provider is left on "auto".
   */
  nvidiaSupported: boolean;
}

const PROFILES: Record<TranscriptionMode, ModeProfile> = {
  hindi_english_marathi: {
    whisperLanguage: undefined,
    whisperPrompt: "Mixed Hindi, Marathi, and English conversation. Output only the spoken words.",
    scriptMode: "devanagari_latin",
    nvidiaLanguage: "multi",
    nvidiaSupported: false,
  },
  hindi_english: {
    whisperLanguage: "hi",
    whisperPrompt: "Mixed Hindi and English conversation. Output only the spoken words.",
    scriptMode: "devanagari_latin",
    nvidiaLanguage: "hi-IN",
    nvidiaSupported: true,
  },
  hindi: {
    whisperLanguage: "hi",
    whisperPrompt: "Hindi speech. Output only the spoken words.",
    scriptMode: "devanagari_latin",
    nvidiaLanguage: "hi-IN",
    nvidiaSupported: true,
  },
  marathi: {
    whisperLanguage: "mr",
    whisperPrompt: "Marathi speech. Output only the spoken words.",
    scriptMode: "devanagari_latin",
    nvidiaLanguage: "multi",
    nvidiaSupported: false,
  },
  english: {
    whisperLanguage: "en",
    whisperPrompt: "English speech. Output only the spoken words.",
    scriptMode: "latin_only",
    nvidiaLanguage: "en-US",
    nvidiaSupported: true,
  },
  auto: {
    whisperLanguage: "hi",
    whisperPrompt: "Indian multilingual speech (Hindi, Marathi, English). Output only the spoken words.",
    scriptMode: "devanagari_latin",
    nvidiaLanguage: "multi",
    nvidiaSupported: false,
  },
};

export function isTranscriptionMode(value: unknown): value is TranscriptionMode {
  return typeof value === "string" && (TRANSCRIPTION_MODES as readonly string[]).includes(value);
}

export function parseTranscriptionMode(value: unknown): TranscriptionMode {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isTranscriptionMode(normalized) ? normalized : "auto";
}

export function getModeProfile(mode: TranscriptionMode): ModeProfile {
  return PROFILES[mode];
}
