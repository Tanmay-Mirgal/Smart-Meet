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
