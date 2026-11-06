"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useOrganization } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import {
  BookText,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Link2,
  Plug,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  XCircle,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingBlock } from "@/components/shared/loading-block";
import { integrationsService } from "@/features/integrations/services/integrations-service";
import { ConnectedApps } from "@/features/connector/components/connected-apps";
import { cn } from "@/lib/utils";
import { PageHeader, HeaderStat } from "@/components/shared/page-header";

/* ─── helpers ───────────────────────────────────────────── */

function formatTimestamp(value?: number) {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat([], {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function ConnectionBadge({ connected }: { connected: boolean }) {
  if (connected) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Connected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-xs font-semibold text-muted-foreground">
      <XCircle className="h-3.5 w-3.5" />
      Not connected
    </span>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">
        {label}
      </p>
      <p className="text-sm text-foreground">{value}</p>
    </div>
  );
}

function FeatureItem({ icon: Icon, text }: { icon: React.ElementType; text: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10">
        <Icon className="h-3 w-3 text-brand" />
      </div>
      <span className="text-sm leading-relaxed text-muted-foreground">{text}</span>
    </div>
  );
}

/* ─── main page ─────────────────────────────────────────── */

export function IntegrationsPage({ connectorEnabled = false }: { connectorEnabled?: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { organization } = useOrganization();

  const disconnectGoogleCalendar = useMutation(integrationsService.disconnectGoogleCalendar);
  const disconnectNotion = useMutation(integrationsService.disconnectNotion);
  const updateNotionTargetPage = useMutation(integrationsService.updateNotionTargetPage);

  const googleCalendarConnection = useQuery(
    integrationsService.getGoogleCalendarConnection,
    organization?.id ? { orgId: organization.id } : "skip",
  );
  const notionConnection = useQuery(
    integrationsService.getNotionConnection,
    organization?.id ? { orgId: organization.id } : "skip",
  );

  const [isDisconnectingGoogle, setIsDisconnectingGoogle] = useState(false);
  const [isDisconnectingNotion, setIsDisconnectingNotion] = useState(false);
  const [isSavingNotionTarget, setIsSavingNotionTarget] = useState(false);
  const [notionTargetInput, setNotionTargetInput] = useState("");

  const connectGoogleHref = useMemo(() => {
    if (!organization?.id) return "/integrations";
    const params = new URLSearchParams({ orgId: organization.id, returnTo: "/integrations" });
    return `/api/integrations/google/start?${params.toString()}`;
  }, [organization?.id]);

  const connectNotionHref = useMemo(() => {
    if (!organization?.id) return "/integrations";
    const params = new URLSearchParams({ orgId: organization.id, returnTo: "/integrations" });
    return `/api/integrations/notion/start?${params.toString()}`;
  }, [organization?.id]);

  useEffect(() => {
    const calendarStatus = searchParams.get("googleCalendar");
    const notionStatus = searchParams.get("notion");
    let shouldReplace = false;

    if (calendarStatus) {
      shouldReplace = true;
      if (calendarStatus === "connected") toast.success("Google Calendar connected!");
      else if (calendarStatus === "missing-config") toast.error("Google Calendar env vars are missing");
      else if (calendarStatus === "token-error") toast.error("Unable to exchange the Google auth code");
      else if (calendarStatus === "profile-error") toast.error("Unable to read your Google account email");
      else if (calendarStatus === "access-denied") toast.error("Google Calendar access was denied");
      else toast.error("Google Calendar connection failed");
    }

    if (notionStatus) {
      shouldReplace = true;
      if (notionStatus === "connected") toast.success("Notion connected!");
      else if (notionStatus === "missing-config") toast.error("Notion env vars are missing");
      else if (notionStatus === "token-error") toast.error("Unable to exchange the Notion auth code");
      else if (notionStatus === "access-denied") toast.error("Notion access was denied");
      else toast.error("Notion connection failed");
    }

    if (shouldReplace) router.replace("/integrations");
  }, [router, searchParams]);

  useEffect(() => {
    setNotionTargetInput(notionConnection?.targetPageId ?? "");
  }, [notionConnection?.targetPageId]);

  if (!organization || googleCalendarConnection === undefined || notionConnection === undefined) {
    return <LoadingBlock className="h-96 w-full" />;
  }

  const isGoogleConnected = googleCalendarConnection.connected;
  const isNotionConnected = notionConnection.connected;
  const connectedCount = [isGoogleConnected, isNotionConnected].filter(Boolean).length;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8">

      <PageHeader
        icon={Plug}
        eyebrow="Integrations"
        title="Connect team workflows"
        description="Keep scheduling and meeting knowledge connected. Google Calendar covers scheduling, while Notion gives every meeting a durable home for summaries, decisions, and action items."
      >
        <HeaderStat icon={Zap} value={`${connectedCount} / 2`} label="integrations active" />
        {isGoogleConnected && (
          <div className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2 text-xs font-medium text-emerald-400">
            <CalendarDays className="h-3.5 w-3.5" />
            Google Calendar
          </div>
        )}
        {isNotionConnected && (
          <div className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2 text-xs font-medium text-emerald-400">
            <BookText className="h-3.5 w-3.5" />
            Notion
          </div>
        )}
      </PageHeader>

      {/* ── Integration Cards ── */}
      <div className="grid gap-6">

        {/* Google Calendar */}
        <div className={cn(
          "overflow-hidden rounded-xl border shadow-sm transition-all duration-200",
          isGoogleConnected
            ? "border-emerald-500/20 bg-card/80"
            : "border-border/60 bg-card/60"
        )}>
          {/* Card header */}
          <div className={cn(
            "flex items-center justify-between gap-4 border-b px-6 py-5",
            isGoogleConnected ? "border-emerald-500/15 bg-emerald-500/3" : "border-border/60 bg-muted/10"
          )}>
            <div className="flex items-center gap-4">
              <div className={cn(
                "flex h-12 w-12 items-center justify-center rounded-xl border",
                isGoogleConnected
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                  : "border-border bg-muted text-muted-foreground"
              )}>
                <CalendarDays className="h-5 w-5" />
              </div>
              <div>
                <h2 className="font-semibold text-foreground">Google Calendar</h2>
                <p className="text-sm text-muted-foreground">
                  Sync scheduled meetings into the host&apos;s primary calendar.
                </p>
              </div>
            </div>
            <ConnectionBadge connected={isGoogleConnected} />
          </div>

          {/* Card body */}
          <div className="grid gap-6 p-6 md:grid-cols-2">
            {/* Connection details */}
            <div className="space-y-4">
              <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/60">
                Connection details
              </p>
              <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
                <MetaRow
                  label="Account"
                  value={googleCalendarConnection.accountEmail ?? "No Google account connected yet"}
                />
                <div className="h-px bg-border/40" />
                <MetaRow
                  label="Last updated"
                  value={formatTimestamp(googleCalendarConnection.updatedAt)}
                />
                <div className="h-px bg-border/40" />
                <MetaRow
                  label="Token expires"
                  value={formatTimestamp(googleCalendarConnection.tokenExpiresAt)}
                />
                <div className="h-px bg-border/40" />
                <div className="flex flex-col gap-0.5">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">
                    Status
                  </p>
                  <p className={cn(
                    "text-sm font-medium",
                    isGoogleConnected ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
                  )}>
                    {googleCalendarConnection.status ?? "disconnected"}
                  </p>
                  {googleCalendarConnection.lastError && (
                    <p className="mt-0.5 text-xs text-destructive">{googleCalendarConnection.lastError}</p>
                  )}
                  {googleCalendarConnection.warning && (
                    <p className="mt-0.5 text-xs text-amber-600">{googleCalendarConnection.warning}</p>
                  )}
                </div>
              </div>
            </div>

            {/* Features */}
            <div className="space-y-4">
              <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/60">
                What this enables
              </p>
              <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
                <FeatureItem icon={ShieldCheck} text="Create a calendar event when the host schedules a meeting." />
                <FeatureItem icon={Link2} text="Attach meeting join links and invited attendees automatically." />
                <FeatureItem icon={RefreshCw} text="Keep the connection ready for follow-up event updates." />
              </div>
            </div>
          </div>

          {/* Card footer */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-muted/10 px-6 py-4">
            <p className="text-xs text-muted-foreground">
              Connection is scoped to your user account and shared across all meetings in this workspace.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                asChild
                size="sm"
                variant={isGoogleConnected ? "outline" : "default"}
                className="h-8 gap-2 text-xs"
              >
                <Link href={connectGoogleHref}>
                  <CalendarDays className="h-3.5 w-3.5" />
                  {isGoogleConnected ? "Reconnect" : "Connect Google Calendar"}
                </Link>
              </Button>
              {isGoogleConnected && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-2 text-xs text-destructive hover:text-destructive"
                  disabled={isDisconnectingGoogle}
                  onClick={async () => {
                    if (!organization?.id) return;
                    setIsDisconnectingGoogle(true);
                    try {
                      await disconnectGoogleCalendar({ orgId: organization.id });
                      toast.success("Google Calendar disconnected");
                    } catch {
                      toast.error("Unable to disconnect Google Calendar");
                    } finally {
                      setIsDisconnectingGoogle(false);
                    }
                  }}
                >
                  {isDisconnectingGoogle ? "Disconnecting…" : "Disconnect"}
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Notion */}
        <div className={cn(
          "overflow-hidden rounded-xl border shadow-sm transition-all duration-200",
          isNotionConnected
            ? "border-emerald-500/20 bg-card/80"
            : "border-border/60 bg-card/60"
        )}>
          {/* Card header */}
          <div className={cn(
            "flex items-center justify-between gap-4 border-b px-6 py-5",
            isNotionConnected ? "border-emerald-500/15 bg-emerald-500/3" : "border-border/60 bg-muted/10"
          )}>
            <div className="flex items-center gap-4">
              <div className={cn(
                "flex h-12 w-12 items-center justify-center rounded-xl border",
                isNotionConnected
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                  : "border-border bg-muted text-muted-foreground"
              )}>
                <BookText className="h-5 w-5" />
              </div>
              <div>
                <h2 className="font-semibold text-foreground">Notion</h2>
                <p className="text-sm text-muted-foreground">
                  Export completed meetings into a Notion page you choose.
                </p>
              </div>
            </div>
            <ConnectionBadge connected={isNotionConnected} />
          </div>

          {/* Card body */}
          <div className="grid gap-6 p-6 md:grid-cols-2">
            {/* Connection details */}
            <div className="space-y-4">
              <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/60">
                Connection details
              </p>
              <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
                <MetaRow
                  label="Workspace"
                  value={notionConnection.workspaceName ?? "No Notion workspace connected yet"}
                />
                <div className="h-px bg-border/40" />
                <div className="flex flex-col gap-0.5">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">
                    Parent page
                  </p>
                  <p className="break-all text-sm text-foreground">
                    {notionConnection.targetPageId ?? "No parent page set"}
                  </p>
                </div>
                <div className="h-px bg-border/40" />
                <MetaRow
                  label="Last updated"
                  value={formatTimestamp(notionConnection.updatedAt)}
                />
                <div className="h-px bg-border/40" />
                <div className="flex flex-col gap-0.5">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">
                    Status
                  </p>
                  <p className={cn(
                    "text-sm font-medium",
                    isNotionConnected ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
                  )}>
                    {notionConnection.status ?? "disconnected"}
                  </p>
                  {notionConnection.lastError && (
                    <p className="mt-0.5 text-xs text-destructive">{notionConnection.lastError}</p>
                  )}
                  {notionConnection.warning && (
                    <p className="mt-0.5 text-xs text-amber-600">{notionConnection.warning}</p>
                  )}
                </div>
              </div>
            </div>

            {/* Features + export destination */}
            <div className="space-y-4">
              <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/60">
                What this enables
              </p>
              <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
                <FeatureItem icon={ShieldCheck} text="Create a dedicated Notion page for a meeting after it ends." />
                <FeatureItem icon={Sparkles} text="Ship the AI summary, action items, transcript, and recording links." />
                <FeatureItem icon={RefreshCw} text="Reuse the same destination page for future exports." />
              </div>

              {/* Export destination */}
              <div className="space-y-3 rounded-lg border border-border/60 bg-muted/10 p-4">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/60">
                    Export destination
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Share a Notion page with your integration, then paste the URL or page ID here.
                  </p>
                </div>
                <Input
                  value={notionTargetInput}
                  onChange={(e) => setNotionTargetInput(e.target.value)}
                  placeholder="Paste Notion page URL or ID…"
                  disabled={!isNotionConnected}
                  className="h-9 text-sm"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    className="h-8 gap-2 text-xs"
                    disabled={!isNotionConnected || isSavingNotionTarget}
                    onClick={async () => {
                      if (!organization?.id) return;
                      setIsSavingNotionTarget(true);
                      try {
                        await updateNotionTargetPage({
                          orgId: organization.id,
                          targetPageId: notionTargetInput.trim() || null,
                        });
                        toast.success(
                          notionTargetInput.trim()
                            ? "Export destination saved!"
                            : "Export destination cleared",
                        );
                      } catch (error) {
                        toast.error(
                          error instanceof Error ? error.message : "Unable to save destination",
                        );
                      } finally {
                        setIsSavingNotionTarget(false);
                      }
                    }}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                    {isSavingNotionTarget ? "Saving…" : "Save destination"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={!isNotionConnected || !notionConnection.targetPageId || isSavingNotionTarget}
                    onClick={async () => {
                      if (!organization?.id) return;
                      setIsSavingNotionTarget(true);
                      try {
                        await updateNotionTargetPage({ orgId: organization.id, targetPageId: null });
                        setNotionTargetInput("");
                        toast.success("Export destination cleared");
                      } catch (error) {
                        toast.error(
                          error instanceof Error ? error.message : "Unable to clear destination",
                        );
                      } finally {
                        setIsSavingNotionTarget(false);
                      }
                    }}
                  >
                    Clear
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* Card footer */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-muted/10 px-6 py-4">
            <p className="text-xs text-muted-foreground">
              Connection is scoped to your account. Exports create child pages under the parent page you configure.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                asChild
                size="sm"
                variant={isNotionConnected ? "outline" : "default"}
                className="h-8 gap-2 text-xs"
              >
                <Link href={connectNotionHref}>
                  <BookText className="h-3.5 w-3.5" />
                  {isNotionConnected ? "Reconnect Notion" : "Connect Notion"}
                </Link>
              </Button>
              {isNotionConnected && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-2 text-xs text-destructive hover:text-destructive"
                  disabled={isDisconnectingNotion}
                  onClick={async () => {
                    if (!organization?.id) return;
                    setIsDisconnectingNotion(true);
                    try {
                      await disconnectNotion({ orgId: organization.id });
                      setNotionTargetInput("");
                      toast.success("Notion disconnected");
                    } catch {
                      toast.error("Unable to disconnect Notion");
                    } finally {
                      setIsDisconnectingNotion(false);
                    }
                  }}
                >
                  {isDisconnectingNotion ? "Disconnecting…" : "Disconnect"}
                </Button>
              )}
            </div>
          </div>
        </div>

      </div>

      {/* Ecosystem connector — renders nothing unless CONNECTOR_ENABLED=true */}
      {connectorEnabled && <ConnectedApps orgId={organization.id} orgName={organization.name} />}
    </div>
  );
}
