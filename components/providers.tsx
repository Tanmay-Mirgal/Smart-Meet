'use client';

import { ReactNode } from "react";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { useAuth } from "@clerk/nextjs";
import { Toaster } from "@/components/ui/sonner";
import { SyncUserWithConvex } from "@/components/sync-user-with-convex";

// Ensure we connect to the active production deployment (gregarious-seal-751)
// even if Vercel still has the obsolete glorious-gopher deployment in its env.
const convexUrl =
  process.env.NEXT_PUBLIC_CONVEX_URL &&
  !process.env.NEXT_PUBLIC_CONVEX_URL.includes("glorious-gopher") &&
  !process.env.NEXT_PUBLIC_CONVEX_URL.includes("tame-walrus")
    ? process.env.NEXT_PUBLIC_CONVEX_URL
    : "https://gregarious-seal-751.convex.cloud";

const convex = new ConvexReactClient(convexUrl);

/**
 * Realtime data layer (Convex + toasts + user sync).
 * Mounted only by the signed-in route groups so the public landing and auth
 * pages never download the Convex client.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
      <SyncUserWithConvex />
      {children}
      <Toaster position="top-right" />
    </ConvexProviderWithClerk>
  );
}
