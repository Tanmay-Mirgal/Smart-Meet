import { ConvexError } from "convex/values";
import {
  InputError,
  PlanLimitError,
  PreconditionError,
} from "../lib/errors";

export type ConnectorErrorCode =
  | "unauthorized"
  | "insufficient_scope"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "idempotency_conflict"
  | "plan_limit"
  | "precondition_failed"
  | "rate_limited"
  | "upstream_failed"
  | "unavailable"
  | "internal";

export const DEFAULT_STATUS: Record<ConnectorErrorCode, number> = {
  unauthorized: 401,
  insufficient_scope: 403,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  conflict: 409,
  idempotency_conflict: 422,
  plan_limit: 402,
  precondition_failed: 412,
  rate_limited: 429,
  upstream_failed: 502,
  unavailable: 503,
  internal: 500,
};

export type ErrorDetail = { path: string; message: string };

/** Extra, code-specific fields merged into the error object (CP1 §3). */
export type ErrorExtras = {
  requiredScope?: string;
  limit?: number | null;
  feature?: string;
  resetsAt?: string;
  fixUrl?: string;
  retryAfterSeconds?: number;
};

export type ConnectorErrorData = {
  cp1: true;
  code: ConnectorErrorCode;
  status: number;
  message: string;
  details?: ErrorDetail[];
  extras?: ErrorExtras;
};

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly status: number;
  readonly details?: ErrorDetail[];
  readonly extras?: ErrorExtras;

  constructor(
    code: ConnectorErrorCode,
    message: string,
    options: {
      status?: number;
      details?: ErrorDetail[];
      extras?: ErrorExtras;
    } = {},
  ) {
    super(message);
    this.code = code;
    this.status = options.status ?? DEFAULT_STATUS[code];
    this.details = options.details;
    this.extras = options.extras;
  }
}

export const notFound = (message = "Resource not found") =>
  new ConnectorError("not_found", message);

export const forbidden = (message = "You do not have permission to do this") =>
  new ConnectorError("forbidden", message);

export const validationFailed = (message: string, details?: ErrorDetail[]) =>
  new ConnectorError("validation_failed", message, { details });

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status >= 500;
}

/** Serialises to a ConvexError so a rolled-back mutation can still carry a typed error. */
export function toConvexError(error: ConnectorError): ConvexError<ConnectorErrorData> {
  const data: ConnectorErrorData = {
    cp1: true,
    code: error.code,
    status: error.status,
    message: error.message,
  };
  if (error.details) data.details = error.details;
  if (error.extras) {
    // ConvexError payloads must not contain `undefined`.
    data.extras = JSON.parse(JSON.stringify(error.extras)) as ErrorExtras;
  }
  return new ConvexError(data);
}

function isConnectorErrorData(value: unknown): value is ConnectorErrorData {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { cp1?: unknown }).cp1 === true &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

const MESSAGE_RULES: Array<{
  test: (message: string) => boolean;
  build: (message: string) => ConnectorError;
}> = [
  {
    test: (m) => m === "Unauthenticated",
    build: () => new ConnectorError("unauthorized", "Unauthenticated"),
  },
  {
    test: (m) => m === "Forbidden",
    build: () =>
      forbidden(
        "The connected user does not have access to this resource in Meetup.",
      ),
  },
  {
    test: (m) => m === "Only the host can perform this action",
    build: () =>
      forbidden(
        "Only the meeting host can do this, and the connected user is not the host of this meeting. Meetup does not allow connectors to bypass host-only rules.",
      ),
  },
  {
    test: (m) => /^You do not have permission/.test(m),
    build: (m) => forbidden(m),
  },
  {
    test: (m) => /not found$/i.test(m) || /is unavailable$/i.test(m),
    build: (m) => notFound(m),
  },
  {
    test: (m) => m === "Assignee must belong to this workspace",
    build: (m) => validationFailed(m, [{ path: "assigneeEmail", message: m }]),
  },
];

/**
 * Maps anything thrown by a core function (typed errors, legacy `Error`
 * messages, ConvexErrors from nested calls) onto a ConnectorError.
 */
export function normalizeError(error: unknown): ConnectorError {
  if (error instanceof ConnectorError) return error;

  if (error instanceof ConvexError && isConnectorErrorData(error.data)) {
    const data = error.data;
    return new ConnectorError(data.code, data.message, {
      status: data.status,
      details: data.details,
      extras: data.extras,
    });
  }

  if (error instanceof PlanLimitError) {
    return new ConnectorError("plan_limit", error.message, {
      extras: {
        limit: error.details.limit ?? null,
        feature: error.details.feature,
      },
    });
  }

  if (error instanceof PreconditionError) {
    return new ConnectorError("precondition_failed", error.message, {
      extras: error.fixPath ? { fixUrl: error.fixPath } : undefined,
    });
  }

  if (error instanceof InputError) {
    return validationFailed(
      error.message,
      error.path ? [{ path: error.path, message: error.message }] : undefined,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  for (const rule of MESSAGE_RULES) {
    if (rule.test(message)) return rule.build(message);
  }

  return new ConnectorError("internal", "Internal error");
}

export function buildErrorBody(error: ConnectorError, requestId: string) {
  const body: Record<string, unknown> = {
    code: error.code,
    message: error.message,
    retryable: isRetryableStatus(error.status),
    requestId,
  };
  if (error.details) body.details = error.details;
  if (error.extras) {
    for (const [key, value] of Object.entries(error.extras)) {
      if (key === "retryAfterSeconds") continue;
      if (value !== undefined) body[key] = value;
    }
  }
  return { error: body };
}
