import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadConfig() {
  vi.resetModules();
  return (await import("../../next.config")).default;
}

describe("next.config rewrites (C22 / §4.1)", () => {
  it("defines no rewrites at all when the flag is off — config is unchanged", async () => {
    vi.stubEnv("CONNECTOR_ENABLED", "false");
    const config = await loadConfig();
    expect(config.rewrites).toBeUndefined();
  });

  it("proxies the API and the well-known manifest to the Convex site when on", async () => {
    vi.stubEnv("CONNECTOR_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", "https://happy-animal-123.convex.site/");
    const config = await loadConfig();
    const rewrites = (await config.rewrites!()) as Array<{ source: string; destination: string }>;
    expect(rewrites).toEqual([
      {
        source: "/api/connect/v1/:path*",
        destination: "https://happy-animal-123.convex.site/connect/v1/:path*",
      },
      {
        source: "/.well-known/ecosystem-connector.json",
        destination: "https://happy-animal-123.convex.site/connect/v1/manifest",
      },
    ]);
  });

  it("refuses to start enabled without the Convex site URL", async () => {
    vi.stubEnv("CONNECTOR_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", "");
    await expect(loadConfig()).rejects.toThrow(/NEXT_PUBLIC_CONVEX_SITE_URL/);
  });

  it("keeps the existing anti-clickjacking headers on every route", async () => {
    const config = await loadConfig();
    const rules = await config.headers!();
    const all = rules.find((rule) => rule.source === "/:path*")!;
    expect(all.headers).toContainEqual({ key: "X-Frame-Options", value: "SAMEORIGIN" });
  });
});
