import Groq from "groq-sdk";
import {
  hasUnsupportedScript,
  isInstructionArtifact,
  isPromptLeak,
} from "@/lib/transcription/filters";
import { getModeProfile } from "@/lib/transcription/modes";
import {
  TranscriptionProviderError,
  type TranscriptionInput,
  type TranscriptionProvider,
} from "@/lib/transcription/types";

const DEFAULT_MODEL = "whisper-large-v3";
const REQUEST_TIMEOUT_MS = 15_000;

// Whisper reports how sure it is that a segment is real speech; drop the doubtful ones.
const MAX_NO_SPEECH_PROB = 0.35;
const MIN_AVG_LOGPROB = -0.8;
const MAX_COMPRESSION_RATIO = 2.4;

interface WhisperSegment {
  text: string;
  no_speech_prob?: number;
  avg_logprob?: number;
  compression_ratio?: number;
}

interface WhisperResponse {
  text: string;
  segments?: WhisperSegment[];
}

let client: Groq | null = null;

function getClient() {
  client ??= new Groq({
    apiKey: process.env.GROQ_API_KEY,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 1,
  });
  return client;
}

export const groqProvider: TranscriptionProvider = {
  id: "groq",

  isConfigured() {
    return Boolean(process.env.GROQ_API_KEY?.trim());
  },

  async transcribe({ audio, mode, signal }: TranscriptionInput) {
    const profile = getModeProfile(mode);

    let response: WhisperResponse;
    try {
      response = (await getClient().audio.transcriptions.create(
        {
          file: audio,
          model: process.env.GROQ_TRANSCRIPTION_MODEL?.trim() || DEFAULT_MODEL,
          response_format: "verbose_json",
          language: profile.whisperLanguage,
          prompt: profile.whisperPrompt,
          temperature: 0,
        },
        { signal },
      )) as unknown as WhisperResponse;
    } catch (error) {
      const status = error instanceof Groq.APIError ? error.status : undefined;
      throw new TranscriptionProviderError("groq", "Groq transcription failed", status, {
        cause: error,
      });
    }

    let text: string;
    if (Array.isArray(response.segments)) {
      text = response.segments
        .filter((segment) => {
          if (typeof segment.no_speech_prob === "number" && segment.no_speech_prob > MAX_NO_SPEECH_PROB) return false;
          if (typeof segment.avg_logprob === "number" && segment.avg_logprob < MIN_AVG_LOGPROB) return false;
          if (typeof segment.compression_ratio === "number" && segment.compression_ratio > MAX_COMPRESSION_RATIO) return false;
          if (!segment.text || segment.text.trim().length < 2) return false;
          if (hasUnsupportedScript(segment.text, profile.scriptMode)) return false;
          return true;
        })
        .map((segment) => segment.text)
        .join(" ");
    } else {
      text = response.text ?? "";
      if (hasUnsupportedScript(text, profile.scriptMode)) return "";
    }

    text = text.replace(/\s+/g, " ").trim();
    if (isPromptLeak(text, profile.whisperPrompt) || isInstructionArtifact(text)) return "";
    return text;
  },
};
