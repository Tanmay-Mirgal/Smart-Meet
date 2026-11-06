"use client";

import { useQuery } from "convex/react";
import { Plug } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { cn } from "@/lib/utils";

/**
 * "Created via <Hub>" (CP1 §7.3). Render it ONLY for records whose `createdVia`
 * is "connector": it is the only thing that subscribes to the hub's name, so
 * nothing extra runs for ordinary meetings and tasks.
 */
export function CreatedViaBadge({ className }: { className?: string }) {
  const info = useQuery(api.connector.grants.hubInfo, {});
  if (info === undefined) return null;

  return (
    <span
      title="This was created by a connected app"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground",
        className,
      )}
    >
      <Plug className="h-2.5 w-2.5" />
      Created via {info.enabled && info.hubName ? info.hubName : "a connected app"}
    </span>
  );
}
