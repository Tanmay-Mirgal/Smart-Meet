/**
 * Web Crypto helpers for the connector. Everything here runs in the default
 * Convex runtime (no Node built-ins) and in Node >= 20 for unit tests.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// TS 5.7+ distinguishes Uint8Array<ArrayBufferLike> from BufferSource.
const asBuffer = (bytes: Uint8Array) => bytes as unknown as BufferSource;

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error("Invalid hex string");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Opaque token: `<prefix><32 random bytes, base64url>` (CP1 §2.2). */
export function generateToken(prefix: string, byteLength = 32): string {
  return `${prefix}${bytesToBase64Url(randomBytes(byteLength))}`;
}

export function generateWebhookSecret(): string {
  return generateToken("whsec_", 32);
}

export async function hmacSha256Hex(
  key: string | Uint8Array,
  message: string,
): Promise<string> {
  const keyBytes = typeof key === "string" ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    asBuffer(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    asBuffer(encoder.encode(message)),
  );
  return bytesToHex(new Uint8Array(signature));
}

function getPepper(): string {
  const pepper = process.env.CONNECTOR_TOKEN_PEPPER?.trim();
  if (!pepper || pepper.length < 32) {
    throw new Error("CONNECTOR_TOKEN_PEPPER is not configured");
  }
  return pepper;
}

/**
 * Tokens, codes and refresh tokens are only ever stored as
 * HMAC-SHA256(CONNECTOR_TOKEN_PEPPER, secret) — never the secret itself.
 */
export async function hashSecret(secret: string): Promise<string> {
  return await hmacSha256Hex(getPepper(), secret);
}

export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    asBuffer(encoder.encode(input)),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    asBuffer(encoder.encode(input)),
  );
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Constant-time string comparison. Time depends only on the longer input's
 * length, never on where the first mismatch is.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/** PKCE S256: BASE64URL(SHA256(verifier)) must equal the stored challenge. */
export async function verifyPkceS256(
  verifier: string,
  challenge: string,
): Promise<boolean> {
  // RFC 7636 §4.1: 43–128 chars from the unreserved set.
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) {
    return false;
  }
  return timingSafeEqualStrings(await sha256Base64Url(verifier), challenge);
}

// ── Webhook signing (CP1 §5) ────────────────────────────────────────────────

export async function signWebhookPayload(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): Promise<string> {
  return `v1=${await hmacSha256Hex(secret, `${timestampSeconds}.${rawBody}`)}`;
}

// ── AES-256-GCM secret encryption (versioned) ───────────────────────────────
//
// Format: `enc:<kid>:<iv base64url>:<ciphertext+tag base64url>`
// Key ring: CONNECTOR_ENCRYPTION_KEY is kid "v1"; CONNECTOR_ENCRYPTION_KEY_V2..V9
// add newer keys. New data is encrypted with the highest configured kid; any
// kid still configured can decrypt, so keys can be rotated without downtime.

const KEY_ENV_BY_KID: Record<string, string> = {
  v1: "CONNECTOR_ENCRYPTION_KEY",
  v2: "CONNECTOR_ENCRYPTION_KEY_V2",
  v3: "CONNECTOR_ENCRYPTION_KEY_V3",
  v4: "CONNECTOR_ENCRYPTION_KEY_V4",
  v5: "CONNECTOR_ENCRYPTION_KEY_V5",
  v6: "CONNECTOR_ENCRYPTION_KEY_V6",
  v7: "CONNECTOR_ENCRYPTION_KEY_V7",
  v8: "CONNECTOR_ENCRYPTION_KEY_V8",
  v9: "CONNECTOR_ENCRYPTION_KEY_V9",
};

function readKeyHex(kid: string): string | null {
  const envName = KEY_ENV_BY_KID[kid];
  const value = envName ? process.env[envName]?.trim() : undefined;
  if (!value) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${envName} must be 64 hex characters (256 bits)`);
  }
  return value;
}

function currentKid(): string {
  const kids = Object.keys(KEY_ENV_BY_KID);
  for (let i = kids.length - 1; i >= 0; i -= 1) {
    if (readKeyHex(kids[i])) return kids[i];
  }
  throw new Error("CONNECTOR_ENCRYPTION_KEY is not configured");
}

async function importAesKey(kid: string, usage: KeyUsage) {
  const hex = readKeyHex(kid);
  if (!hex) {
    throw new Error(`No encryption key configured for key id "${kid}"`);
  }
  return await crypto.subtle.importKey(
    "raw",
    asBuffer(hexToBytes(hex)),
    { name: "AES-GCM" },
    false,
    [usage],
  );
}

export async function encryptSecret(plaintext: string): Promise<string> {
  const kid = currentKid();
  const iv = randomBytes(12);
  const key = await importAesKey(kid, "encrypt");
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asBuffer(iv) },
    key,
    asBuffer(encoder.encode(plaintext)),
  );
  return `enc:${kid}:${bytesToBase64Url(iv)}:${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(blob: string): Promise<string> {
  const [scheme, kid, ivPart, ciphertextPart] = blob.split(":");
  if (scheme !== "enc" || !kid || !ivPart || !ciphertextPart) {
    throw new Error("Unrecognised encrypted value");
  }
  const key = await importAesKey(kid, "decrypt");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asBuffer(base64UrlToBytes(ivPart)) },
    key,
    asBuffer(base64UrlToBytes(ciphertextPart)),
  );
  return decoder.decode(plaintext);
}
