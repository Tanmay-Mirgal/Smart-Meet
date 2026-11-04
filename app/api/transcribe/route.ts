import { NextResponse } from "next/server";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import {
  TranscriptionProviderError,
  parseTranscriptionMode,
  transcribeAudio,
} from "@/lib/transcription";

export const runtime = "nodejs";

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const TRANSCRIBE_RATE_LIMIT = 90;
const TRANSCRIBE_RATE_WINDOW_MS = 60_000;

function getFileExtension(file: File) {
  const filename = file.name || "";
  const lastSegment = filename.split(".").pop()?.toLowerCase();

  if (lastSegment && lastSegment !== filename.toLowerCase()) {
    return lastSegment;
  }

  const mimeType = file.type.toLowerCase();
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    if (isRateLimited(`transcribe:${ip}`, TRANSCRIBE_RATE_LIMIT, TRANSCRIBE_RATE_WINDOW_MS)) {
      return NextResponse.json(
        { error: "Too many transcription requests", text: "" },
        { status: 429 },
      );
    }

    const formData = await request.formData();
    const audioBlob = formData.get("audio") as File | null;

    if (!audioBlob || audioBlob.size === 0) {
      return NextResponse.json({ text: "" });
    }
    if (audioBlob.size > MAX_AUDIO_BYTES) {
      return NextResponse.json(
        { error: "Audio chunk too large", text: "" },
        { status: 413 },
      );
    }

    const extension = getFileExtension(audioBlob);
    const file = new File([audioBlob], audioBlob.name || `audio.${extension}`, {
      type: audioBlob.type || `audio/${extension}`,
    });

    const { text, provider } = await transcribeAudio(
      file,
      parseTranscriptionMode(formData.get("mode")),
      request.signal,
    );

    return NextResponse.json({ text }, { headers: { "x-transcription-provider": provider } });
  } catch (error) {
    console.error("[transcribe] failed:", error);
    const status = error instanceof TranscriptionProviderError ? error.status : undefined;
    return NextResponse.json(
      { error: "Transcription failed", text: "" },
      { status: status && status >= 400 && status < 600 ? status : 502 },
    );
  }
}
