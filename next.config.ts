import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Meetings need the camera, microphone and screen capture on our own origin only.
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(self), display-capture=(self), geolocation=()",
  },
];

// Ecosystem Connector (CP1). When the flag is off no rewrite exists at all, so
// /api/connect/* and the well-known document are ordinary 404s and the app
// behaves exactly as before.
const connectorEnabled = process.env.CONNECTOR_ENABLED === "true";
const convexSiteUrl = process.env.NEXT_PUBLIC_CONVEX_SITE_URL?.trim().replace(/\/+$/, "");

if (connectorEnabled && !convexSiteUrl) {
  throw new Error(
    "CONNECTOR_ENABLED=true requires NEXT_PUBLIC_CONVEX_SITE_URL (the https://<deployment>.convex.site origin).",
  );
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  images: {
    formats: ["image/avif", "image/webp"],
  },
  // grpc-js loads its transport lazily; keep it out of the server bundle.
  serverExternalPackages: ["@grpc/grpc-js"],
  experimental: {
    // lucide-react, recharts and date-fns are already optimised by default.
    optimizePackageImports: ["radix-ui", "@base-ui/react"],
  },
  ...(connectorEnabled
    ? {
        // Server-to-server connector API: the logic lives in Convex httpActions
        // (convex/connector/*); Next only proxies it so the Hub talks to the app
        // domain. Rewrites keep the method, body and Authorization /
        // Idempotency-Key headers, and the upstream status and headers.
        async rewrites() {
          return [
            {
              source: "/api/connect/v1/:path*",
              destination: `${convexSiteUrl}/connect/v1/:path*`,
            },
            {
              source: "/.well-known/ecosystem-connector.json",
              destination: `${convexSiteUrl}/connect/v1/manifest`,
            },
          ];
        },
      }
    : {}),
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        // Brand assets change rarely; let browsers and the CDN reuse them.
        source: "/icons/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" },
        ],
      },
    ];
  },
};

export default nextConfig;
