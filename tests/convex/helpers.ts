import { vi } from "vitest";

// `import.meta.glob` is provided by Vite at test time. `vite` is not a direct
// dependency of this project, so declare the one signature we use.
declare global {
  interface ImportMeta {
    glob(
      patterns: string | string[],
    ): Record<string, () => Promise<unknown>>;
  }
}

/** Every Convex module (functions + helpers), excluding generated type stubs. */
export const modules = import.meta.glob([
  "../../convex/**/*.*s",
  "!../../convex/**/*.d.ts",
]);

export const TEST_PEPPER = "test-pepper-".padEnd(48, "x");
export const TEST_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
export const TEST_CLIENT_ID = "hub-client";
export const TEST_CLIENT_SECRET = "s3cret-value";
export const TEST_REDIRECT = "https://hub.example.com/callback";
export const TEST_APP_URL = "https://meetup.example.com";

/** Turns the connector on with a complete, valid configuration. */
export function enableConnector(overrides: Record<string, string> = {}) {
  const env: Record<string, string> = {
    CONNECTOR_ENABLED: "true",
    CONNECTOR_HUB_NAME: "Orbit Hub",
    CONNECTOR_HUB_CLIENT_ID: TEST_CLIENT_ID,
    CONNECTOR_HUB_CLIENT_SECRET: TEST_CLIENT_SECRET,
    CONNECTOR_HUB_REDIRECT_URIS: TEST_REDIRECT,
    CONNECTOR_TOKEN_PEPPER: TEST_PEPPER,
    CONNECTOR_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    NEXT_PUBLIC_APP_URL: TEST_APP_URL,
    APP_BASE_URL: TEST_APP_URL,
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
}
