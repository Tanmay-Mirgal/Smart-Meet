import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // Convex function tests (convex-test) run in the edge runtime, like Convex itself.
        test: {
          name: "convex",
          environment: "edge-runtime",
          include: ["tests/convex/**/*.test.ts"],
          // The first call loads every Convex module (convex-test), which is slow on cold caches.
          testTimeout: 30_000,
          hookTimeout: 30_000,
          server: { deps: { inline: ["convex-test"] } },
        },
      },
      {
        // Pure TypeScript units (registry, crypto, routes, config, …).
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
    ],
  },
});
