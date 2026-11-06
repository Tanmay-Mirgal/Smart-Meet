import type { z } from "zod";
import { LIMITS } from "./config";
import { ConnectorError, validationFailed } from "./errors";
import { readBodyWithLimit } from "./httpUtil";
import { stripUnknownFields, toJsonSchema } from "./registry";

const jsonSchemaCache = new WeakMap<z.ZodType, Record<string, unknown>>();

function inputJsonSchema(schema: z.ZodType) {
  let cached = jsonSchemaCache.get(schema);
  if (!cached) {
    cached = toJsonSchema(schema, "input");
    jsonSchemaCache.set(schema, cached);
  }
  return cached;
}

/**
 * CP1 §3 forward compatibility: unknown request fields are rejected (the zod
 * schemas are strict) unless the caller sends `Prefer: unknown-fields=ignore`,
 * in which case they are dropped before validation.
 */
export function wantsIgnoreUnknown(request: Request): boolean {
  return /(^|[,;\s])unknown-fields\s*=\s*ignore\b/i.test(request.headers.get("prefer") ?? "");
}

/** Validates `raw` against a registry schema, mapping failures to CP1 `validation_failed`. */
export function parseInput<T extends z.ZodType>(
  schema: T,
  raw: unknown,
  ignoreUnknown: boolean,
): z.output<T> {
  const candidate = ignoreUnknown ? stripUnknownFields(inputJsonSchema(schema), raw) : raw;
  const result = schema.safeParse(candidate);
  if (!result.success) {
    throw validationFailed(
      "Request validation failed",
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/** `Idempotency-Key` header: absent, or 1–128 characters (CP1 §3). */
export function readIdempotencyKey(request: Request): string | undefined {
  const key = request.headers.get("idempotency-key") ?? undefined;
  if (key !== undefined && (key.length === 0 || key.length > 128)) {
    throw validationFailed("Idempotency-Key must be between 1 and 128 characters", [
      { path: "Idempotency-Key", message: "Must be between 1 and 128 characters" },
    ]);
  }
  return key;
}

/** Reads a JSON request body, enforcing the 1 MiB limit (413) and well-formedness (400). */
export async function readJsonBody(request: Request): Promise<unknown> {
  const body = await readBodyWithLimit(request, LIMITS.maxBodyBytes);
  if (!body.ok) {
    throw new ConnectorError("validation_failed", "Request body too large", { status: 413 });
  }
  try {
    return JSON.parse(body.text);
  } catch {
    throw validationFailed("Request body must be valid JSON");
  }
}
