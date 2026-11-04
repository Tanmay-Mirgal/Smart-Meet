import { BillingPage } from "@/features/billing/components/billing-page";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Billing",
  description: "Manage your Meetup workspace billing, plan limits, and premium collaboration features.",
  path: "/billing",
  index: false,
});

export default function BillingRoute() {
  return <BillingPage />;
}
