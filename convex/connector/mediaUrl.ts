import { PUBLIC_API_PREFIX, TTL, webUrl } from "./config";
import { hmacSha256Hex, timingSafeEqualStrings } from "./crypto";

/**
 * Short-lived signed playback links (CP1 §4.6). A recording is never exposed
 * by a permanent URL: the link names the recording AND the grant, expires in
 * 10 minutes, and is re-checked against the live grant when used, so revoking
 * a connection kills outstanding links immediately.
 *
 * The signing key is derived from CONNECTOR_TOKEN_PEPPER with a distinct
 * label, so a media signature can never be confused with a token hash.
 */

async function sign(recordingId: string, grantId: string, expiresAt: number): Promise<string> {
  const pepper = process.env.CONNECTOR_TOKEN_PEPPER?.trim();
  if (!pepper) throw new Error("CONNECTOR_TOKEN_PEPPER is not configured");
  return await hmacSha256Hex(pepper, `media-url:v1:${recordingId}.${grantId}.${expiresAt}`);
}

export async function buildMediaUrl(recordingId: string, grantId: string, now: number) {
  const expiresAt = now + TTL.recordingUrlMs;
  const signature = await sign(recordingId, grantId, expiresAt);
  const query = new URLSearchParams({ g: grantId, exp: String(expiresAt), sig: signature });
  return {
    url: webUrl(`${PUBLIC_API_PREFIX}/recordings/${recordingId}/media?${query.toString()}`),
    expiresAt,
  };
}

export async function verifyMediaSignature(
  recordingId: string,
  params: { g: string | null; exp: string | null; sig: string | null },
  now: number,
): Promise<{ ok: true; grantId: string } | { ok: false }> {
  const expiresAt = Number(params.exp);
  if (!params.g || !params.sig || !Number.isFinite(expiresAt) || expiresAt <= now) {
    return { ok: false };
  }
  const expected = await sign(recordingId, params.g, expiresAt);
  return timingSafeEqualStrings(expected, params.sig)
    ? { ok: true, grantId: params.g }
    : { ok: false };
}
