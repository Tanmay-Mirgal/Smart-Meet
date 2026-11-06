"use client";

import { CreatedViaBadge } from "@/features/connector/components/created-via-badge";
import Link from "next/link";
import { useOrganization } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import {
  CalendarDays,
  ChevronRight,
  Clock,
  FileText,
  Radio,
  Search,
  Sparkles,
  Video,
} from "lucide-react";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadingBlock } from "@/components/shared/loading-block";
import { meetingService } from "@/features/meeting/services/meeting-service";
import { PageHeader, HeaderStat } from "@/components/shared/page-header";

type Meeting = {
  _id: string;
  _creationTime: number;
  title: string;
  purpose: string;
  status: string;
  /** Set when an ecosystem connector created the meeting. */
  createdVia?: "connector";
};

function StatusBadge({ status }: { status: string }) {
  if (status === "active") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
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

function MeetingCard({ meeting }: { meeting: Meeting }) {
  const isActive = meeting.status === "active";
  const href = isActive
    ? `/meeting/${meeting._id}`
    : `/meeting/${meeting._id}/details`;

  const date = new Date(meeting._creationTime);
  const formattedDate = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const formattedTime = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <Link
      href={href}
      className="group flex items-center gap-4 rounded-xl border border-border/60 bg-card/60 px-5 py-4 shadow-sm transition-all duration-200 hover:border-border hover:bg-muted/30 hover:shadow-md"
    >
      {/* Icon */}
      <div
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
          isActive
            ? "bg-emerald-500/10 text-emerald-500"
            : "bg-muted text-muted-foreground"
        }`}
      >
        {isActive ? (
          <Radio className="h-5 w-5" />
        ) : (
          <Video className="h-5 w-5" />
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-semibold text-foreground transition-colors group-hover:text-brand">
            {meeting.title}
          </p>
          {meeting.createdVia === "connector" && <CreatedViaBadge className="hidden sm:inline-flex" />}
          {isActive && (
            <span className="hidden shrink-0 sm:inline">
              <StatusBadge status={meeting.status} />
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-sm text-muted-foreground">
          {meeting.purpose || "No description"}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
            <CalendarDays className="h-3.5 w-3.5" />
            {formattedDate}
          </span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
            <Clock className="h-3.5 w-3.5" />
            {formattedTime}
          </span>
        </div>
      </div>

      {/* Right section */}
      <div className="flex shrink-0 items-center gap-3">
        <div className="hidden text-right sm:block">
          <StatusBadge status={meeting.status} />
        </div>
        <ChevronRight className="h-4.5 w-4.5 text-muted-foreground/40 transition-all group-hover:translate-x-0.5 group-hover:text-brand" />
      </div>
    </Link>
  );
}

export function MeetingsPage() {
  const { organization } = useOrganization();
  const [search, setSearch] = useState("");

  const meetings = useQuery(
    meetingService.getMeetings,
    organization?.id ? { orgId: organization.id } : "skip",
  );

  if (meetings === undefined) {
    return <LoadingBlock className="h-80 w-full" />;
  }

  const filtered = meetings.filter(
    (m) =>
      m.title.toLowerCase().includes(search.toLowerCase()) ||
      m.purpose?.toLowerCase().includes(search.toLowerCase()),
  );

  const liveCount = meetings.filter((m) => m.status === "active").length;
  const endedCount = meetings.filter((m) => m.status === "ended").length;

  return (
    <div className="space-y-8">
      <PageHeader
        icon={Video}
        eyebrow="Workspace Archive"
        title="Meetings"
        description="Every meeting is transcribed and summarised in realtime."
      >
        <HeaderStat icon={FileText} value={meetings.length} label="Total" />
        {liveCount > 0 && <HeaderStat icon={Radio} value={liveCount} label="Live" tone="live" />}
        <HeaderStat icon={Sparkles} value={endedCount} label="Archived" />
      </PageHeader>

      {/* ── List ── */}
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base font-semibold">
                Meeting Archive
              </CardTitle>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {filtered.length} of {meetings.length} meetings
              </p>
            </div>

            {/* Search */}
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search meetings…"
                className="h-9 pl-8 text-sm"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          {/* Filter chips */}
          <div className="flex flex-wrap gap-2 pt-1">
            {["all", "active", "ended"].map((f) => {
              const count =
                f === "all"
                  ? meetings.length
                  : meetings.filter((m) => m.status === f).length;
              return (
                <button
                  key={f}
                  onClick={() => setSearch(f === "all" ? "" : f)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {f === "active" && (
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  )}
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                  <Badge
                    variant="secondary"
                    className="h-4 min-w-4 px-1 text-[10px]"
                  >
                    {count}
                  </Badge>
                </button>
              );
            })}
          </div>
        </CardHeader>

        <CardContent className="space-y-2.5">
          {filtered.length === 0 ? (
            <EmptyState
              title={search ? "No matches found" : "No meetings yet"}
              description={
                search
                  ? "Try a different search term."
                  : "Create an instant or scheduled meeting to populate the archive."
              }
            />
          ) : (
            filtered.map((meeting) => (
              <MeetingCard key={meeting._id} meeting={meeting} />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
