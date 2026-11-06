import { IntegrationsPage } from "@/features/integrations/components/integrations-page";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Integrations",
  description: "Connect Meetup with your favourite tools — review organization integrations and connection status.",
  path: "/integrations",
  index: false,
});

export default function IntegrationsRoute() {
  // The "Connected apps" section only exists when the ecosystem connector is on.
  return <IntegrationsPage connectorEnabled={process.env.CONNECTOR_ENABLED === "true"} />;
}
