"use client";

import Link from "next/link";
import { useOrganization } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import {
  Activity,
  ArrowRight,
  CalendarDays,
  CheckSquare,
  ChevronRight,
  Clock,
  FileText,
  Inbox,
  Radio,
  Sparkles,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadingBlock } from "@/components/shared/loading-block";
import { dashboardService } from "@/features/dashboard/services/dashboard-service";
import { invitationService } from "@/features/invitations/services/invitation-service";
import { PageHeader } from "@/components/shared/page-header";

const statConfig = [
  {
    key: "totalMeetings",
    label: "Total Meetings",
    icon: CalendarDays,
    gradient: "from-blue-500/10 via-blue-400/5 to-transparent",
    iconColor: "text-blue-500",
    iconBg: "bg-blue-500/10",
    trend: "All time",
    isLive: false,
  },
  {
    key: "activeMeetings",
    label: "Live Rooms",
    icon: Radio,
    gradient: "from-emerald-500/10 via-emerald-400/5 to-transparent",
    iconColor: "text-emerald-500",
    iconBg: "bg-emerald-500/10",
    trend: "Active now",
    isLive: true,
  },
  {
    key: "summariesGenerated",
    label: "AI Summaries",
    icon: FileText,
    gradient: "from-violet-500/10 via-violet-400/5 to-transparent",
    iconColor: "text-violet-500",
    iconBg: "bg-violet-500/10",
    trend: "Generated",
    isLive: false,
  },
  {
    key: "openTasks",
    label: "Open Tasks",
    icon: CheckSquare,
    gradient: "from-amber-500/10 via-amber-400/5 to-transparent",
    iconColor: "text-amber-500",
    iconBg: "bg-amber-500/10",
    trend: "Pending",
    isLive: false,
  },
] as const;

function StatusBadge({ status }: { status: string }) {
  if (status === "active") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
        Live
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      Ended
    </span>
  );
}

function MeetingRow({
  meeting,
}: {
  meeting: {
    _id: string;
    title: string;
    purpose: string;
    status: string;
    _creationTime: number;
  };
}) {
  const isActive = meeting.status === "active";
  const href = isActive
    ? `/meeting/${meeting._id}`
    : `/meeting/${meeting._id}/details`;

  return (
    <Link
      href={href}
      className="group flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-card/50 px-4 py-3.5 text-sm transition-all duration-200 hover:border-border hover:bg-muted/40 hover:shadow-sm"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
            isActive
              ? "bg-emerald-500/10 text-emerald-500"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {isActive ? (
            <Radio className="h-3.5 w-3.5" />
          ) : (
            <CalendarDays className="h-3.5 w-3.5" />
          )}
        </div>
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{meeting.title}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {meeting.purpose}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <div className="text-right">
          <StatusBadge status={meeting.status} />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {new Date(meeting._creationTime).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            })}
          </p>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
      </div>
    </Link>
  );
}

export function DashboardPage() {
  const { organization } = useOrganization();
  const respondToInvitation = useMutation(invitationService.respondToInvitation);
  const overview = useQuery(
    dashboardService.getOverview,
    organization?.id ? { orgId: organization.id } : "skip",
  );
  const invitations = useQuery(
    invitationService.listMyInvitations,
    organization?.id ? { orgId: organization.id } : "skip",
  );

  if (overview === undefined) {
    return <LoadingBlock className="h-80 w-full" />;
  }

  const handleRespond = async (
    invitationId: Id<"meeting_invites">,
    response: "accepted" | "declined",
  ) => {
    try {
      await respondToInvitation({ invitationId, response });
      toast.success(
        response === "accepted" ? "Invitation accepted!" : "Invitation declined",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to update invitation",
      );
    }
  };

  const pendingInvitations =
    invitations?.filter((i) => i.invitationStatus === "pending") ?? [];

  return (
    <div className="space-y-8">
      <PageHeader
        icon={Sparkles}
        eyebrow="Operations Center"
        title="Dashboard"
        description="Track live meetings, AI summaries, and follow-up tasks — all from one place."
      >
        {pendingInvitations.length > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-400">
            <Inbox className="h-3.5 w-3.5" />
            {pendingInvitations.length} pending invite
            {pendingInvitations.length !== 1 ? "s" : ""}
          </span>
        )}
        <Button variant="outline" asChild className="gap-2">
          <Link href="/meetings">
            View archive
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </PageHeader>

      {/* ── Stats Grid ── */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {statConfig.map((item) => {
          const Icon = item.icon;
          const value = overview.stats[item.key];
          return (
            <div
              key={item.key}
              className={`relative overflow-hidden rounded-xl border border-border/60 bg-linear-to-br ${item.gradient} p-5 transition-all duration-200 hover:border-border hover:shadow-sm`}
            >
              <div className="flex items-start justify-between">
                <div
                  className={`flex h-10 w-10 items-center justify-center rounded-lg ${item.iconBg}`}
                >
                  <Icon className={`h-5 w-5 ${item.iconColor}`} />
                </div>
                {item?.isLive && value > 0 ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                    Live
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                    {item.trend}
                  </span>
                )}
              </div>
              <div className="mt-4">
                <p className="text-3xl font-bold tracking-tight text-foreground">
                  {value}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{item.label}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Main Content ── */}
      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        {/* Recent Meetings */}
        <Card className="border-border/60 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-4">
            <div>
              <CardTitle className="text-base font-semibold">
                Recent Meetings
              </CardTitle>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Latest activity across your workspace
              </p>
            </div>
            <Button variant="ghost" size="sm" asChild className="gap-1.5 text-xs">
              <Link href="/meetings">
                View all
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {overview.recentMeetings.length === 0 ? (
              <EmptyState
                title="No meetings yet"
                description="Create your first meeting to unlock summaries, chat, and realtime collaboration."
              />
            ) : (
              overview.recentMeetings.map((meeting) => (
                <MeetingRow key={meeting._id} meeting={meeting} />
              ))
            )}
          </CardContent>
        </Card>

        {/* Right Column */}
        <div className="flex flex-col gap-6">
          {/* Live Status */}
          <Card className="border-border/60 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10">
                  <Zap className="h-4 w-4 text-emerald-500" />
                </div>
                <CardTitle className="text-base font-semibold">
                  Live Status
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              {overview.activeMeeting ? (
                <div className="space-y-4">
                  <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
                    <div className="flex items-center gap-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                      <span className="flex h-2 w-2 rounded-full bg-emerald-500">
                        <span className="h-2 w-2 animate-ping rounded-full bg-emerald-500 opacity-75" />
                      </span>
                      Meeting in progress
                    </div>
                    <p className="mt-2 text-base font-semibold text-foreground">
                      {overview.activeMeeting.title}
                    </p>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      Started recently
                    </div>
                  </div>
                  <Button asChild className="w-full gap-2">
                    <Link href={`/meeting/${overview.activeMeeting._id}`}>
                      <Radio className="h-4 w-4" />
                      Join Live Room
                    </Link>
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-6 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                    <Activity className="h-5 w-5 text-muted-foreground/50" />
                  </div>
                  <p className="mt-3 text-sm font-medium text-foreground">
                    Workspace is quiet
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    No live meeting right now
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Quick Stats */}
          <Card className="border-border/60 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10">
                  <TrendingUp className="h-4 w-4 text-violet-500" />
                </div>
                <CardTitle className="text-base font-semibold">
                  At a Glance
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {[
                {
                  label: "Meetings this week",
                  value: overview.stats.totalMeetings,
                  icon: CalendarDays,
                  color: "text-blue-500",
                  bg: "bg-blue-500/10",
                },
                {
                  label: "Summaries generated",
                  value: overview.stats.summariesGenerated,
                  icon: FileText,
                  color: "text-violet-500",
                  bg: "bg-violet-500/10",
                },
                {
                  label: "Tasks remaining",
                  value: overview.stats.openTasks,
                  icon: CheckSquare,
                  color: "text-amber-500",
                  bg: "bg-amber-500/10",
                },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2.5"
                >
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`flex h-7 w-7 items-center justify-center rounded-md ${stat.bg}`}
                    >
                      <stat.icon className={`h-3.5 w-3.5 ${stat.color}`} />
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {stat.label}
                    </span>
                  </div>
                  <span className="text-sm font-semibold text-foreground">
                    {stat.value}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── Invitation Inbox ── */}
      <Card
        id="invitation-inbox"
        className="scroll-mt-24 border-border/60 shadow-sm"
      >
        <CardHeader className="flex flex-row items-center justify-between pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
              <Inbox className="h-4.5 w-4.5 text-brand" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold">
                Invitation Inbox
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Meeting invites land here instantly
              </p>
            </div>
          </div>
          {pendingInvitations.length > 0 && (
            <Badge variant="secondary" className="gap-1.5">
              <Users className="h-3 w-3" />
              {pendingInvitations.length} new
            </Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {invitations === undefined ? (
            <LoadingBlock className="h-40 w-full" />
          ) : invitations.length === 0 ? (
            <EmptyState
              title="No invitations yet"
              description="When someone invites you to a meeting, it will appear here immediately."
            />
          ) : (
            invitations.slice(0, 3).map((invite) => (
              <div
                key={invite._id}
                className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/50 px-4 py-4 transition-all duration-200 hover:border-border hover:bg-muted/30 lg:flex-row lg:items-center lg:justify-between"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-brand">
                    {invite.organizerName?.charAt(0).toUpperCase() ?? "?"}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">
                      {invite.meetingTitle}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {invite.organizerName} · {invite.organizationName}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {invite.invitationStatus === "pending" ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs"
                        onClick={() => void handleRespond(invite._id, "declined")}
                      >
                        Decline
                      </Button>
                      <Button
                        size="sm"
                        className="h-8 gap-1.5 text-xs"
                        onClick={() => void handleRespond(invite._id, "accepted")}
                      >
                        <CheckSquare className="h-3.5 w-3.5" />
                        Accept
                      </Button>
                    </>
                  ) : (
                    <Badge
                      variant={
                        invite.invitationStatus === "accepted"
                          ? "default"
                          : "secondary"
                      }
                      className="text-xs"
                    >
                      {invite.invitationStatus === "accepted"
                        ? "Accepted"
                        : "Declined"}
                    </Badge>
                  )}
                  {invite.canJoin ? (
                    <Button size="sm" variant="outline" asChild className="h-8 gap-1.5 text-xs">
                      <Link href={invite.joinLink}>
                        <Radio className="h-3.5 w-3.5" />
                        Join
                      </Link>
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

    </div>
  );
}
