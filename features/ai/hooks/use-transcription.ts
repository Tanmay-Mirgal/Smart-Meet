"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TranscriptionMode } from "@/lib/transcription/modes";

export type TranscriptLine = {
  id: string;
  sender: string;
  senderId: string;
  text: string;
  isInterim?: boolean;
  timestamp: number;
};

export type { TranscriptionMode };

const PROCESSOR_BUFFER_SIZE = 4096;
const VOICE_RMS_THRESHOLD = 0.02;
const VOICE_HANGOVER_FRAMES = 10; // ~0.85 seconds of silence ends an utterance
const MIN_VOICED_AUDIO_MS = 350;
const MAX_CHUNK_DURATION_SECONDS = 12;
// Speech models resample to 16 kHz anyway; sending 16 kHz cuts each upload to about a third.
const TARGET_SAMPLE_RATE = 16_000;

type AudioContextConstructor = typeof AudioContext;

declare global {
  interface Window {
    webkitAudioContext?: AudioContextConstructor;
  }
}

function getAudioContextConstructor() {
  return window.AudioContext ?? window.webkitAudioContext;
}

function mergeFloat32Chunks(chunks: Float32Array[], totalLength: number) {
  const merged = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

/** Box-filter downsample (averaging doubles as a cheap anti-alias filter). */
function downsample(samples: Float32Array, inputRate: number) {
  if (inputRate <= TARGET_SAMPLE_RATE) {
    return { samples, sampleRate: inputRate };
  }

  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.floor(samples.length / ratio);
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(samples.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1) {
      sum += samples[cursor] ?? 0;
    }
    output[index] = end > start ? sum / (end - start) : 0;
  }

  return { samples: output, sampleRate: TARGET_SAMPLE_RATE };
}

function encodeWav(samples: Float32Array, sampleRate: number) {
  const bytesPerSample = 2;
  const channelCount = 1;
  const dataLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    const normalized = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(offset, normalized, true);
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Production-oriented transcription hook.
 * Captures raw PCM with Web Audio, encodes browser-agnostic WAV chunks,
 * and sends them to /api/transcribe. This is more reliable than MediaRecorder
 * containers across Brave, Chrome, Firefox, and Safari.
 */
export function useTranscription({
  enabled,
  stream,
  mode,
  userName,
  userId,
  onTranscript,
}: {
  enabled: boolean;
  stream: MediaStream | null;
  mode: TranscriptionMode;
  userName: string;
  userId: string;
  onTranscript: (line: TranscriptLine) => void;
}) {
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const sinkGainNodeRef = useRef<GainNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const sampleCountRef = useRef(0);
  const voicedSampleCountRef = useRef(0);
  const hasSpeechRef = useRef(false);
  const hangoverFramesRef = useRef(0);
  const enabledRef = useRef(enabled);
  const onTranscriptRef = useRef(onTranscript);
  const userNameRef = useRef(userName);
  const userIdRef = useRef(userId);
  const modeRef = useRef(mode);

  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    enabledRef.current = enabled;
    onTranscriptRef.current = onTranscript;
    userNameRef.current = userName;
    userIdRef.current = userId;
    modeRef.current = mode;
  }, [enabled, mode, onTranscript, userName, userId]);

  const sendChunk = useCallback(async (blob: Blob) => {
    if (blob.size < 1000) {
      return;
    }

    const form = new FormData();
    form.append("audio", new File([blob], "chunk.wav", { type: "audio/wav" }));
    form.append("mode", modeRef.current);

    try {
      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      const data = (await res.json()) as { text?: string };
      const text = data.text?.trim();

      if (text) {
        onTranscriptRef.current({
          id: `whisper-${Date.now()}`,
          sender: userNameRef.current,
          senderId: userIdRef.current,
          text,
          timestamp: Date.now(),
        });
      }
    } catch {
      // Ignore transient transcription network failures for now.
    }
  }, []);

  const flushChunk = useCallback(async () => {
    const audioContext = audioContextRef.current;
    const voicedDurationMs = audioContext
      ? (voicedSampleCountRef.current / audioContext.sampleRate) * 1000
      : 0;

    if (
      !audioContext
      || sampleCountRef.current === 0
      || !hasSpeechRef.current
      || voicedDurationMs < MIN_VOICED_AUDIO_MS
    ) {
      chunksRef.current = [];
      sampleCountRef.current = 0;
      voicedSampleCountRef.current = 0;
      hasSpeechRef.current = false;
      return;
    }

    const merged = mergeFloat32Chunks(chunksRef.current, sampleCountRef.current);
    chunksRef.current = [];
    sampleCountRef.current = 0;
    voicedSampleCountRef.current = 0;
    hasSpeechRef.current = false;

    const downsampled = downsample(merged, audioContext.sampleRate);
    const wavBlob = encodeWav(downsampled.samples, downsampled.sampleRate);
    await sendChunk(wavBlob);
  }, [sendChunk]);

  const stopCapture = useCallback((flushFinalChunk: boolean) => {
    const processorNode = processorNodeRef.current;
    const sourceNode = sourceNodeRef.current;
    const sinkGainNode = sinkGainNodeRef.current;
    const audioContext = audioContextRef.current;

    processorNodeRef.current = null;
    sourceNodeRef.current = null;
    sinkGainNodeRef.current = null;
    audioContextRef.current = null;

    if (processorNode) {
      processorNode.onaudioprocess = null;
      try {
        processorNode.disconnect();
      } catch {
        // Ignore disconnect failures during cleanup.
      }
    }

    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch {
        // Ignore disconnect failures during cleanup.
      }
    }

    if (sinkGainNode) {
      try {
        sinkGainNode.disconnect();
      } catch {
        // Ignore disconnect failures during cleanup.
      }
    }

    if (flushFinalChunk) {
      void flushChunk();
    } else {
      chunksRef.current = [];
      sampleCountRef.current = 0;
      voicedSampleCountRef.current = 0;
      hasSpeechRef.current = false;
    }

    hangoverFramesRef.current = 0;

    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => undefined);
    }

    window.requestAnimationFrame(() => {
      setIsListening(false);
    });
  }, [flushChunk]);

  const startCapture = useCallback(async (mediaStream: MediaStream) => {
    if (audioContextRef.current || typeof window === "undefined") {
      return;
    }

    const AudioContextClass = getAudioContextConstructor();
    if (!AudioContextClass) {
      setError("Web Audio is not supported in this browser.");
      return;
    }

    const audioTracks = mediaStream
      .getAudioTracks()
      .filter((track) => track.readyState === "live");

    if (audioTracks.length === 0) {
      setError("No audio track found in the stream.");
      return;
    }

    const audioOnlyStream = new MediaStream(audioTracks);

    try {
      const audioContext = new AudioContextClass();
      await audioContext.resume();

      const sourceNode = audioContext.createMediaStreamSource(audioOnlyStream);
      const processorNode = audioContext.createScriptProcessor(
        PROCESSOR_BUFFER_SIZE,
        1,
        1,
      );
      const sinkGainNode = audioContext.createGain();
      sinkGainNode.gain.value = 0;

      processorNode.onaudioprocess = (event) => {
        if (!enabledRef.current) {
          return;
        }

        const input = event.inputBuffer.getChannelData(0);
        let sumSquares = 0;
        for (let index = 0; index < input.length; index += 1) {
          const sample = input[index] ?? 0;
          sumSquares += sample * sample;
        }

        const rms = Math.sqrt(sumSquares / input.length);
        const hasVoice = rms >= VOICE_RMS_THRESHOLD;

        if (hasVoice) {
          hasSpeechRef.current = true;
          hangoverFramesRef.current = VOICE_HANGOVER_FRAMES;
          voicedSampleCountRef.current += input.length;
        } else if (hangoverFramesRef.current > 0) {
          hangoverFramesRef.current -= 1;
        }

        if (!hasVoice && hangoverFramesRef.current <= 0) {
          if (hasSpeechRef.current) {
            void flushChunk();
          }
          return;
        }

        const chunk = new Float32Array(input.length);
        chunk.set(input);
        chunksRef.current.push(chunk);
        sampleCountRef.current += chunk.length;

        if (audioContextRef.current && (sampleCountRef.current / audioContextRef.current.sampleRate) >= MAX_CHUNK_DURATION_SECONDS) {
          void flushChunk();
        }
      };

      sourceNode.connect(processorNode);
      processorNode.connect(sinkGainNode);
      sinkGainNode.connect(audioContext.destination);

      audioContextRef.current = audioContext;
      sourceNodeRef.current = sourceNode;
      processorNodeRef.current = processorNode;
      sinkGainNodeRef.current = sinkGainNode;

      window.requestAnimationFrame(() => {
        setError(null);
        setIsListening(true);
      });
    } catch {
      stopCapture(false);
      setError("Unable to start audio capture in this browser.");
    }
  }, [flushChunk, stopCapture]);

  useEffect(() => {
    if (enabled && stream) {
      const frameId = window.requestAnimationFrame(() => {
        void startCapture(stream);
      });

      return () => {
        window.cancelAnimationFrame(frameId);
        stopCapture(true);
      };
    }

    stopCapture(false);
    return () => {
      stopCapture(false);
    };
  }, [enabled, startCapture, stopCapture, stream]);

  return { isListening, error };
}
