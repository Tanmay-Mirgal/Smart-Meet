import { SignUp } from "@clerk/nextjs";
import { createMetadata } from "@/lib/metadata";
import { authAppearance } from "@/lib/clerk-appearance";

export const metadata = createMetadata({
  title: "Sign Up",
  description: "Create your free Meetup account and run your first AI-powered meeting in minutes.",
  path: "/sign-up",
  index: true,
});

export default function SignUpPage() {
  return <SignUp appearance={authAppearance} />;
}
