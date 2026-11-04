import { InsightsPage } from "@/features/ai/components/insights-page";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Insights",
  description: "Review AI-generated meeting analytics and workspace activity trends in Meetup.",
  path: "/insights",
  index: false,
});

export default function InsightsRoute() {
  return <InsightsPage />;
}
