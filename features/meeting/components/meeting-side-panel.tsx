"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import {
  CheckCircle2,
  Loader2,
  Lock,
  MoreHorizontal,
  RefreshCw,
  Settings2,
  Sparkles,
  Unlock,
  UserCheck,
  UserX,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/shared/empty-state";
import { useSyncOrganizationBilling } from "@/features/billing/hooks/use-sync-organization-billing";
import { billingService } from "@/features/billing/services/billing-service";
import {
  meetingService,
  summarizeTranscript,
  type MeetingSummaryResult,
} from "@/features/meeting/services/meeting-service";
import type {
  TranscriptLine,
  TranscriptionMode,
} from "@/features/ai/hooks/use-transcription";
import type {
  MeetingJoinMode,
  MeetingRole,
  MeetingSettings,
} from "@/features/meeting/types/meeting-types";

const DEFAULT_SETTINGS: MeetingSettings = {
  joinMode: "organization_only",
  allowScreenShare: true,
  allowWhiteboard: true,
  allowChat: true,
  allowReactions: true,
  allowRecording: true,
  allowParticipantsToUnmute: true,
  autoAdmitOrgUsers: true,
  lobbyEnabled: false,
};

function roleLabel(role: MeetingRole | undefined) {
  switch (role) {
    case "host":
      return "Host";
    case "co_host":
      return "Co-host";
    case "viewer":
      return "Viewer";
    default:
      return "Participant";
  }
}

function joinModeLabel(joinMode: MeetingJoinMode) {
  switch (joinMode) {
    case "organization_only":
      return "Organization only";
    case "invite_only":
      return "Invite only";
    case "ask_to_join":
      return "Ask to join";
    default:
      return "Anyone with link";
  }
}

function inviteStatusLabel(status: "pending" | "accepted" | "declined" | "expired" | "cancelled") {
  if (status === "accepted") return "Accepted";
  if (status === "declined") return "Declined";
  if (status === "expired") return "Expired";
  if (status === "cancelled") return "Cancelled";
  return "Pending";
}

function parseInviteEmails(value: string) {
  return [...new Set(
    value
      .split(/[,\s\n;]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  )];
}

function withoutNodeProp<T extends { node?: unknown }>(props: T) {
  const { node, ...rest } = props;
  void node;
  return rest;
}

export function MeetingSidePanel({
  meetingId,
  transcript,
  orgId,
  isActivelyTranscribing = false,
  transcriptionMode,
  onTranscriptionModeChange,
  settingsOpen = false,
  onSettingsOpenChange,
}: {
  meetingId: Id<"meetings">;
  transcript: TranscriptLine[];
  orgId: string;
  isActivelyTranscribing?: boolean;
  transcriptionMode: TranscriptionMode;
  onTranscriptionModeChange: (mode: TranscriptionMode) => void;
  settingsOpen?: boolean;
  onSettingsOpenChange?: (open: boolean) => void;
}) {
  useSyncOrganizationBilling(orgId);
  const sendMessage = useMutation(meetingService.sendMessage);
  const saveSummary = useMutation(meetingService.saveSummary);
  const createTasksFromSummary = useMutation(meetingService.createTasksFromSummary);
  const admitParticipant = useMutation(meetingService.admitParticipant);
  const bulkAdmitParticipants = useMutation(meetingService.bulkAdmitParticipants);
  const rejectParticipant = useMutation(meetingService.rejectParticipant);
  const updateParticipantRole = useMutation(meetingService.updateParticipantRole);
  const setParticipantAudio = useMutation(meetingService.setParticipantAudio);
  const removeParticipant = useMutation(meetingService.removeParticipant);
  const updateMeetingSettings = useMutation(meetingService.updateMeetingSettings);
  const inviteParticipants = useMutation(meetingService.inviteParticipants);
  const resendInvite = useMutation(meetingService.resendInvite);
  const cancelInvite = useMutation(meetingService.cancelInvite);
  const billing = useQuery(
    billingService.getOrganizationPlan,
    orgId ? { orgId } : "skip",
  );

  const meeting = useQuery(meetingService.getMeeting, { meetingId });
  const participants = useQuery(
    meetingService.listParticipants,
    meeting?.currentParticipant?.status === "joined" ? { meetingId } : "skip",
  ) ?? [];
  const waitingRoom = useQuery(
    meetingService.listWaitingRoom,
    meeting?.effectivePermissions?.canAdmitOthers ? { meetingId } : "skip",
  ) ?? [];
  const messages = useQuery(
    meetingService.listMessages,
    meeting?.currentParticipant?.status === "joined" ? { meetingId } : "skip",
  ) ?? [];
  const summaryAsset = useQuery(meetingService.getSummary, { meetingId });
  const meetingInvites = useQuery(
    meetingService.listInvites,
    meeting?.effectivePermissions?.canChangeSettings ? { meetingId } : "skip",
  ) ?? [];

  const [message, setMessage] = useState("");
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [structuredResult, setStructuredResult] = useState<MeetingSummaryResult | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<MeetingSettings>(DEFAULT_SETTINGS);
  const [lockDraft, setLockDraft] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [inviteEmailsInput, setInviteEmailsInput] = useState("");
  const [isInviting, setIsInviting] = useState(false);

  const handleSettingsOpenChange = onSettingsOpenChange ?? (() => {});

  useEffect(() => {
    if (!meeting?.settings) {
      return;
    }

    setSettingsDraft(meeting.settings);
    setLockDraft(Boolean(meeting.isLocked));
  }, [meeting?.isLocked, meeting?.settings]);

  const transcriptPayload = useMemo(
    () =>
      transcript
        .filter((line) => !line.isInterim)
        .map((line) => ({ sender: line.sender, text: line.text })),
    [transcript],
  );

  const canSendChat = Boolean(meeting?.effectivePermissions?.canSendChat);
  const canManageParticipants = Boolean(meeting?.effectivePermissions?.canAdmitOthers);
  const canManageRoles = Boolean(meeting?.effectivePermissions?.canManageRoles);
  const canMuteOthers = Boolean(meeting?.effectivePermissions?.canMuteOthers);
  const canRemoveParticipants = Boolean(meeting?.effectivePermissions?.canRemoveParticipants);
  const canChangeSettings = Boolean(meeting?.effectivePermissions?.canChangeSettings);
  const selfParticipantId = meeting?.currentParticipant?._id ?? null;

  const handleSendMessage = async () => {
    if (!message.trim()) return;
    try {
      await sendMessage({ meetingId, body: message.trim() });
      setMessage("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to send message");
    }
  };

  const handleGenerateSummary = async () => {
    if (transcriptPayload.length === 0) {
      toast.error("Wait for transcript data before generating a summary");
      return;
    }

    setIsSummarizing(true);
    try {
      const result = await summarizeTranscript(transcriptPayload);
      setStructuredResult(result);
      await saveSummary({
        meetingId,
        summary: result.summary,
        key_points: result.key_points,
        decisions: result.decisions,
        action_items: result.action_items,
      });

      if (result.action_items.length > 0) {
        await createTasksFromSummary({
          orgId,
          meetingId,
          actionItems: result.action_items.map((item) => ({
            title: item.task,
            assigneeName: item.assignee,
          })),
        });
        toast.success(`Summary saved · ${result.action_items.length} task(s) created`);
      } else {
        toast.success("Summary saved");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to summarize meeting");
    } finally {
      setIsSummarizing(false);
    }
  };

  const handleParticipantMutation = async (
    action: () => Promise<unknown>,
    successMessage: string,
  ) => {
    try {
      await action();
      toast.success(successMessage);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update participant");
    }
  };

  const handleSaveSettings = async () => {
    setIsSavingSettings(true);
    try {
      await updateMeetingSettings({
        meetingId,
        settings: settingsDraft,
        isLocked: lockDraft,
      });
      handleSettingsOpenChange(false);
      toast.success("Meeting settings updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save settings");
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleInviteParticipants = async () => {
    const emails = parseInviteEmails(inviteEmailsInput);
    if (emails.length === 0) {
      toast.error("Add at least one valid email");
      return;
    }

    setIsInviting(true);
    try {
      const inserted = await inviteParticipants({
        meetingId,
        emails,
      });
      setInviteEmailsInput("");
      if (inserted.length === 0) {
        toast.message("No new invites were added");
      } else {
        toast.success(`${inserted.length} invite(s) sent`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to send invites");
    } finally {
      setIsInviting(false);
    }
  };

  const displaySummary = structuredResult?.summary ?? summaryAsset?.content ?? null;
  const keyPoints = structuredResult?.key_points ?? [];
  const decisions = structuredResult?.decisions ?? [];
  const actionItems = structuredResult?.action_items ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <Tabs defaultValue="chat" className="flex h-full min-h-0 flex-col gap-0">
        <div className="border-b border-border p-3">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="chat">Chat</TabsTrigger>
            <TabsTrigger value="ai">AI</TabsTrigger>
            <TabsTrigger value="people">People</TabsTrigger>
            <TabsTrigger value="transcript">Transcript</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="chat" className="mt-0 flex min-h-0 flex-1 flex-col p-4">
          <ScrollArea className="min-h-0 flex-1 pr-3">
            <div className="space-y-3">
              {messages.length === 0 ? (
                <EmptyState title="No messages yet" description="Chat is live for everyone in the room." />
              ) : (
                messages
                  .slice()
                  .reverse()
                  .map((entry) => (
                    <div key={entry._id} className="rounded-lg border border-border px-3 py-2">
                      <p className="text-xs text-muted-foreground">{entry.senderName}</p>
                      <p className="mt-1 text-sm text-foreground">{entry.body}</p>
                    </div>
                  ))
              )}
            </div>
          </ScrollArea>
          <div className="mt-4 flex gap-2">
            <Input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={canSendChat ? "Send a message..." : "Chat is disabled"}
              onKeyDown={(e) => e.key === "Enter" && void handleSendMessage()}
              disabled={!canSendChat}
            />
            <Button onClick={() => void handleSendMessage()} disabled={!canSendChat}>
              Send
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="ai" className="mt-0 flex min-h-0 flex-1 flex-col gap-3 p-4">
          <Button
            onClick={() => void handleGenerateSummary()}
            disabled={isSummarizing || billing?.features.aiSummary === false}
            className="w-full gap-2"
            variant={displaySummary ? "outline" : "default"}
          >
            {isSummarizing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                AI is generating summary...
              </>
            ) : displaySummary ? (
              <>
                <RefreshCw className="h-4 w-4" />
                Regenerate summary
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                Generate summary
              </>
            )}
          </Button>

          {billing?.features.aiSummary === false ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              AI summaries are available on paid workspace plans.
            </p>
          ) : null}

          <ScrollArea className="min-h-0 flex-1">
            {!displaySummary && !isSummarizing ? (
              <EmptyState
                title="No summary yet"
                description="Generate a summary to see key points, decisions, and action items."
              />
            ) : isSummarizing ? (
              <div className="flex flex-col items-center gap-3 pt-10 text-center text-sm text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin text-brand" />
                <p>Analyzing transcript...</p>
              </div>
            ) : (
              <div className="space-y-5 pr-2 text-sm">
                {displaySummary ? (
                  <div>
                    {/* <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Overview
                    </p> */}
                    <ReactMarkdown
                      components={{
                        h1: (props) => (
                          <h1 className="mb-3 text-lg font-semibold text-foreground" {...withoutNodeProp(props)} />
                        ),
                        h2: (props) => (
                          <h2 className="mb-2 mt-4 text-sm font-semibold text-foreground" {...withoutNodeProp(props)} />
                        ),
                        h3: (props) => (
                          <h3 className="mb-1.5 mt-3 text-sm font-semibold text-foreground" {...withoutNodeProp(props)} />
                        ),
                        p: (props) => (
                          <p
                            className="mb-2 whitespace-pre-wrap leading-relaxed text-foreground last:mb-0"
                            {...withoutNodeProp(props)}
                          />
                        ),
                        ul: (props) => (
                          <ul className="mb-2 list-disc space-y-1.5 pl-5 text-foreground" {...withoutNodeProp(props)} />
                        ),
                        ol: (props) => (
                          <ol className="mb-2 list-decimal space-y-1.5 pl-5 text-foreground" {...withoutNodeProp(props)} />
                        ),
                        li: (props) => <li className="leading-relaxed" {...withoutNodeProp(props)} />,
                        strong: (props) => (
                          <strong className="font-semibold text-foreground" {...withoutNodeProp(props)} />
                        ),
                      }}
                    >
                      {displaySummary}
                    </ReactMarkdown>
                  </div>
                ) : null}

                {keyPoints.length > 0 ? (
                  <div>
                    <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Key Points
                    </p>
                    <ul className="space-y-1.5">
                      {keyPoints.map((point, index) => (
                        <li key={index} className="flex gap-2 text-foreground">
                          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                          {point}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {decisions.length > 0 ? (
                  <div>
                    <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Decisions
                    </p>
                    <ul className="space-y-1.5">
                      {decisions.map((decision, index) => (
                        <li key={index} className="flex gap-2 text-foreground">
                          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-500" />
                          {decision}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {actionItems.length > 0 ? (
                  <div>
                    <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Action Items
                    </p>
                    {/* LEFT COLUMN — Join Mode + Toggles */}
                    <div className="space-y-4">
                      {actionItems.map((item, index) => (
                        <div
                          key={index}
                          className="rounded-md border border-border bg-background px-3 py-2"
                        >
                          <p className="font-medium text-foreground">{item.task}</p>
                          <div className="mt-1 flex flex-wrap gap-2">
                            {item.assignee ? (
                              <Badge variant="secondary" className="text-xs">
                                {item.assignee}
                              </Badge>
                            ) : null}
                            {item.due ? (
                              <Badge variant="outline" className="text-xs text-muted-foreground">
                                {item.due}
                              </Badge>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </ScrollArea>
        </TabsContent>

        <TabsContent value="people" className="mt-0 min-h-0 flex-1 p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-foreground">
                {participants.length} participant{participants.length === 1 ? "" : "s"}
              </p>
              <p className="text-xs text-muted-foreground">
                Join mode: {joinModeLabel(meeting?.settings?.joinMode ?? "organization_only")}
              </p>
            </div>
          </div>

          <ScrollArea className="h-full pr-3">
            <div className="space-y-4">
              {canManageParticipants && waitingRoom.length > 0 ? (
                <div className="space-y-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">Waiting room</p>
                      <p className="text-xs text-muted-foreground">
                        {waitingRoom.length} request{waitingRoom.length === 1 ? "" : "s"} pending
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        void handleParticipantMutation(
                          () =>
                            bulkAdmitParticipants({
                              meetingId,
                              participantIds: waitingRoom.map((participant) => participant._id),
                            }),
                          "Waiting room admitted",
                        )
                      }
                    >
                      Admit all
                    </Button>
                  </div>

                  {waitingRoom.map((participant) => (
                    <div
                      key={participant._id}
                      className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2"
                    >
                      <div>
                        <p className="text-sm font-medium text-foreground">{participant.name}</p>
                        <p className="text-xs text-muted-foreground">{roleLabel(participant.role)}</p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void handleParticipantMutation(
                              () => admitParticipant({ meetingId, participantId: participant._id }),
                              `${participant.name} admitted`,
                            )
                          }
                        >
                          Admit
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() =>
                            void handleParticipantMutation(
                              () => rejectParticipant({ meetingId, participantId: participant._id }),
                              `${participant.name} rejected`,
                            )
                          }
                        >
                          Reject
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="space-y-2">
                {participants.map((participant) => {
                  const canManageThisParticipant =
                    participant._id !== selfParticipantId &&
                    participant.role !== "host" &&
                    (canManageRoles || canMuteOthers || canRemoveParticipants);

                  return (
                    <div
                      key={participant._id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium text-foreground">{participant.name}</p>
                          <Badge variant={participant.role === "host" ? "default" : "secondary"} className="text-[10px]">
                            {roleLabel(participant.role)}
                          </Badge>
                          {participant.isScreenSharing ? (
                            <Badge variant="outline" className="text-[10px]">
                              Presenting
                            </Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {participant.isMicEnabled ? "Mic on" : "Mic off"} · {participant.isCameraEnabled ? "Camera on" : "Camera off"}
                        </p>
                      </div>

                      {canManageThisParticipant ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="icon-sm" variant="ghost">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel>{participant.name}</DropdownMenuLabel>
                            {canManageRoles ? (
                              <>
                                {participant.role !== "co_host" ? (
                                  <DropdownMenuItem
                                    onClick={() =>
                                      void handleParticipantMutation(
                                        () =>
                                          updateParticipantRole({
                                            meetingId,
                                            participantId: participant._id,
                                            role: "co_host",
                                          }),
                                        `${participant.name} is now a co-host`,
                                      )
                                    }
                                  >
                                    <UserCheck className="h-4 w-4" />
                                    Make co-host
                                  </DropdownMenuItem>
                                ) : null}
                                {participant.role !== "participant" ? (
                                  <DropdownMenuItem
                                    onClick={() =>
                                      void handleParticipantMutation(
                                        () =>
                                          updateParticipantRole({
                                            meetingId,
                                            participantId: participant._id,
                                            role: "participant",
                                          }),
                                        `${participant.name} is now a participant`,
                                      )
                                    }
                                  >
                                    <UserCheck className="h-4 w-4" />
                                    Make participant
                                  </DropdownMenuItem>
                                ) : null}
                                {participant.role !== "viewer" ? (
                                  <DropdownMenuItem
                                    onClick={() =>
                                      void handleParticipantMutation(
                                        () =>
                                          updateParticipantRole({
                                            meetingId,
                                            participantId: participant._id,
                                            role: "viewer",
                                          }),
                                        `${participant.name} is now a viewer`,
                                      )
                                    }
                                  >
                                    <UserCheck className="h-4 w-4" />
                                    Make viewer
                                  </DropdownMenuItem>
                                ) : null}
                              </>
                            ) : null}

                            {canMuteOthers ? (
                              <DropdownMenuItem
                                onClick={() =>
                                  void handleParticipantMutation(
                                    () =>
                                      setParticipantAudio({
                                        meetingId,
                                        participantId: participant._id,
                                        isMicEnabled: !participant.isMicEnabled,
                                      }),
                                    participant.isMicEnabled
                                      ? `${participant.name} muted`
                                      : `${participant.name} unmuted`,
                                  )
                                }
                              >
                                {participant.isMicEnabled ? (
                                  <VolumeX className="h-4 w-4" />
                                ) : (
                                  <Volume2 className="h-4 w-4" />
                                )}
                                {participant.isMicEnabled ? "Mute participant" : "Unmute participant"}
                              </DropdownMenuItem>
                            ) : null}

                            {canRemoveParticipants ? (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() =>
                                    void handleParticipantMutation(
                                      () => removeParticipant({ meetingId, participantId: participant._id }),
                                      `${participant.name} removed`,
                                    )
                                  }
                                >
                                  <UserX className="h-4 w-4" />
                                  Remove from meeting
                                </DropdownMenuItem>
                              </>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="transcript" className="mt-0 flex h-full min-h-0 flex-1 flex-col p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Transcription Mode
              </p>
              <p className="text-xs text-muted-foreground">
                Use `Hindi + English` for Hinglish speech.
              </p>
            </div>
            <Select
              value={transcriptionMode}
              onValueChange={(value) =>
                onTranscriptionModeChange(value as TranscriptionMode)
              }
            >
              <SelectTrigger className="min-w-36" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="hinglish">Hindi + English</SelectItem>
                <SelectItem value="hindi">Hindi</SelectItem>
                <SelectItem value="english">English</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <ScrollArea className="min-h-0 flex-1 pr-3">
            <div className="space-y-2">
              {transcript.length === 0 ? (
                isActivelyTranscribing ? (
                  <div className="flex flex-col items-center gap-2 pt-8 text-center text-sm text-muted-foreground">
                    <span className="relative flex h-3 w-3">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                      <span className="relative inline-flex h-3 w-3 rounded-full bg-green-500" />
                    </span>
                    <p className="font-medium text-foreground">Listening...</p>
                    <p className="max-w-xs text-xs">
                      Start speaking clearly. Text will appear here as soon as words are detected.
                    </p>
                  </div>
                ) : (
                  <EmptyState title="Transcript empty" description="Unmute your mic and start speaking to stream transcript updates." />
                )
              ) : (
                transcript.map((line) => (
                  <div
                    key={line.id}
                    className={`rounded-md border px-3 py-2 transition-opacity ${
                      line.isInterim ? "border-border/50 opacity-60 italic" : "border-border"
                    }`}
                  >
                    <p className="text-xs text-muted-foreground">{line.sender}</p>
                    <p className="mt-0.5 text-sm text-foreground">{line.text}</p>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>

      {/* Settings Dialog — rendered outside Tabs so it works regardless of active tab */}
      {canChangeSettings ? (
        <Dialog open={settingsOpen} onOpenChange={handleSettingsOpenChange}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Meeting settings</DialogTitle>
              <DialogDescription>
                Control access, lobby behavior, and participant privileges.
              </DialogDescription>
            </DialogHeader>

            <Tabs defaultValue="settings" className="mt-2">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="settings">
                  <Settings2 className="mr-1.5 h-3.5 w-3.5" />
                  Settings
                </TabsTrigger>
                <TabsTrigger value="invite">
                  <UserCheck className="mr-1.5 h-3.5 w-3.5" />
                  Invite
                </TabsTrigger>
              </TabsList>

              {/* ── Settings Tab ── */}
              <TabsContent value="settings" className="mt-4 space-y-5">
                {/* Join Mode */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Join Mode
                  </p>
                  <Select
                    value={settingsDraft.joinMode}
                    onValueChange={(value) =>
                      setSettingsDraft((current) => ({
                        ...current,
                        joinMode: value as MeetingJoinMode,
                      }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="organization_only">Organization only</SelectItem>
                      <SelectItem value="invite_only">Invite only</SelectItem>
                      <SelectItem value="anyone_with_link">Anyone with link</SelectItem>
                      <SelectItem value="ask_to_join">Ask to join</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Permission Toggles */}
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Permissions
                  </p>
                  <div className="rounded-lg border border-border divide-y divide-border">
                    {[
                      ["allowScreenShare", "Allow screen share"],
                      ["allowWhiteboard", "Allow whiteboard"],
                      ["allowChat", "Allow chat"],
                      ["allowReactions", "Allow reactions"],
                      ["allowRecording", "Allow recording"],
                      ["allowParticipantsToUnmute", "Allow participants to unmute"],
                      ["autoAdmitOrgUsers", "Auto-admit org users"],
                      ["lobbyEnabled", "Enable lobby"],
                    ].map(([field, label]) => (
                      <div key={field} className="flex items-center justify-between gap-3 px-3 py-2.5">
                        <p className="text-sm text-foreground">{label}</p>
                        <Switch
                          checked={settingsDraft[field as keyof MeetingSettings] as boolean}
                          onCheckedChange={(checked) =>
                            setSettingsDraft((current) => ({
                              ...current,
                              [field]: checked,
                            }))
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {/* Lock Meeting */}
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    {lockDraft ? <Lock className="h-4 w-4 text-destructive" /> : <Unlock className="h-4 w-4 text-muted-foreground" />}
                    <p className="text-sm text-foreground">Lock meeting</p>
                  </div>
                  <Switch checked={lockDraft} onCheckedChange={setLockDraft} />
                </div>
              </TabsContent>

              {/* ── Invite Tab ── */}
              <TabsContent value="invite" className="mt-4 space-y-4">
                <p className="text-xs text-muted-foreground">
                  Add emails to invite participants to this meeting.
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    value={inviteEmailsInput}
                    onChange={(event) => setInviteEmailsInput(event.target.value)}
                    placeholder="alex@company.com, sam@company.com"
                  />
                  <Button
                    size="sm"
                    onClick={() => void handleInviteParticipants()}
                    disabled={isInviting}
                  >
                    {isInviting ? "Inviting..." : "Invite"}
                  </Button>
                </div>

                <ScrollArea className="h-52 rounded-md border border-border/60 p-2">
                  <div className="space-y-2">
                    {meetingInvites.length === 0 ? (
                      <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                        No invites yet.
                      </p>
                    ) : (
                      meetingInvites.map((invite) => (
                        <div
                          key={invite._id}
                          className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">
                              {invite.email}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {roleLabel(invite.role)} · {inviteStatusLabel(invite.resolvedStatus)}
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {invite.resolvedStatus !== "accepted" && invite.resolvedStatus !== "cancelled" ? (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    void handleParticipantMutation(
                                      () =>
                                        resendInvite({
                                          meetingId,
                                          inviteId: invite._id,
                                        }),
                                      "Invite resent",
                                    )
                                  }
                                >
                                  Resend
                                </Button>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  onClick={() =>
                                    void handleParticipantMutation(
                                      () =>
                                        cancelInvite({
                                          meetingId,
                                          inviteId: invite._id,
                                        }),
                                      "Invite cancelled",
                                    )
                                  }
                                >
                                  Cancel
                                </Button>
                              </>
                            ) : null}
                            {invite.resolvedStatus === "accepted" ? (
                              <Badge variant="secondary" className="text-[10px]">
                                Accepted
                              </Badge>
                            ) : null}
                            {invite.resolvedStatus === "cancelled" ? (
                              <Badge variant="outline" className="text-[10px]">
                                Cancelled
                              </Badge>
                            ) : null}
                            {invite.resolvedStatus === "expired" ? (
                              <Badge variant="outline" className="text-[10px]">
                                Expired
                              </Badge>
                            ) : null}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </ScrollArea>
              </TabsContent>
            </Tabs>

            <DialogFooter>
              <Button onClick={() => void handleSaveSettings()} disabled={isSavingSettings}>
                {isSavingSettings ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving
                  </>
                ) : (
                  "Save changes"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
