import { TasksPage } from "@/features/tasks/components/tasks-page";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Tasks Board",
  description: "Track meeting follow-ups and action items from every Meetup session in real-time.",
  path: "/tasks",
  index: false,
});

export default function TasksRoute() {
  return <TasksPage />;
}
