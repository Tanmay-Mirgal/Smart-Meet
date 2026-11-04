"use client";

import { useDeferredValue, useState } from "react";
import { useOrganization } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import {
  CalendarDays,
  CheckCircle2,
  FileText,
  ListChecks,
  Search,
} from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadingBlock } from "@/components/shared/loading-block";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SendMinutesEmailDialog } from "@/features/meeting/components/send-minutes-email-dialog";
import { meetingService } from "@/features/meeting/services/meeting-service";
import { DownloadMinutesButton } from "@/features/meeting/components/download-minutes-button";
import {
  getMinutesPreview,
  type MinutesActionItem,
  type MinutesDocumentData,
} from "@/features/meeting/lib/minutes-document";
import { PageHeader, HeaderStat } from "@/components/shared/page-header";

type MinutesMeeting = {
  _id: string;
  _creationTime: number;
  title: string;
  purpose: string;
  status: "scheduled" | "active" | "ended";
  scheduledFor: number | null;
  endedAt: number | null;
  summary: string;
  key_points: string[];
  decisions: string[];
  action_items: MinutesActionItem[];
  summaryUpdatedAt: number;
};

function formatMeetingDate(meeting: MinutesMeeting) {
  const timestamp = meeting.endedAt ?? meeting.scheduledFor ?? meeting._creationTime;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function toMinutesDocument(meeting: MinutesMeeting): MinutesDocumentData {
  return {
    title: meeting.title,
    purpose: meeting.purpose,
    status: meeting.status,
    createdAt: meeting._creationTime,
    scheduledFor: meeting.scheduledFor,
    endedAt: meeting.endedAt,
    summary: meeting.summary,
    key_points: meeting.key_points,
    decisions: meeting.decisions,
    action_items: meeting.action_items,
    summaryUpdatedAt: meeting.summaryUpdatedAt,
  };
}

function StatusBadge({ status }: { status: MinutesMeeting["status"] }) {
  if (status === "active") {
    return (
      <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        Live
      </Badge>
    );
  }

  if (status === "scheduled") {
    return (
      <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">
        Scheduled
      </Badge>
    );
  }

  return <Badge variant="secondary">Ended</Badge>;
}

export function MinutesOfMeetingsPage() {
  const { organization } = useOrganization();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);

  const minutes = useQuery(
    meetingService.getMinutesByOrg,
    organization?.id ? { orgId: organization.id } : "skip",
  );

  if (minutes === undefined) {
    return <LoadingBlock className="h-80 w-full" />;
  }

  const normalizedSearch = deferredSearch.trim().toLowerCase();
  const filtered = minutes.filter((meeting) => {
    if (!normalizedSearch) {
      return true;
    }

    const preview = getMinutesPreview(toMinutesDocument(meeting));

    return [
      meeting.title,
      meeting.purpose,
      preview,
      ...meeting.key_points,
      ...meeting.decisions,
      ...meeting.action_items.map((item) => item.task),
    ].some((value) => value.toLowerCase().includes(normalizedSearch));
  });

  const totalActionItems = minutes.reduce(
    (count, meeting) => count + meeting.action_items.length,
    0,
  );
  const meetingsWithDecisions = minutes.filter(
    (meeting) => meeting.decisions.length > 0,
  ).length;

  return (
    <div className="space-y-8">
      <PageHeader
        icon={FileText}
        eyebrow="Email-ready archive"
        title="Minutes of Meetings"
        description="Browse professional minutes documents generated from your saved meeting summaries and download them in one click."
      >
        <HeaderStat icon={FileText} value={minutes.length} label="Documents" />
        <HeaderStat icon={ListChecks} value={totalActionItems} label="Action items" />
        <HeaderStat icon={CheckCircle2} value={meetingsWithDecisions} label="With decisions" />
      </PageHeader>

      <Card className="border-border/60 shadow-sm">
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base font-semibold">
                Minutes Library
              </CardTitle>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {filtered.length} of {minutes.length} documents
              </p>
            </div>

            <div className="relative w-full sm:w-72">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search minutes..."
                className="h-9 pl-8 text-sm"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {filtered.length === 0 ? (
            <EmptyState
              title={minutes.length === 0 ? "No minutes yet" : "No matching minutes"}
              description={
                minutes.length === 0
                  ? "Generate an AI summary for a meeting to create a professional MoM document."
                  : "Try a different search term to find the minutes you need."
              }
            />
          ) : (
            filtered.map((meeting) => (
              <div
                key={meeting._id}
                className="rounded-xl border border-border/60 bg-card/70 p-5 shadow-sm"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-semibold text-foreground">
                        {meeting.title}
                      </h2>
                      <StatusBadge status={meeting.status} />
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <CalendarDays className="h-3.5 w-3.5" />
                        {formatMeetingDate(meeting)}
                      </span>
                      <span>Updated {new Date(meeting.summaryUpdatedAt).toLocaleDateString()}</span>
                      <span>{meeting.decisions.length} decisions</span>
                      <span>{meeting.action_items.length} action items</span>
                    </div>

                    <p className="mt-3 text-sm leading-6 text-muted-foreground">
                      {getMinutesPreview(toMinutesDocument(meeting))}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                    <DownloadMinutesButton
                      meeting={toMinutesDocument(meeting)}
                      label="Download document"
                      size="sm"
                      variant="outline"
                    />
                    <SendMinutesEmailDialog
                      meeting={toMinutesDocument(meeting)}
                      organizationId={organization?.id}
                      size="sm"
                    />
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
