'use client';

import { ReactNode } from "react";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { useAuth } from "@clerk/nextjs";
import { Toaster } from "@/components/ui/sonner";
import { SyncUserWithConvex } from "@/components/sync-user-with-convex";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

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
