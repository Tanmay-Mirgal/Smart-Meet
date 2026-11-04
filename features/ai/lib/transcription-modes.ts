import type { TranscriptionMode } from "@/features/ai/hooks/use-transcription";

export const TRANSCRIPTION_MODE_STORAGE_KEY = "meetup-transcription-mode";
/** Key used before the Meetup rebrand; still read so saved preferences carry over. */
const LEGACY_TRANSCRIPTION_MODE_STORAGE_KEY = "meeting-bot-transcription-mode";

export const TRANSCRIPTION_MODE_OPTIONS: ReadonlyArray<{
  value: TranscriptionMode;
  label: string;
}> = [
  { value: "hindi_english_marathi", label: "Hindi + Marathi + English" },
  { value: "hindi_english", label: "Hindi + English" },
  { value: "hindi", label: "Hindi" },
  { value: "marathi", label: "Marathi" },
  { value: "english", label: "English" },
  { value: "auto", label: "Auto-detect" },
];

export function isTranscriptionMode(value: unknown): value is TranscriptionMode {
  return TRANSCRIPTION_MODE_OPTIONS.some((option) => option.value === value);
}

/** Reads the saved mode (browser only). Returns null when nothing valid is stored. */
export function readStoredTranscriptionMode(): TranscriptionMode | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const stored =
      window.localStorage.getItem(TRANSCRIPTION_MODE_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_TRANSCRIPTION_MODE_STORAGE_KEY);
    return isTranscriptionMode(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function storeTranscriptionMode(mode: TranscriptionMode) {
  try {
    window.localStorage.setItem(TRANSCRIPTION_MODE_STORAGE_KEY, mode);
  } catch {
    // Storage can be unavailable (private mode); the preference simply isn't remembered.
  }
}
