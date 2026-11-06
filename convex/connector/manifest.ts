import {
  CONNECTOR_DISPLAY_NAME,
  CONNECTOR_PROTOCOL,
  CONNECTOR_SERVICE,
  CONNECTOR_VERSION,
  LIMITS,
  PUBLIC_API_PREFIX,
} from "./config";
import { ACTIONS, EVENTS, RESOURCES, toJsonSchema } from "./registry";
import { SCOPE_DEFINITIONS } from "./scopes";

export type ManifestOptions = {
  /** Public app origin, no trailing slash. */
  appUrl: string;
  docsUrl?: string;
};

/**
 * Builds the CP1 discovery document from the registry. Every URL advertised is
 * on the app domain (the Next.js rewrite target is an implementation detail).
 */
export function buildManifest({ appUrl, docsUrl }: ManifestOptions) {
  const api = `${appUrl}${PUBLIC_API_PREFIX}`;

  return {
    protocol: CONNECTOR_PROTOCOL,
    service: CONNECTOR_SERVICE,
    displayName: CONNECTOR_DISPLAY_NAME,
    version: CONNECTOR_VERSION,
    baseUrl: appUrl,
    auth: {
      type: "oauth2_code_pkce",
      authorizeUrl: `${appUrl}/connect/authorize`,
      tokenUrl: `${api}/oauth/token`,
      revokeUrl: `${api}/oauth/revoke`,
      scopes: SCOPE_DEFINITIONS.map(({ name, description }) => ({ name, description })),
    },
    tenantKind: "organization",
    actions: ACTIONS.map((action) => ({
      name: action.name,
      description: action.description,
      scopes: [...action.scopes],
      async: action.async,
      idempotent: action.idempotent,
      inputSchema: toJsonSchema(action.input, "input"),
      outputSchema: toJsonSchema(action.output, "output"),
    })),
    resources: RESOURCES.map((resource) => ({
      name: resource.name,
      method: resource.method,
      path: resource.path,
      scopes: [...resource.scopes],
      description: resource.description,
      querySchema: toJsonSchema(resource.query, "input"),
      outputSchema: toJsonSchema(resource.output, "output"),
    })),
    events: EVENTS.map((event) => ({
      type: event.type,
      description: event.description,
      scopes: [...event.scopes],
      dataSchema: toJsonSchema(event.data, "output"),
    })),
    limits: {
      requestsPerMinute: LIMITS.requestsPerMinute,
      maxBodyBytes: LIMITS.maxBodyBytes,
      webhookMaxEndpoints: LIMITS.webhookMaxEndpoints,
    },
    links: {
      docs: docsUrl ?? `${appUrl}/docs/CONNECTOR.md`,
      openapi: `${PUBLIC_API_PREFIX}/openapi.json`,
    },
  };
}

export type Manifest = ReturnType<typeof buildManifest>;
