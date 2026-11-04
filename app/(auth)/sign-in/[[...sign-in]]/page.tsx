import { SignIn } from "@clerk/nextjs";
import { createMetadata } from "@/lib/metadata";
import { authAppearance } from "@/lib/clerk-appearance";

export const metadata = createMetadata({
  title: "Sign In",
  description: "Sign in to your Meetup workspace — live meetings, transcripts, AI summaries and action items.",
  path: "/sign-in",
  index: true,
});

export default function SignInPage() {
  return <SignIn appearance={authAppearance} />;
}
