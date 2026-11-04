import { MeetingsPage } from "@/features/meeting/components/meetings-page";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Meetings",
  description: "Browse every scheduled, live, and completed meeting in your Meetup organization.",
  path: "/meetings",
  index: false,
});

export default function MeetingsRoute() {
  return <MeetingsPage />;
}
