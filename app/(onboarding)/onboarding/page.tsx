import React from 'react';
import { OnboardingFlow } from '@/components/onboarding/onboarding-flow';
import { createMetadata } from '@/lib/metadata';

export const metadata = createMetadata({
  title: "Onboarding",
  description: "Set up your organization and configure your Meetup workspace.",
  path: "/onboarding",
  index: false,
});

export default function OnboardingPage() {
  return <OnboardingFlow />;
}
