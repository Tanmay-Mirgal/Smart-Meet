import type { TranscriptionMode } from "@/lib/transcription/modes";

export type TranscriptionProviderId = "nvidia" | "groq";

export interface TranscriptionInput {
  /** Audio chunk from the browser: 16-bit PCM WAV. */
  audio: File;
  mode: TranscriptionMode;
  /** Abort when the caller's own deadline passes. */
  signal?: AbortSignal;
}

export interface TranscriptionProvider {
  readonly id: TranscriptionProviderId;
  isConfigured(): boolean;
  /** Returns the cleaned transcript, "" for silence/noise, or throws on provider failure. */
  transcribe(input: TranscriptionInput): Promise<string>;
}

export class TranscriptionProviderError extends Error {
  constructor(
    readonly provider: TranscriptionProviderId,
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TranscriptionProviderError";
  }
}
