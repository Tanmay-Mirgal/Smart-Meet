import type { HttpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "../_generated/server";
import {
  CONVEX_API_PREFIX,
  getConnectorConfig,
  getMissingConfig,
  ConnectorConfigError,
  CONNECTOR_VERSION,
} from "./config";
import { isConnectorEnabled } from "./config";
import { ConnectorError, normalizeError } from "./errors";
import { errorResponse, getRequestId, jsonResponse, logLine } from "./httpUtil";
import { buildManifest } from "./manifest";
import { buildOpenApi } from "./openapi";
import { isPublicRoute, matchRoute, pathExistsForOtherMethod } from "./routes";

/** Deployed docs location; override with CONNECTOR_DOCS_URL. */
function docsUrl(appUrl: string) {
  return process.env.CONNECTOR_DOCS_URL?.trim() || `${appUrl}/docs/CONNECTOR.md`;
}

/**
 * Entry point for everything under `/connect/v1/*` on the Convex site origin.
 * The Next.js app rewrites `/api/connect/v1/*` here.
 */
export async function handleConnectorRequest(
  _ctx: ActionCtx,
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

    if (!isPublicRoute(route)) {
      // Authenticated endpoints are wired up in the OAuth phase; until a token
      // can exist, any caller is simply unauthorised.
      throw new ConnectorError("unauthorized", "Missing or invalid access token");
    }

    // Fail fast, with names only, when the connector is enabled but misconfigured.
    if (getMissingConfig().length > 0) {
      throw new ConnectorConfigError(getMissingConfig());
    }
    const config = getConnectorConfig();

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
