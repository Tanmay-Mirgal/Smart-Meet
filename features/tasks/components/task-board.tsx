"use client";

import { CreatedViaBadge } from "@/features/connector/components/created-via-badge";
import { useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { CheckCircle2, Circle, Clock3, GripVertical, Loader2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type TaskStatus = "open" | "in_progress" | "done";

export type TaskMemberOption = {
  tokenIdentifier: string;
  name: string;
  email: string | null;
};

export type TaskRecord = {
  _id: Id<"tasks">;
  title: string;
  status: TaskStatus;
  source: "manual" | "summary";
  assigneeName?: string;
  assigneeTokenIdentifier?: string;
  suggestedAssigneeName?: string;
  completedAt?: number;
  completedByName?: string;
  createdAt: number;
  updatedAt?: number;
  /** Set when an ecosystem connector created the task. */
  createdVia?: "connector";
};

type TaskBoardProps = {
  tasks: TaskRecord[];
  members: TaskMemberOption[];
  emptyTitle: string;
  emptyDescription: string;
  onUpdateTask: (args: {
    taskId: Id<"tasks">;
    status: TaskStatus;
    assigneeTokenIdentifier?: string | null;
  }) => Promise<unknown>;
};

const UNASSIGNED_VALUE = "__unassigned__";

const STATUS_SECTIONS: Array<{
  key: TaskStatus;
  title: string;
  icon: typeof Circle;
  accentClass: string;
}> = [
  {
    key: "open",
    title: "Open",
    icon: Circle,
    accentClass: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  {
    key: "in_progress",
    title: "In Progress",
    icon: Clock3,
    accentClass: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  {
    key: "done",
    title: "Done",
    icon: CheckCircle2,
    accentClass: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
];

function formatTaskDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function sortTasks(tasks: TaskRecord[]) {
  return [...tasks].sort(
    (left, right) =>
      (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt),
  );
}

function formatMemberLabel(member: TaskMemberOption) {
  return member.email && member.email !== member.name
    ? `${member.name} · ${member.email}`
    : member.name;
}

export function TaskBoard({
  tasks,
  members,
  emptyTitle,
  emptyDescription,
  onUpdateTask,
}: TaskBoardProps) {
  const [savingTaskIds, setSavingTaskIds] = useState<string[]>([]);
  const [draggedTaskId, setDraggedTaskId] = useState<Id<"tasks"> | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<TaskStatus | null>(null);

  const handleUpdate = async (
    task: TaskRecord,
    next: {
      status?: TaskStatus;
      assigneeTokenIdentifier?: string | null;
    },
  ) => {
    const nextStatus = next.status ?? task.status;
    const nextAssigneeTokenIdentifier = Object.prototype.hasOwnProperty.call(
      next,
      "assigneeTokenIdentifier",
    )
      ? next.assigneeTokenIdentifier ?? null
      : undefined;

    setSavingTaskIds((current) =>
      current.includes(task._id) ? current : [...current, task._id],
    );

    try {
      await onUpdateTask({
        taskId: task._id,
        status: nextStatus,
        assigneeTokenIdentifier: nextAssigneeTokenIdentifier,
      });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to update task",
      );
    } finally {
      setSavingTaskIds((current) => current.filter((id) => id !== task._id));
    }
  };

  const handleStatusDrop = async (status: TaskStatus) => {
    if (!draggedTaskId) {
      return;
    }

    const task = tasks.find((candidate) => candidate._id === draggedTaskId);
    setDraggedTaskId(null);
    setDragOverStatus(null);

    if (!task || task.status === status) {
      return;
    }

    await handleUpdate(task, { status });
  };

  if (tasks.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border/70 bg-muted/10 px-5 py-8 text-center">
        <p className="text-sm font-medium text-foreground">{emptyTitle}</p>
        <p className="mt-1 text-sm text-muted-foreground">{emptyDescription}</p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      {STATUS_SECTIONS.map((section) => {
        const sectionTasks = sortTasks(
          tasks.filter((task) => task.status === section.key),
        );
        const StatusIcon = section.icon;

        return (
          <div
            key={section.key}
            className={cn(
              "rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm transition-colors",
              dragOverStatus === section.key && "border-primary/50 bg-primary/5",
            )}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOverStatus(section.key);
            }}
            onDragLeave={() => {
              setDragOverStatus((current) =>
                current === section.key ? null : current,
              );
            }}
            onDrop={(event) => {
              event.preventDefault();
              void handleStatusDrop(section.key);
            }}
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${section.accentClass}`}>
                  <StatusIcon className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {section.title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {sectionTasks.length} task{sectionTasks.length === 1 ? "" : "s"}
                  </p>
                </div>
              </div>
            </div>

            {sectionTasks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
                {draggedTaskId && dragOverStatus === section.key
                  ? "Drop task here"
                  : "No tasks here yet."}
              </div>
            ) : (
              <div className="space-y-3">
                {sectionTasks.map((task) => {
                  const isSaving = savingTaskIds.includes(task._id);
                  const isDone = task.status === "done";

                  return (
                    <div
                      key={task._id}
                      className={cn(
                        "rounded-xl border border-border/60 bg-background/90 p-4 transition-all",
                        draggedTaskId === task._id && "opacity-60 ring-1 ring-primary/40",
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <Checkbox
                          checked={isDone}
                          disabled={isSaving}
                          onCheckedChange={(checked) =>
                            void handleUpdate(task, {
                              status: checked === true ? "done" : "open",
                            })
                          }
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <p
                                className={cn(
                                  "font-medium text-foreground",
                                  isDone && "text-muted-foreground line-through",
                                )}
                              >
                                {task.title}
                              </p>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                                <span>
                                  Updated {formatTaskDate(task.updatedAt ?? task.createdAt)}
                                </span>
                                {task.createdVia === "connector" && <CreatedViaBadge />}
                                {task.source === "summary" ? (
                                  <span>From meeting summary</span>
                                ) : (
                                  <span>Manual task</span>
                                )}
                              </div>
                            </div>
                            <button
                              type="button"
                              draggable={!isSaving}
                              onDragStart={(event) => {
                                setDraggedTaskId(task._id);
                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData("text/plain", task._id);
                              }}
                              onDragEnd={() => {
                                setDraggedTaskId(null);
                                setDragOverStatus(null);
                              }}
                              className="cursor-grab rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:cursor-grabbing"
                              aria-label={`Drag ${task.title}`}
                            >
                              <GripVertical className="h-4 w-4" />
                            </button>
                          </div>

                          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <div className="flex items-center gap-1.5 rounded-full border border-border/70 px-2.5 py-1">
                              <UserRound className="h-3.5 w-3.5" />
                              <span>{task.assigneeName ?? "Unassigned"}</span>
                            </div>
                            {!task.assigneeName && task.suggestedAssigneeName ? (
                              <div className="rounded-full border border-dashed border-border/70 px-2.5 py-1">
                                AI suggested: {task.suggestedAssigneeName}
                              </div>
                            ) : null}
                            {task.completedAt ? (
                              <span>
                                Completed {formatTaskDate(task.completedAt)}
                                {task.completedByName ? ` by ${task.completedByName}` : ""}
                              </span>
                            ) : null}
                          </div>

                          <div className="mt-3 flex items-center gap-2">
                            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                              <UserRound className="h-3.5 w-3.5" />
                              Assign
                            </div>
                            <Select
                              disabled={isSaving}
                              value={task.assigneeTokenIdentifier ?? UNASSIGNED_VALUE}
                              onValueChange={(value) =>
                                void handleUpdate(task, {
                                  assigneeTokenIdentifier:
                                    value === UNASSIGNED_VALUE ? null : value,
                                })
                              }
                            >
                              <SelectTrigger size="sm" className="min-w-44">
                                <SelectValue placeholder="Select assignee" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={UNASSIGNED_VALUE}>Unassigned</SelectItem>
                                {members.map((member) => (
                                  <SelectItem
                                    key={member.tokenIdentifier}
                                    value={member.tokenIdentifier}
                                  >
                                    {formatMemberLabel(member)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                        {isSaving ? (
                          <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-muted-foreground" />
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
