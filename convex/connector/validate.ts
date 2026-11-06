import type { z } from "zod";
import { validationFailed } from "./errors";
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
