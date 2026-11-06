import type { HttpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  CONVEX_API_PREFIX,
  CONNECTOR_VERSION,
  ConnectorConfigError,
  LIMITS,
  getConnectorConfig,
  getMissingConfig,
  isConnectorEnabled,
  type ConnectorConfig,
} from "./config";
import { timingSafeEqualStrings } from "./crypto";
import { ConnectorError, normalizeError, type ConnectorErrorCode } from "./errors";
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  jsonTextResponse,
  logLine,
  readBodyWithLimit,
} from "./httpUtil";
import { runAction } from "./actionRunner";
import { buildManifest } from "./manifest";
import { verifyMediaSignature } from "./mediaUrl";
import { buildOpenApi } from "./openapi";
import { rateLimitHeaders } from "./rateLimit";
import { runResource } from "./resources";
import { runWebhookRoute } from "./webhookRunner";
import {
  isPublicRoute,
  matchRoute,
  pathExistsForOtherMethod,
  requiredScopesFor,
  type Route,
} from "./routes";

/** Deployed docs location; override with CONNECTOR_DOCS_URL. */
function docsUrl(appUrl: string) {
  return process.env.CONNECTOR_DOCS_URL?.trim() || `${appUrl}/docs/CONNECTOR.md`;
}

// ── OAuth endpoints (RFC 6749 error format, CP1 §2.2/§2.3) ───────────────────

const OAUTH_HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache" };

function oauthError(
  status: number,
  error: string,
  description: string,
  requestId: string,
  extraHeaders: Record<string, string> = {},
) {
  return jsonResponse(
    status,
    { error, error_description: description, request_id: requestId },
    requestId,
    { ...OAUTH_HEADERS, ...extraHeaders },
  );
}

type OAuthParams = Record<string, string>;

async function parseOAuthBody(
  request: Request,
): Promise<{ ok: true; params: OAuthParams } | { ok: false; tooLarge: boolean }> {
  const body = await readBodyWithLimit(request, LIMITS.maxBodyBytes);
  if (!body.ok) return { ok: false, tooLarge: true };

  const params: OAuthParams = {};
  try {
    if ((request.headers.get("content-type") ?? "").includes("application/json")) {
      const json = JSON.parse(body.text || "{}") as Record<string, unknown>;
      if (json === null || typeof json !== "object" || Array.isArray(json)) {
        return { ok: false, tooLarge: false };
      }
      for (const [key, value] of Object.entries(json)) {
        if (typeof value === "string") params[key] = value;
      }
    } else {
      for (const [key, value] of new URLSearchParams(body.text)) params[key] = value;
    }
  } catch {
    return { ok: false, tooLarge: false };
  }
  return { ok: true, params };
}

/** Client authentication via HTTP Basic or body parameters (RFC 6749 §2.3.1). */
function checkClientAuth(
  request: Request,
  params: OAuthParams,
  config: ConnectorConfig,
): "valid" | "invalid" | "absent" {
  let id: string | undefined;
  let secret: string | undefined;

  const header = request.headers.get("authorization");
  if (header && /^basic\s/i.test(header)) {
    try {
      const decoded = atob(header.replace(/^basic\s+/i, "").trim());
      const separator = decoded.indexOf(":");
      if (separator < 0) return "invalid";
      id = decodeURIComponent(decoded.slice(0, separator));
      secret = decodeURIComponent(decoded.slice(separator + 1));
    } catch {
      return "invalid";
    }
  } else if (params.client_id !== undefined || params.client_secret !== undefined) {
    id = params.client_id;
    secret = params.client_secret;
  } else {
    return "absent";
  }

  // Evaluate both comparisons so timing never reveals which one failed.
  const idOk = timingSafeEqualStrings(id ?? "", config.clientId);
  const secretOk = timingSafeEqualStrings(secret ?? "", config.clientSecret);
  return idOk && secretOk ? "valid" : "invalid";
}

async function handleToken(
  ctx: ActionCtx,
  request: Request,
  requestId: string,
  config: ConnectorConfig,
): Promise<Response> {
  const parsed = await parseOAuthBody(request);
  if (!parsed.ok) {
    return parsed.tooLarge
      ? errorResponse(
          new ConnectorError("validation_failed", "Request body too large", { status: 413 }),
          requestId,
        )
      : oauthError(400, "invalid_request", "The request body could not be parsed.", requestId);
  }

  const { params } = parsed;
  if (checkClientAuth(request, params, config) !== "valid") {
    return oauthError(401, "invalid_client", "Client authentication failed.", requestId, {
      "WWW-Authenticate": 'Basic realm="meetup-connector"',
    });
  }

  const now = Date.now();
  let result;
  if (params.grant_type === "authorization_code") {
    if (!params.code || !params.redirect_uri || !params.code_verifier) {
      return oauthError(
        400,
        "invalid_request",
        "code, redirect_uri and code_verifier are required.",
        requestId,
      );
    }
    result = await ctx.runMutation(internal.connector.oauth.exchangeCode, {
      clientId: config.clientId,
      code: params.code,
      redirectUri: params.redirect_uri,
      codeVerifier: params.code_verifier,
      now,
    });
  } else if (params.grant_type === "refresh_token") {
    if (!params.refresh_token) {
      return oauthError(400, "invalid_request", "refresh_token is required.", requestId);
    }
    result = await ctx.runMutation(internal.connector.oauth.refresh, {
      clientId: config.clientId,
      refreshToken: params.refresh_token,
      scope: params.scope || undefined,
      now,
    });
  } else {
    return oauthError(
      400,
      "unsupported_grant_type",
      "grant_type must be authorization_code or refresh_token.",
      requestId,
    );
  }

  if (!result.ok) {
    return oauthError(400, result.error, result.description, requestId);
  }

  return jsonResponse(
    200,
    {
      token_type: "Bearer",
      access_token: result.access_token,
      expires_in: result.expires_in,
      refresh_token: result.refresh_token,
      scope: result.scope,
      tenant: result.tenant,
      user: result.user,
    },
    requestId,
    OAUTH_HEADERS,
  );
}

async function handleRevoke(
  ctx: ActionCtx,
  request: Request,
  requestId: string,
  config: ConnectorConfig,
): Promise<Response> {
  // RFC 7009 / CP1 §2.3: always 200, so the endpoint cannot be used to probe tokens.
  const done = () => jsonResponse(200, {}, requestId, OAUTH_HEADERS);

  const parsed = await parseOAuthBody(request);
  if (!parsed.ok || !parsed.params.token) return done();

  const auth = checkClientAuth(request, parsed.params, config);
  if (auth === "invalid") return done();

  await ctx.runMutation(internal.connector.oauth.revokeToken, {
    token: parsed.params.token,
    clientId: auth === "valid" ? config.clientId : undefined,
    now: Date.now(),
  });
  return done();
}

// ── authenticated endpoints ──────────────────────────────────────────────────

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match ? match[1] : null;
}

function auditName(route: Route): string {
  if (route.kind === "action") return route.params.name;
  if (route.kind === "resource") return route.name;
  return route.kind;
}

async function handleAuthenticated(
  ctx: ActionCtx,
  request: Request,
  route: Route,
  requestId: string,
): Promise<Response> {
  const token = bearerToken(request);
  if (!token) {
    throw new ConnectorError("unauthorized", "Missing or invalid access token");
  }

  const now = Date.now();
  const gate = await ctx.runMutation(internal.connector.gate.authorize, {
    token,
    requiredScopes: requiredScopesFor(route),
    now,
  });

  const audit = async (status: number, errorCode?: string) => {
    const grant = gate.ok ? gate : gate.grant;
    if (!grant) return;
    try {
      await ctx.runMutation(internal.connector.gate.recordAudit, {
        grantId: grant.grantId,
        action: auditName(route),
        method: request.method,
        status,
        requestId,
        errorCode,
        now: Date.now(),
      });
    } catch (error) {
      // Auditing must never turn a finished request into a failure.
      console.error("connector audit write failed", error);
    }
  };

  if (!gate.ok) {
    const headers = gate.rate
      ? rateLimitHeaders({ ...gate.rate, allowed: false })
      : {};
    await audit(gate.status, gate.code);
    return errorResponse(
      new ConnectorError(gate.code as ConnectorErrorCode, gate.message, {
        status: gate.status,
        extras: {
          ...(gate.requiredScope ? { requiredScope: gate.requiredScope } : {}),
          ...(gate.rate && gate.status === 429
            ? { retryAfterSeconds: gate.rate.retryAfterSeconds }
            : {}),
        },
      }),
      requestId,
      headers,
    );
  }

  const headers = rateLimitHeaders({ ...gate.rate, allowed: true });
  try {
    let response: Response;
    switch (route.kind) {
      case "me":
        response = jsonResponse(
          200,
          await ctx.runQuery(internal.connector.exec.me, { grantId: gate.grantId, now }),
          requestId,
          headers,
        );
        break;
      case "resource":
        response = jsonResponse(
          200,
          await runResource(ctx, route, request, gate.grantId, now),
          requestId,
          headers,
        );
        break;
      case "action": {
        const outcome = await runAction(ctx, route, request, gate.grantId, now);
        response = jsonTextResponse(outcome.status, outcome.response, requestId, {
          ...headers,
          ...(outcome.replayed ? { "Idempotent-Replay": "true" } : {}),
        });
        break;
      }
      case "operation":
        response = jsonResponse(
          200,
          await ctx.runQuery(internal.connector.exec.operationGet, {
            grantId: gate.grantId,
            now,
            id: route.params.id,
          }),
          requestId,
          headers,
        );
        break;
      case "webhooks.create":
      case "webhooks.list":
      case "webhooks.get":
      case "webhooks.update":
      case "webhooks.delete":
      case "webhooks.deliveries":
      case "webhooks.redeliver":
      case "events": {
        const outcome = await runWebhookRoute(ctx, route, request, gate.grantId, now);
        const extra = { ...headers, ...(outcome.replayed ? { "Idempotent-Replay": "true" } : {}) };
        response =
          outcome.text !== undefined
            ? jsonTextResponse(outcome.status, outcome.text, requestId, extra)
            : jsonResponse(outcome.status, outcome.body, requestId, extra);
        break;
      }
      default:
        throw new ConnectorError("not_found", "Unknown endpoint");
    }
    await audit(response.status);
    return response;
  } catch (error) {
    const normalized = normalizeError(error);
    if (normalized.status >= 500) {
      logLine(requestId, "error", { code: normalized.code, route: auditName(route) });
      console.error(error);
    }
    await audit(normalized.status, normalized.code);
    return errorResponse(normalized, requestId, headers);
  }
}

/**
 * `GET /recordings/{id}/media?g&exp&sig` — the target of the short-lived signed
 * playback links. Authenticated by the HMAC signature alone (it is opened by a
 * player, not an API client), but the live grant, tenant and meeting access are
 * re-checked, so revoking the connection kills outstanding links immediately.
 */
async function handleMedia(
  ctx: ActionCtx,
  request: Request,
  recordingId: string,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const now = Date.now();
  const verified = await verifyMediaSignature(
    recordingId,
    {
      g: url.searchParams.get("g"),
      exp: url.searchParams.get("exp"),
      sig: url.searchParams.get("sig"),
    },
    now,
  );
  if (!verified.ok) {
    throw new ConnectorError("unauthorized", "This link is invalid or has expired");
  }

  const grantId = verified.grantId as Id<"connector_grants">;
  const target = await ctx.runQuery(internal.connector.exec.mediaTarget, {
    grantId,
    now,
    recordingId,
  });

  try {
    await ctx.runMutation(internal.connector.gate.recordAudit, {
      grantId,
      action: "recordings.media",
      method: "GET",
      status: 302,
      requestId,
      now: Date.now(),
    });
  } catch (error) {
    console.error("connector audit write failed", error);
  }

  return new Response(null, {
    status: 302,
    headers: { Location: target, "Cache-Control": "no-store", "X-Request-Id": requestId },
  });
}

// ── entry point ──────────────────────────────────────────────────────────────

/**
 * Entry point for everything under `/connect/v1/*` on the Convex site origin.
 * The Next.js app rewrites `/api/connect/v1/*` here.
 */
export async function handleConnectorRequest(
  ctx: ActionCtx,
  request: Request,
): Promise<Response> {
  const requestId = getRequestId(request);

  // C22 — flag off ⇒ every connect route is a plain 404.
  if (!isConnectorEnabled()) {
    return jsonResponse(
      404,
      { error: { code: "not_found", message: "Not found", retryable: false, requestId } },
      requestId,
    );
  }

  try {
    const url = new URL(request.url);
    const path = url.pathname.startsWith(CONVEX_API_PREFIX)
      ? url.pathname.slice(CONVEX_API_PREFIX.length) || "/"
      : url.pathname;

    const route = matchRoute(request.method, path);
    if (!route) {
      if (pathExistsForOtherMethod(request.method, path)) {
        return errorResponse(
          new ConnectorError("validation_failed", "Method not allowed", { status: 405 }),
          requestId,
          { Allow: "GET, POST, PATCH, DELETE" },
        );
      }
      throw new ConnectorError("not_found", "Unknown endpoint");
    }

    // Fail fast, with names only, when the connector is enabled but misconfigured.
    const missing = getMissingConfig();
    if (missing.length > 0) {
      throw new ConnectorConfigError(missing);
    }
    const config = getConnectorConfig();

    if (!isPublicRoute(route)) {
      return await handleAuthenticated(ctx, request, route, requestId);
    }

    switch (route.kind) {
      case "health":
        return jsonResponse(
          200,
          { status: "ok", version: CONNECTOR_VERSION, time: new Date().toISOString() },
          requestId,
        );
      case "manifest":
        return jsonResponse(
          200,
          buildManifest({ appUrl: config.appUrl, docsUrl: docsUrl(config.appUrl) }),
          requestId,
          { "Cache-Control": "public, max-age=300" },
        );
      case "openapi":
        return jsonResponse(200, buildOpenApi({ appUrl: config.appUrl }), requestId, {
          "Cache-Control": "public, max-age=300",
        });
      case "oauth.token":
        return await handleToken(ctx, request, requestId, config);
      case "oauth.revoke":
        return await handleRevoke(ctx, request, requestId, config);
      case "recording.media":
        return await handleMedia(ctx, request, route.params.id, requestId);
      default:
        throw new ConnectorError("not_found", "Unknown endpoint");
    }
  } catch (error) {
    if (error instanceof ConnectorConfigError) {
      logLine(requestId, "misconfigured", { missing: error.missing });
      return errorResponse(
        new ConnectorError("internal", error.message, { status: 500 }),
        requestId,
      );
    }
    const normalized = normalizeError(error);
    if (normalized.status >= 500) {
      logLine(requestId, "error", { code: normalized.code });
      console.error(error);
    }
    return errorResponse(normalized, requestId);
  }
}

export const connectorHttpAction = httpAction(handleConnectorRequest);

export function registerConnectorRoutes(http: HttpRouter) {
  for (const method of ["GET", "POST", "PATCH", "DELETE"] as const) {
    http.route({
      pathPrefix: `${CONVEX_API_PREFIX}/`,
      method,
      handler: connectorHttpAction,
    });
  }
}
