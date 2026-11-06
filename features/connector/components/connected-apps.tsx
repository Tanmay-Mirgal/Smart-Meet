"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Activity, AlertTriangle, CheckCircle2, PlugZap, Webhook } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function formatTimestamp(value: number | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat([], { dateStyle: "medium", timeStyle: "short" }).format(value);
}

const WEBHOOK_REASONS: Record<string, string> = {
  grant_revoked: "the connection was revoked",
  endpoint_gone: "the receiver answered 410 Gone",
  too_many_failures: "50 deliveries in a row failed",
  failing_for_3_days: "deliveries failed for 3 days",
};

/**
 * "Connected apps" (CP1 §7.2). Renders nothing unless the connector is
 * enabled, so a deployment without it sees no change on the Integrations page.
 */
export function ConnectedApps({ orgId, orgName }: { orgId: string; orgName?: string }) {
  const data = useQuery(api.connector.grants.listForOrg, { orgId });
  const revoke = useMutation(api.connector.grants.revoke);
  const [revoking, setRevoking] = useState<Id<"connector_grants"> | null>(null);

  if (!data?.enabled) return null;

  async function revokeGrant(grantId: Id<"connector_grants">) {
    setRevoking(grantId);
    try {
      await revoke({ grantId });
      toast.success("Connection revoked");
    } catch {
      toast.error("Unable to revoke this connection");
    } finally {
      setRevoking(null);
    }
  }

  return (
    <section className="space-y-4" aria-labelledby="connected-apps-heading">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
          <PlugZap className="h-4 w-4" />
        </div>
        <div>
          <h2 id="connected-apps-heading" className="font-semibold text-foreground">
            Connected apps
          </h2>
          <p className="text-sm text-muted-foreground">
            Apps you allowed to work with this organization on your behalf.
          </p>
        </div>
      </div>

      {data.grants.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-card/40 px-6 py-8 text-center">
          <p className="text-sm font-medium text-foreground">No connected apps</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            When you connect {data.hubName || "an app"}, it can schedule and end meetings, read
            summaries, decisions and tasks, and create tasks for you — never more than you can do in
            Meetup. You can revoke it here at any time.
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {data.grants.map((grant) => (
            <div
              key={grant.id}
              className="overflow-hidden rounded-xl border border-border/60 bg-card/80 shadow-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-muted/10 px-6 py-4">
                <div>
                  <h3 className="font-semibold text-foreground">{grant.clientName}</h3>
                  <p className="text-xs text-muted-foreground">
                    {orgName ?? "This organization"} · connected by {grant.connectedBy} on{" "}
                    {formatTimestamp(grant.createdAt)} · last used {formatTimestamp(grant.lastUsedAt)}
                  </p>
                </div>

                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={revoking === grant.id}
                      className="h-8 text-xs text-destructive hover:text-destructive"
                    >
                      {revoking === grant.id ? "Revoking…" : "Revoke"}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Revoke {grant.clientName}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        {grant.clientName} will lose access immediately and its webhook endpoints
                        will be disabled. You can connect it again later.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep connected</AlertDialogCancel>
                      <AlertDialogAction onClick={() => void revokeGrant(grant.id)}>
                        Revoke access
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>

              <div className="space-y-5 p-6">
                <div className="space-y-2">
                  <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/60">
                    Permissions
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {grant.scopes.map((scope) => (
                      <span
                        key={scope}
                        className="rounded-md border border-border/60 bg-muted/30 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                      >
                        {scope.replace(/^meetup:/, "")}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-muted-foreground/60">
                    <Webhook className="h-3 w-3" /> Webhook endpoints
                  </p>
                  {grant.webhooks.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No webhook endpoints registered.</p>
                  ) : (
                    <ul className="space-y-2">
                      {grant.webhooks.map((webhook) => (
                        <li
                          key={webhook.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
                        >
                          <span className="break-all font-mono text-xs text-foreground">
                            {webhook.url}
                          </span>
                          <span
                            className={cn(
                              "inline-flex items-center gap-1.5 text-xs font-medium",
                              webhook.status === "active"
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-amber-600",
                            )}
                          >
                            {webhook.status === "active" ? (
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            ) : (
                              <AlertTriangle className="h-3.5 w-3.5" />
                            )}
                            {webhook.status === "active"
                              ? webhook.lastDeliveryStatus
                                ? `Active · last delivery ${webhook.lastDeliveryStatus}`
                                : "Active"
                              : `Disabled${
                                  webhook.disabledReason
                                    ? ` — ${WEBHOOK_REASONS[webhook.disabledReason] ?? webhook.disabledReason}`
                                    : ""
                                }`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {data.grants.length > 0 && (
        <div className="rounded-xl border border-border/60 bg-card/60 p-6">
          <p className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-muted-foreground/60">
            <Activity className="h-3 w-3" /> Recent connector activity
          </p>
          {data.activity.length === 0 ? (
            <p className="text-sm text-muted-foreground">No calls yet.</p>
          ) : (
            <ul className="divide-y divide-border/40">
              {data.activity.map((entry, index) => (
                <li
                  key={`${entry.createdAt}-${index}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                >
                  <span className="font-mono text-xs text-foreground">
                    {entry.method} {entry.action}
                  </span>
                  <span className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className={entry.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}>
                      {entry.status}
                      {entry.errorCode ? ` ${entry.errorCode}` : ""}
                    </span>
                    {formatTimestamp(entry.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
