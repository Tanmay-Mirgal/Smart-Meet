/* eslint-disable @typescript-eslint/no-unused-vars */
"use client";

import { useAction, useQuery } from "convex/react";
import ReactMarkdown from "react-markdown";
import type { Id } from "@/convex/_generated/dataModel";
import { LoadingBlock } from "@/components/shared/loading-block";
import { EmptyState } from "@/components/shared/empty-state";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSyncOrganizationBilling } from "@/features/billing/hooks/use-sync-organization-billing";
import { billingService } from "@/features/billing/services/billing-service";
import { DownloadMinutesButton } from "@/features/meeting/components/download-minutes-button";
import { meetingService } from "@/features/meeting/services/meeting-service";
import { taskService } from "@/features/tasks/services/task-service";
import { Sparkles, MessageSquare, CalendarDays, Clock, CheckCircle2, Video, BookText, ExternalLink, ArrowLeft } from "lucide-react";
import Link from "next/link";

import React, { useState } from "react";
import { toast } from "sonner";

type TranscriptRow = {
  _id: string;
  timestamp: number;
  text: string;
  speakerName: string;
};

type RecordingRow = {
  _id: string;
  startedAt: number;
  durationMs?: number;
  status: string;
  playbackUrl?: string | null;
};

function getSyncedTranscriptLine(
  transcriptRows: TranscriptRow[],
  recordingStartedAt: number,
  currentTimeSeconds: number,
) {
  const targetTimestamp = recordingStartedAt + currentTimeSeconds * 1000;
  for (let index = transcriptRows.length - 1; index >= 0; index -= 1) {
    const row = transcriptRows[index];
    if (row.timestamp <= targetTimestamp) {
      return row;
    }
  }
  return null;
}

export function MeetingDetailsPage({ meetingId }: { meetingId: Id<"meetings"> }) {
  const meeting = useQuery(meetingService.getMeeting, { meetingId });
  useSyncOrganizationBilling(meeting?.orgId);
  const transcripts = useQuery(meetingService.listTranscripts, { meetingId });
  const recordings = useQuery(meetingService.listRecordings, { meetingId });
  const billing = useQuery(
    billingService.getOrganizationPlan,
    meeting?.orgId ? { orgId: meeting.orgId } : "skip",
  );
  const notionConnection = useQuery(
    meetingService.getNotionConnection,
    meeting?.orgId ? { orgId: meeting.orgId } : "skip",
  );
  const notionExport = useQuery(
    meetingService.getMeetingNotionExport,
    { meetingId },
  );
  const exportMeetingToNotion = useAction(meetingService.exportMeetingToNotion);
  const meetingTasks = useQuery(taskService.listMeetingTasks, { meetingId });
  const [activeRecordingId, setActiveRecordingId] = useState<string | null>(null);
  const [activeRecordingTime, setActiveRecordingTime] = useState(0);
  const [isExportingToNotion, setIsExportingToNotion] = useState(false);

  if (
    meeting === undefined
    || transcripts === undefined
    || recordings === undefined
    || meetingTasks === undefined
  ) {
    return <LoadingBlock className="h-96 w-full" />;
  }

  if (!meeting) {
    return <EmptyState title="Meeting not found" description="This meeting no longer exists." />;
  }

  const creationDate = new Date(meeting._creationTime);
  const activeRecording = recordings.find((r) => r._id === activeRecordingId) ?? null;
  const syncedTranscriptLine = activeRecording
    ? getSyncedTranscriptLine(transcripts, activeRecording.startedAt, activeRecordingTime)
    : null;
  const canExportToNotion = Boolean(
    billing?.features.notionExport
    && notionConnection?.connected
    && notionConnection.targetPageId
    && !isExportingToNotion,
  );

  const statusColor =
    meeting.status === "active"
      ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30"
      : meeting.status === "ended"
        ? "bg-muted text-muted-foreground border-border"
        : "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30";

  const hasSummary = Boolean(meeting.summary);
  const hasActionItems =
    (meeting.action_items && meeting.action_items.length > 0)
    || meetingTasks.length > 0;
  const hasKeyPoints = meeting.key_points && meeting.key_points.length > 0;
  const hasDecisions = meeting.decisions && meeting.decisions.length > 0;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-5 md:px-6">

      {/* ── Back button ── */}
      <div className="mb-4">
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-muted-foreground hover:text-foreground -ml-2"
          asChild
        >
          <Link href="/meetings">
            <ArrowLeft className="h-4 w-4" />
            Back to Meetings
          </Link>
        </Button>
      </div>

      {/* ── Hero Header ── */}
      <div className="mb-6 overflow-hidden rounded-xl border border-border/60 bg-linear-to-br from-card via-card to-muted/30">
        {/* Top bar */}
        <div className="relative px-6 py-5">
          <div className="pointer-events-none absolute -right-8 -top-8 h-40 w-40 rounded-full bg-primary/5 blur-3xl" />

          {/* Meta row */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${statusColor}`}
            >
              {meeting.status === "active" && (
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
              )}
              {meeting.status}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5" />
              {creationDate.toLocaleDateString(undefined, {
                weekday: "short",
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              {creationDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>

          {/* Title + purpose */}
          <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            {meeting.title}
          </h1>
          {meeting.purpose && (
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {meeting.purpose}
            </p>
          )}

          {/* Stat chips */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground">
              <MessageSquare className="h-3.5 w-3.5" />
              <span>{transcripts.length} transcript msgs</span>
            </div>
            <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground">
              <Video className="h-3.5 w-3.5" />
              <span>{recordings.length} recording{recordings.length !== 1 ? "s" : ""}</span>
            </div>
            {hasSummary && (
              <Badge className="border-primary/20 bg-primary/10 text-brand">
                Email-ready MoM available
              </Badge>
            )}
          </div>
        </div>

        {/* Notion export bar */}
        <div className="flex flex-wrap items-center gap-3 border-t border-border/60 bg-muted/20 px-6 py-3">
          <DownloadMinutesButton
            meeting={{
              title: meeting.title,
              purpose: meeting.purpose,
              status: meeting.status,
              createdAt: meeting._creationTime,
              scheduledFor: meeting.scheduledFor ?? null,
              endedAt: meeting.endedAt ?? null,
              summary: meeting.summary ?? "",
              key_points: meeting.key_points ?? [],
              decisions: meeting.decisions ?? [],
              action_items: meeting.action_items ?? [],
            }}
            size="sm"
            variant="outline"
            label="Download MoM"
            className="h-8 gap-1.5 text-xs"
          />
          <Button
            size="sm"
            disabled={!canExportToNotion}
            onClick={async () => {
              setIsExportingToNotion(true);
              try {
                const result = await exportMeetingToNotion({ meetingId });
                toast.success("Meeting exported to Notion");
                if (result.pageUrl) {
                  window.open(result.pageUrl, "_blank", "noopener,noreferrer");
                }
              } catch (error) {
                toast.error(
                  error instanceof Error
                    ? error.message
                    : "Unable to export this meeting to Notion",
                );
              } finally {
                setIsExportingToNotion(false);
              }
            }}
            className="h-8 gap-1.5 text-xs"
          >
            <BookText className="h-3.5 w-3.5" />
            {isExportingToNotion ? "Exporting…" : "Export to Notion"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!notionExport?.externalUrl}
            className="h-8 gap-1.5 text-xs"
            onClick={() => {
              if (notionExport?.externalUrl) {
                window.open(notionExport.externalUrl, "_blank", "noopener,noreferrer");
              }
            }}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open in Notion
          </Button>
          {!notionConnection?.connected && (
            <p className="text-xs text-muted-foreground">
              Connect Notion from{" "}
              <a href="/integrations" className="underline underline-offset-2">
                Integrations
              </a>{" "}
              to export.
            </p>
          )}
          {notionConnection?.connected && !notionConnection.targetPageId && (
            <p className="text-xs text-muted-foreground">
              Choose a Notion parent page in{" "}
              <a href="/integrations" className="underline underline-offset-2">
                Integrations
              </a>
              .
            </p>
          )}
          {billing && !billing.features.notionExport && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Notion export is available on paid workspace plans.
            </p>
          )}
         
        </div>
      </div>

      {/* ── Main content — 2-col on large screens ── */}
      <div className="grid gap-4 lg:grid-cols-2">

        {/* LEFT: Transcript */}
        <div className="flex min-h-0 flex-col rounded-xl border border-border bg-card overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              Transcript
            </div>
            <Badge variant="secondary" className="rounded-full px-2.5 text-xs">
              {transcripts.length} messages
            </Badge>
          </div>

          {/* Transcript list */}
          <ScrollArea className="flex-1" style={{ height: "calc(100vh - 280px)", minHeight: "420px" }}>
            {transcripts.length === 0 ? (
              <div className="flex h-full items-center justify-center p-8">
                <EmptyState
                  title="No transcript yet"
                  description="Transcription will appear here once participants start speaking."
                />
              </div>
            ) : (
              <div className="flex flex-col gap-0 px-4 py-3">
                {transcripts.map((line, idx) => {
                  const prev = transcripts[idx - 1];
                  const isSame = prev?.speakerName === line.speakerName;
                  return (
                    <div
                      key={line._id}
                      className={`flex gap-3 ${isSame ? "mt-0.5" : "mt-4 first:mt-0"}`}
                    >
                      {!isSame ? (
                        <Avatar className="h-7 w-7 shrink-0 border border-border/50">
                          <AvatarFallback className="bg-primary/10 text-[11px] font-bold text-brand">
                            {line.speakerName.charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                      ) : (
                        <div className="w-7 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        {!isSame && (
                          <div className="mb-0.5 flex items-baseline gap-2">
                            <span className="text-[13px] font-semibold text-foreground">
                              {line.speakerName}
                            </span>
                            <span className="text-[11px] text-muted-foreground/60">
                              {new Date(line.timestamp).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          </div>
                        )}
                        <p className="text-[14px] leading-relaxed text-foreground/85">{line.text}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        </div>

        {/* RIGHT: Tabs — Summary / Recordings */}
        <div className="flex min-h-0 flex-col rounded-xl border border-border bg-card overflow-hidden">
          <Tabs defaultValue="summary" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="h-auto shrink-0 rounded-none border-b border-border bg-transparent px-3 pt-2 pb-0 justify-start gap-1">
              <TabsTrigger
                value="summary"
                className="rounded-t-lg rounded-b-none border-b-2 border-transparent px-3 py-2 text-sm data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
              >
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                AI Summary
              </TabsTrigger>
              <TabsTrigger
                value="recordings"
                className="rounded-t-lg rounded-b-none border-b-2 border-transparent px-3 py-2 text-sm data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
              >
                <Video className="mr-1.5 h-3.5 w-3.5" />
                Recordings
                {recordings.length > 0 && (
                  <Badge variant="secondary" className="ml-1.5 rounded-full px-1.5 text-[10px]">
                    {recordings.length}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>

            {/* Summary Tab */}
            <TabsContent value="summary" className="mt-0 flex-1 overflow-hidden">
              <ScrollArea style={{ height: "calc(100vh - 310px)", minHeight: "390px" }}>
                {!hasSummary ? (
                  <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
                    <div className="flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-border bg-muted/30">
                      <Sparkles className="h-5 w-5 text-muted-foreground/50" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">Summary pending</p>
                      <p className="mt-0.5 max-w-[200px] text-xs text-muted-foreground">
                        AI will generate a summary once enough context is available.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-5 px-4 py-4">
                    {/* Overview */}
                    {meeting.summary && (
                      <div>
                      
                        <div className="prose-sm max-w-none text-[14px] leading-relaxed text-foreground/85">
                          <ReactMarkdown
                            components={{
                              p: ({ node, ...props }: React.HTMLAttributes<HTMLParagraphElement> & { node?: unknown }) => (
                                <p className="mb-3 last:mb-0" {...props} />
                              ),
                              h2: ({ node, ...props }: React.HTMLAttributes<HTMLHeadingElement> & { node?: unknown }) => (
                                <h2 className="mb-2 mt-4 text-[11px] font-bold uppercase tracking-[0.15em] text-muted-foreground" {...props} />
                              ),
                              ul: ({ node, ...props }: React.HTMLAttributes<HTMLUListElement> & { node?: unknown }) => (
                                <ul className="mb-3 ml-3 list-disc space-y-1.5 text-foreground/85 marker:text-brand/70" {...props} />
                              ),
                              ol: ({ node, ...props }: React.HTMLAttributes<HTMLOListElement> & { node?: unknown }) => (
                                <ol className="mb-3 ml-3 list-decimal space-y-1.5 text-foreground/85" {...props} />
                              ),
                              li: ({ node, ...props }: React.HTMLAttributes<HTMLLIElement> & { node?: unknown }) => (
                                <li className="pl-0.5" {...props} />
                              ),
                              strong: ({ node, ...props }: React.HTMLAttributes<HTMLElement> & { node?: unknown }) => (
                                <strong className="font-semibold text-foreground" {...props} />
                              ),
                            }}
                          >
                            {meeting.summary}
                          </ReactMarkdown>
                        </div>
                      </div>
                    )}

                    {/* Key Points */}
                    {hasKeyPoints && (
                      <div>
                        <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
                          Key Points
                        </p>
                        <ul className="space-y-1.5">
                          {meeting.key_points!.map((point: string, i: number) => (
                            <li key={i} className="flex gap-2.5 text-[14px] text-foreground/85">
                              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
                              {point}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Decisions */}
                    {hasDecisions && (
                      <div>
                        <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
                          Decisions
                        </p>
                        <ul className="space-y-1.5">
                          {meeting.decisions!.map((dec: string, i: number) => (
                            <li key={i} className="flex gap-2.5 text-[14px] text-foreground/85">
                              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500/80" />
                              {dec}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Action Items */}
                    {hasActionItems && (
                      <div>
                        <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
                          Action Items
                        </p>
                        <div className="space-y-2">
                          {(meetingTasks.length > 0
                            ? meetingTasks.map((task) => ({
                                task: task.title,
                                assignee: task.assigneeName ?? null,
                                due: null,
                                status: task.status,
                              }))
                            : meeting.action_items!
                          ).map(
                            (
                              item: {
                                task: string;
                                assignee?: string | null;
                                due?: string | null;
                                status?: "open" | "in_progress" | "done";
                              },
                              i: number,
                            ) => (
                              <div
                                key={i}
                                className="rounded-lg border border-border bg-muted/20 px-3 py-2.5"
                              >
                                <p className="text-[14px] font-medium text-foreground/90">{item.task}</p>
                                {(item.assignee || item.due || item.status) && (
                                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                                    {item.status && (
                                      <Badge variant="outline" className="h-5 px-2 text-[11px]">
                                        {item.status.replace("_", " ")}
                                      </Badge>
                                    )}
                                    {item.assignee && (
                                      <Badge variant="secondary" className="h-5 px-2 text-[11px]">
                                        {item.assignee}
                                      </Badge>
                                    )}
                                    {item.due && (
                                      <Badge
                                        variant="outline"
                                        className="h-5 border-border/50 px-2 text-[11px] text-muted-foreground"
                                      >
                                        {item.due}
                                      </Badge>
                                    )}
                                  </div>
                                )}
                              </div>
                            ),
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </ScrollArea>
            </TabsContent>

            {/* Recordings Tab */}
            <TabsContent value="recordings" className="mt-0 flex-1 overflow-hidden">
              <ScrollArea style={{ height: "calc(100vh - 310px)", minHeight: "390px" }}>
                {recordings.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
                    <div className="flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-border bg-muted/30">
                      <Video className="h-5 w-5 text-muted-foreground/50" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">No recordings</p>
                      <p className="mt-0.5 max-w-[220px] text-xs text-muted-foreground">
                        When hosts record this meeting, entries will appear here.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3 px-4 py-4">
                    {recordings.map((recording) => (
                      <div
                        key={recording._id}
                        className="overflow-hidden rounded-lg border border-border bg-muted/10"
                      >
                        {/* Recording header */}
                        <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5">
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-semibold text-foreground">
                              {new Date(recording.startedAt).toLocaleString()}
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              {recording.durationMs
                                ? `${Math.round(recording.durationMs / 1000)}s`
                                : "Processing…"}
                            </p>
                          </div>
                          <Badge
                            variant={recording.status === "ready" ? "default" : "secondary"}
                            className="shrink-0 text-[10px] uppercase"
                          >
                            {recording.status}
                          </Badge>
                        </div>

                        {/* Video player */}
                        {recording.playbackUrl ? (
                          <div className="p-2">
                            <video
                              controls
                              src={recording.playbackUrl}
                              className="w-full aspect-video rounded-md border border-border"
                              onPlay={() => setActiveRecordingId(recording._id)}
                              onPause={() =>
                                setActiveRecordingId((cur) =>
                                  cur === recording._id ? null : cur,
                                )
                              }
                              onTimeUpdate={(e) => {
                                if (activeRecordingId !== recording._id) {
                                  setActiveRecordingId(recording._id);
                                }
                                setActiveRecordingTime(e.currentTarget.currentTime);
                              }}
                            />
                          </div>
                        ) : (
                          <p className="px-3 py-2 text-xs text-muted-foreground">
                            Processing — playback will be available shortly.
                          </p>
                        )}

                        {/* Synced transcript line */}
                        {activeRecordingId === recording._id && (
                          <div className="border-t border-border px-3 py-2">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                              Live Sync
                            </p>
                            <p className="mt-0.5 text-xs text-foreground/75">
                              {syncedTranscriptLine
                                ? `${syncedTranscriptLine.speakerName}: ${syncedTranscriptLine.text}`
                                : "No transcript line at this timestamp."}
                            </p>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
