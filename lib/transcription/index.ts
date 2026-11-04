import { groqProvider } from "@/lib/transcription/groq";
import { nvidiaProvider } from "@/lib/transcription/nvidia";
import { getModeProfile, type TranscriptionMode } from "@/lib/transcription/modes";
import {
  TranscriptionProviderError,
  type TranscriptionProvider,
  type TranscriptionProviderId,
} from "@/lib/transcription/types";

export { parseTranscriptionMode } from "@/lib/transcription/modes";
export { TranscriptionProviderError } from "@/lib/transcription/types";

/**
 * TRANSCRIPTION_PROVIDER:
 *  - "auto"   (default) NVIDIA where it covers the language, Groq Whisper for the rest
 *  - "nvidia" NVIDIA first for every mode, Groq Whisper as the fallback
 *  - "groq"   Groq Whisper only
 */
type ProviderPreference = "auto" | "nvidia" | "groq";

function getPreference(): ProviderPreference {
  const value = process.env.TRANSCRIPTION_PROVIDER?.trim().toLowerCase();
  return value === "nvidia" || value === "groq" ? value : "auto";
}

/** Providers to try, fastest-preferred first. Unconfigured providers are skipped. */
export function selectProviders(mode: TranscriptionMode): TranscriptionProvider[] {
  const preference = getPreference();
  const nvidiaFirst =
    preference === "nvidia" || (preference === "auto" && getModeProfile(mode).nvidiaSupported);

  const ordered =
    preference === "groq"
      ? [groqProvider]
      : nvidiaFirst
        ? [nvidiaProvider, groqProvider]
        : [groqProvider, nvidiaProvider];

  // In "auto", NVIDIA is only a fallback for modes it can't fully handle if Groq is missing.
  return ordered.filter((provider) => provider.isConfigured());
}

export interface TranscriptionOutcome {
  text: string;
  provider: TranscriptionProviderId;
}

/**
 * Transcribes one audio chunk, falling through to the next provider when one fails.
 * An empty transcript is a valid answer (silence) and does not trigger a fallback.
 */
export async function transcribeAudio(
  audio: File,
  mode: TranscriptionMode,
  signal?: AbortSignal,
): Promise<TranscriptionOutcome> {
  const providers = selectProviders(mode);
  if (providers.length === 0) {
    throw new Error("No transcription provider is configured. Set GROQ_API_KEY or NVIDIA_API_KEY.");
  }

  let lastError: unknown;
  for (const provider of providers) {
    try {
      const text = await provider.transcribe({ audio, mode, signal });
      return { text, provider: provider.id };
    } catch (error) {
      lastError = error;
      console.warn(
        `[transcribe] ${provider.id} failed${providers.length > 1 ? ", trying next provider" : ""}:`,
        error instanceof TranscriptionProviderError ? error.message : error,
      );
    }
  }

  throw lastError;
}
