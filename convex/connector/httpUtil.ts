import {
  buildErrorBody,
  ConnectorError,
  type ConnectorErrorCode,
} from "./errors";

const BASE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  // Server-to-server API: never cached by intermediaries, never given CORS headers.
  "Cache-Control": "no-store",
} as const;

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export function getRequestId(request: Request): string {
  const supplied = request.headers.get("x-request-id")?.trim();
  if (supplied && REQUEST_ID_RE.test(supplied)) {
    return supplied;
  }
  return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function jsonResponse(
  status: number,
  body: unknown,
  requestId: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      ...BASE_HEADERS,
      "X-Request-Id": requestId,
      ...headers,
    },
  });
}

export function errorResponse(
  error: ConnectorError,
  requestId: string,
  headers: Record<string, string> = {},
): Response {
  const extra: Record<string, string> = { ...headers };
  if (error.extras?.retryAfterSeconds !== undefined) {
    extra["Retry-After"] = String(error.extras.retryAfterSeconds);
  }
  return jsonResponse(error.status, buildErrorBody(error, requestId), requestId, extra);
}

export function simpleError(
  code: ConnectorErrorCode,
  message: string,
  requestId: string,
) {
  return errorResponse(new ConnectorError(code, message), requestId);
}

/** Structured, token-free log line (CP1 §3: request id in every log line). */
export function logLine(
  requestId: string,
  event: string,
  fields: Record<string, unknown> = {},
) {
  console.log(JSON.stringify({ svc: "connector", requestId, event, ...fields }));
}

/** Stable JSON (sorted keys) so equal bodies hash equally for idempotency. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

/** Reads a body with a hard byte limit, without trusting Content-Length alone. */
export async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false };
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    return { ok: false };
  }
  return { ok: true, text: new TextDecoder().decode(buffer) };
}
