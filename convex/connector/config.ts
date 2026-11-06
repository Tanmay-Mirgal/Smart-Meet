import { getPublicAppUrl } from "../../lib/public-app-url";

export const CONNECTOR_SERVICE = "meetup" as const;
export const CONNECTOR_PROTOCOL = "cp1" as const;
export const CONNECTOR_VERSION = "1.0.0";
export const CONNECTOR_DISPLAY_NAME = "Meetup";

/** Public (app-domain) prefix; Next.js rewrites it to CONVEX_PREFIX. */
export const PUBLIC_API_PREFIX = "/api/connect/v1";
/** Prefix on the `.convex.site` origin where the httpActions live. */
export const CONVEX_API_PREFIX = "/connect/v1";

export const LIMITS = {
  requestsPerMinute: 120,
  maxBodyBytes: 1_048_576,
  webhookMaxEndpoints: 5,
  /** notifications.create is additionally capped per grant (CP1 §4.5). */
  notificationsPerMinute: 60,
} as const;

export const TTL = {
  codeMs: 60_000,
  accessMs: 60 * 60 * 1000,
  refreshMs: 90 * 24 * 60 * 60 * 1000,
  idempotencyMs: 24 * 60 * 60 * 1000,
  lastUsedWriteIntervalMs: 5 * 60 * 1000,
  recordingUrlMs: 10 * 60 * 1000,
} as const;

export function isConnectorEnabled(): boolean {
  return process.env.CONNECTOR_ENABLED === "true";
}

/**
 * Local-development relaxations: `http://localhost` redirect URIs and
 * loopback / plain-http webhook targets. Never set this in production.
 */
export function isConnectorDevMode(): boolean {
  return process.env.CONNECTOR_DEV_MODE === "true";
}

const REQUIRED_ENV = [
  "CONNECTOR_HUB_NAME",
  "CONNECTOR_HUB_CLIENT_ID",
  "CONNECTOR_HUB_CLIENT_SECRET",
  "CONNECTOR_HUB_REDIRECT_URIS",
  "CONNECTOR_TOKEN_PEPPER",
  "CONNECTOR_ENCRYPTION_KEY",
] as const;

/** Names (never values) of required settings that are missing or malformed. */
export function getMissingConfig(): string[] {
  const missing: string[] = REQUIRED_ENV.filter(
    (name) => !process.env[name]?.trim(),
  );

  const pepper = process.env.CONNECTOR_TOKEN_PEPPER?.trim();
  if (pepper && pepper.length < 32) {
    missing.push("CONNECTOR_TOKEN_PEPPER (must be at least 32 characters)");
  }

  const key = process.env.CONNECTOR_ENCRYPTION_KEY?.trim();
  if (key && !/^[0-9a-fA-F]{64}$/.test(key)) {
    missing.push("CONNECTOR_ENCRYPTION_KEY (must be 64 hex characters)");
  }

  if (!process.env.APP_BASE_URL?.trim() && !process.env.NEXT_PUBLIC_APP_URL?.trim()) {
    missing.push("NEXT_PUBLIC_APP_URL (or APP_BASE_URL)");
  }

  return missing;
}

export class ConnectorConfigError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`Connector is misconfigured. Fix: ${missing.join(", ")}`);
    this.missing = missing;
  }
}

export type ConnectorConfig = {
  hubName: string;
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  /** Public origin of the app, e.g. https://meetup.example.com (no trailing slash). */
  appUrl: string;
};

export function getConnectorConfig(): ConnectorConfig {
  const missing = getMissingConfig();
  if (missing.length > 0) {
    throw new ConnectorConfigError(missing);
  }

  return {
    hubName: process.env.CONNECTOR_HUB_NAME!.trim(),
    clientId: process.env.CONNECTOR_HUB_CLIENT_ID!.trim(),
    clientSecret: process.env.CONNECTOR_HUB_CLIENT_SECRET!,
    redirectUris: parseRedirectUris(process.env.CONNECTOR_HUB_REDIRECT_URIS!),
    appUrl: getPublicAppUrl(),
  };
}

export function parseRedirectUris(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/** https is required, except `http://localhost[:port]` while in dev mode. */
export function isRedirectSchemeAllowed(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  if (parsed.hash) return false; // RFC 6749 §3.1.2: no fragment.
  if (parsed.protocol === "https:") return true;
  return (
    isConnectorDevMode() &&
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  );
}

/** Exact string match against the pre-registered list (RFC 6749 §3.1.2.3). */
export function isRegisteredRedirectUri(
  uri: string,
  registered: string[],
): boolean {
  return registered.includes(uri) && isRedirectSchemeAllowed(uri);
}

export function webUrl(path: string): string {
  const base = getPublicAppUrl();
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
