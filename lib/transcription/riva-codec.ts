/**
 * Minimal protobuf codec for NVIDIA Riva's offline `Recognize` RPC.
 *
 * Only the fields Meetup uses are implemented, with the field numbers from
 * nvidia-riva/common `riva_asr.proto` (package nvidia.riva.asr):
 *
 *   RecognizeRequest        { RecognitionConfig config = 1; bytes audio = 2; }
 *   RecognitionConfig       { AudioEncoding encoding = 1; int32 sample_rate_hertz = 2;
 *                             string language_code = 3; int32 max_alternatives = 4;
 *                             int32 audio_channel_count = 7;
 *                             bool enable_automatic_punctuation = 11; }
 *   RecognizeResponse       { repeated SpeechRecognitionResult results = 1; }
 *   SpeechRecognitionResult { repeated SpeechRecognitionAlternative alternatives = 1; }
 *   SpeechRecognitionAlternative { string transcript = 1; }
 *
 * Keeping this in ~100 lines avoids shipping protobufjs/proto-loader for one RPC.
 */

export const RIVA_RECOGNIZE_PATH = "/nvidia.riva.asr.RivaSpeechRecognition/Recognize";

/** riva_audio.proto `AudioEncoding.LINEAR_PCM`: 16-bit signed little-endian samples. */
const ENCODING_LINEAR_PCM = 1;

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

function encodeVarint(value: number) {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0x7f) {
    bytes.push((remaining % 0x80) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function fieldKey(field: number, wireType: number) {
  return encodeVarint(field * 8 + wireType);
}

function varintField(field: number, value: number) {
  return Buffer.concat([fieldKey(field, WIRE_VARINT), encodeVarint(value)]);
}

function bytesField(field: number, data: Uint8Array) {
  return Buffer.concat([fieldKey(field, WIRE_LENGTH_DELIMITED), encodeVarint(data.length), data]);
}

export interface RecognizeOptions {
  /** 16-bit mono PCM samples, no container header. */
  pcm: Uint8Array;
  sampleRateHertz: number;
  /** BCP-47 code such as "hi-IN" or "en-US"; "multi" asks the model to detect the language. */
  languageCode: string;
}

export function encodeRecognizeRequest({ pcm, sampleRateHertz, languageCode }: RecognizeOptions) {
  const config = Buffer.concat([
    varintField(1, ENCODING_LINEAR_PCM),
    varintField(2, sampleRateHertz),
    bytesField(3, Buffer.from(languageCode, "utf8")),
    varintField(4, 1), // max_alternatives
    varintField(7, 1), // audio_channel_count
    varintField(11, 1), // enable_automatic_punctuation
  ]);

  return Buffer.concat([bytesField(1, config), bytesField(2, pcm)]);
}

interface ProtoField {
  field: number;
  wireType: number;
  /** Raw payload for length-delimited fields; undefined for the others. */
  bytes?: Buffer;
}

function readVarint(buffer: Buffer, start: number): [number, number] {
  let value = 0;
  let multiplier = 1;
  let position = start;
  for (let index = 0; index < 10; index += 1) {
    const byte = buffer[position];
    if (byte === undefined) throw new Error("Truncated protobuf varint");
    position += 1;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return [value, position];
    multiplier *= 0x80;
  }
  throw new Error("Protobuf varint too long");
}

function readFields(buffer: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let position = 0;

  while (position < buffer.length) {
    const [key, afterKey] = readVarint(buffer, position);
    position = afterKey;
    const field = Math.floor(key / 8);
    const wireType = key % 8;

    switch (wireType) {
      case WIRE_VARINT: {
        position = readVarint(buffer, position)[1];
        fields.push({ field, wireType });
        break;
      }
      case WIRE_FIXED64:
        position += 8;
        fields.push({ field, wireType });
        break;
      case WIRE_LENGTH_DELIMITED: {
        const [length, afterLength] = readVarint(buffer, position);
        const end = afterLength + length;
        if (end > buffer.length) throw new Error("Truncated protobuf field");
        fields.push({ field, wireType, bytes: buffer.subarray(afterLength, end) });
        position = end;
        break;
      }
      case WIRE_FIXED32:
        position += 4;
        fields.push({ field, wireType });
        break;
      default:
        throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }
  }

  return fields;
}

/** Joins the top alternative of every result in a RecognizeResponse. */
export function decodeRecognizeResponse(buffer: Buffer) {
  const transcripts: string[] = [];

  for (const result of readFields(buffer)) {
    if (result.field !== 1 || !result.bytes) continue;

    const alternative = readFields(result.bytes).find((entry) => entry.field === 1 && entry.bytes);
    if (!alternative?.bytes) continue;

    const transcript = readFields(alternative.bytes).find((entry) => entry.field === 1 && entry.bytes);
    const text = transcript?.bytes?.toString("utf8").trim();
    if (text) transcripts.push(text);
  }

  return transcripts.join(" ").replace(/\s+/g, " ").trim();
}

export interface WavPcm {
  pcm: Buffer;
  sampleRateHertz: number;
}

/** Extracts the PCM payload from a 16-bit mono WAV file, or null if it is anything else. */
export function readPcmWav(wav: Buffer): WavPcm | null {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let position = 12;
  let sampleRateHertz = 0;
  let isPcm16Mono = false;

  while (position + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", position, position + 4);
    const chunkSize = wav.readUInt32LE(position + 4);
    const bodyStart = position + 8;

    if (chunkId === "fmt " && bodyStart + 16 <= wav.length) {
      const format = wav.readUInt16LE(bodyStart);
      const channels = wav.readUInt16LE(bodyStart + 2);
      sampleRateHertz = wav.readUInt32LE(bodyStart + 4);
      const bitsPerSample = wav.readUInt16LE(bodyStart + 14);
      isPcm16Mono = format === 1 && channels === 1 && bitsPerSample === 16;
    } else if (chunkId === "data") {
      if (!isPcm16Mono || sampleRateHertz <= 0) return null;
      const end = Math.min(bodyStart + chunkSize, wav.length);
      return { pcm: wav.subarray(bodyStart, end), sampleRateHertz };
    }

    position = bodyStart + chunkSize + (chunkSize % 2);
  }

  return null;
}
