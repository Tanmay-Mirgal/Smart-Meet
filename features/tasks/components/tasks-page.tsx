"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useOrganization } from "@clerk/nextjs";
import { KanbanSquare, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadingBlock } from "@/components/shared/loading-block";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TaskBoard } from "@/features/tasks/components/task-board";
import { taskService } from "@/features/tasks/services/task-service";
import { PageHeader, HeaderStat } from "@/components/shared/page-header";

const UNASSIGNED_VALUE = "__unassigned__";

export function TasksPage() {
  const { organization } = useOrganization();
  const createTask = useMutation(taskService.createTask);
  const updateTask = useMutation(taskService.updateTask);
  const openTasks = useQuery(
    taskService.listTasks,
    organization?.id ? { orgId: organization.id, status: "open" } : "skip",
  );
  const inProgressTasks = useQuery(
    taskService.listTasks,
    organization?.id ? { orgId: organization.id, status: "in_progress" } : "skip",
  );
  const doneTasks = useQuery(
    taskService.listTasks,
    organization?.id ? { orgId: organization.id, status: "done" } : "skip",
  );
  const members = useQuery(
    taskService.listOrgMembers,
    organization?.id ? { orgId: organization.id } : "skip",
  );
  const [title, setTitle] = useState("");
  const [assigneeTokenIdentifier, setAssigneeTokenIdentifier] = useState(UNASSIGNED_VALUE);

  if (
    openTasks === undefined
    || inProgressTasks === undefined
    || doneTasks === undefined
    || members === undefined
  ) {
    return <LoadingBlock className="h-72 w-full" />;
  }

  const tasks = [...openTasks, ...inProgressTasks, ...doneTasks];

  const handleCreateTask = async () => {
    if (!organization || !title.trim()) {
      return;
    }

    try {
      await createTask({
        orgId: organization.id,
        title: title.trim(),
        assigneeTokenIdentifier:
          assigneeTokenIdentifier === UNASSIGNED_VALUE
            ? undefined
            : assigneeTokenIdentifier,
      });
      setTitle("");
      setAssigneeTokenIdentifier(UNASSIGNED_VALUE);
      toast.success("Task created");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to create task",
      );
    }
  };

  return (
    <div className="space-y-8">
      <PageHeader
        icon={KanbanSquare}
        eyebrow="Workflow board"
        title="Tasks Board"
        description="Track AI-created and manual follow-ups in a Kanban board, assign ownership, and move work from open to done."
      >
        <HeaderStat icon={KanbanSquare} value={tasks.length} label="Total tasks" />
      </PageHeader>

      <Card className="border-border/60 shadow-sm">
        <CardHeader>
          <CardTitle>Create task</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_auto]">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Follow up with the design team"
          />
          <Select
            value={assigneeTokenIdentifier}
            onValueChange={setAssigneeTokenIdentifier}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Assign member" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNASSIGNED_VALUE}>Unassigned</SelectItem>
              {members.map((member) => (
                <SelectItem
                  key={member.tokenIdentifier}
                  value={member.tokenIdentifier}
                >
                  {member.email && member.email !== member.name
                    ? `${member.name} · ${member.email}`
                    : member.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={handleCreateTask}>
            <Plus className="h-4 w-4" />
            Add task
          </Button>
        </CardContent>
      </Card>

      <Card className="border-border/60 shadow-sm">
        <CardHeader>
          <CardTitle>Kanban board</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {tasks.length === 0 ? (
            <EmptyState
              title="No tasks yet"
              description="Tasks will appear here as your team captures follow-ups."
            />
          ) : (
            <TaskBoard
              tasks={tasks}
              members={members}
              emptyTitle="No tasks yet"
              emptyDescription="Tasks will appear here as your team captures follow-ups."
              onUpdateTask={updateTask}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
