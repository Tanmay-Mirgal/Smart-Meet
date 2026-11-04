import { Client, Metadata, credentials, type ServiceError } from "@grpc/grpc-js";
import { finalizeTranscript } from "@/lib/transcription/filters";
import { getModeProfile } from "@/lib/transcription/modes";
import {
  RIVA_RECOGNIZE_PATH,
  decodeRecognizeResponse,
  encodeRecognizeRequest,
  readPcmWav,
} from "@/lib/transcription/riva-codec";
import {
  TranscriptionProviderError,
  type TranscriptionInput,
  type TranscriptionProvider,
} from "@/lib/transcription/types";

/**
 * NVIDIA speech-to-text (Riva ASR / Parakeet), two ways to reach it:
 *
 *  1. Hosted on NVIDIA's API catalog (build.nvidia.com) — set NVIDIA_API_KEY.
 *     Riva speaks gRPC, so we call `grpc.nvcf.nvidia.com:443` with the model's function id.
 *  2. A self-hosted Speech NIM — set NVIDIA_ASR_HTTP_URL (REST) or NVIDIA_ASR_SERVER (gRPC).
 */

/** parakeet-1.1b-rnnt-multilingual-asr on build.nvidia.com. */
const DEFAULT_FUNCTION_ID = "71203149-d3b7-4460-8231-1be2543a1fca";
const DEFAULT_GRPC_SERVER = "grpc.nvcf.nvidia.com:443";
const DEFAULT_TIMEOUT_MS = 8_000;

function readEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function getTimeoutMs() {
  const parsed = Number(readEnv("NVIDIA_ASR_TIMEOUT_MS"));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

// ── gRPC transport ───────────────────────────────────────────────────────────

let grpcClient: { target: string; client: Client } | null = null;

/** One long-lived channel: skips a TLS handshake on every audio chunk. */
function getGrpcClient(target: string, useSsl: boolean) {
  if (grpcClient?.target === target) {
    return grpcClient.client;
  }

  grpcClient?.client.close();
  const client = new Client(
    target,
    useSsl ? credentials.createSsl() : credentials.createInsecure(),
    {
      "grpc.keepalive_time_ms": 30_000,
      "grpc.keepalive_timeout_ms": 5_000,
      "grpc.keepalive_permit_without_calls": 1,
    },
  );
  grpcClient = { target, client };
  return client;
}

function recognizeOverGrpc(request: Buffer, signal?: AbortSignal) {
  const target = readEnv("NVIDIA_ASR_SERVER") ?? DEFAULT_GRPC_SERVER;
  const useSsl = readEnv("NVIDIA_ASR_USE_SSL")?.toLowerCase() !== "false";
  const apiKey = readEnv("NVIDIA_API_KEY");
  const functionId = readEnv("NVIDIA_ASR_FUNCTION_ID") ?? DEFAULT_FUNCTION_ID;

  const metadata = new Metadata();
  if (apiKey) {
    metadata.set("authorization", `Bearer ${apiKey}`);
    // The hosted catalog routes by function id; self-hosted servers ignore it.
    if (target === DEFAULT_GRPC_SERVER) metadata.set("function-id", functionId);
  }

  return new Promise<Buffer>((resolve, reject) => {
    const call = getGrpcClient(target, useSsl).makeUnaryRequest<Buffer, Buffer>(
      RIVA_RECOGNIZE_PATH,
      (value) => value,
      (value) => value,
      request,
      metadata,
      { deadline: Date.now() + getTimeoutMs() },
      (error: ServiceError | null, response?: Buffer) => {
        if (error || !response) {
          reject(error ?? new Error("Empty gRPC response"));
          return;
        }
        resolve(response);
      },
    );

    signal?.addEventListener("abort", () => call.cancel(), { once: true });
  });
}

// ── REST transport (self-hosted Speech NIM) ──────────────────────────────────

async function recognizeOverHttp(baseUrl: string, audio: File, language: string, signal?: AbortSignal) {
  const form = new FormData();
  form.append("file", audio, "chunk.wav");
  form.append("language", language);
  form.append("response_format", "json");

  const apiKey = readEnv("NVIDIA_API_KEY");
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(getTimeoutMs())])
      : AbortSignal.timeout(getTimeoutMs()),
  });

  if (!response.ok) {
    throw new TranscriptionProviderError("nvidia", `NVIDIA NIM returned ${response.status}`, response.status);
  }

  const body = (await response.json()) as { text?: unknown };
  return typeof body.text === "string" ? body.text : "";
}

// ── Provider ─────────────────────────────────────────────────────────────────

export const nvidiaProvider: TranscriptionProvider = {
  id: "nvidia",

  isConfigured() {
    return Boolean(readEnv("NVIDIA_API_KEY") ?? readEnv("NVIDIA_ASR_HTTP_URL") ?? readEnv("NVIDIA_ASR_SERVER"));
  },

  async transcribe({ audio, mode, signal }: TranscriptionInput) {
    const profile = getModeProfile(mode);
    const language = readEnv("NVIDIA_ASR_LANGUAGE_CODE") ?? profile.nvidiaLanguage;

    try {
      const httpUrl = readEnv("NVIDIA_ASR_HTTP_URL");
      let text: string;

      if (httpUrl) {
        text = await recognizeOverHttp(httpUrl, audio, language, signal);
      } else {
        const wav = readPcmWav(Buffer.from(await audio.arrayBuffer()));
        if (!wav) {
          throw new TranscriptionProviderError("nvidia", "Audio must be 16-bit mono PCM WAV");
        }

        const response = await recognizeOverGrpc(
          encodeRecognizeRequest({
            pcm: wav.pcm,
            sampleRateHertz: wav.sampleRateHertz,
            languageCode: language,
          }),
          signal,
        );
        text = decodeRecognizeResponse(response);
      }

      return finalizeTranscript(text, profile.scriptMode);
    } catch (error) {
      if (error instanceof TranscriptionProviderError) throw error;
      throw new TranscriptionProviderError("nvidia", "NVIDIA transcription failed", undefined, {
        cause: error,
      });
    }
  },
};
