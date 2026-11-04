import { Navbar } from "@/components/home/navbar";
import { Hero } from "@/components/home/hero";
import { Features } from "@/components/home/features";
import { HowItWorks } from "@/components/home/how-it-works";
import { Languages } from "@/components/home/languages";
import { Pricing } from "@/components/home/pricing";
import { Faq, FAQ_ITEMS } from "@/components/home/faq";
import { Footer, FinalCta } from "@/components/home/footer";
import { createMetadata, faqJsonLd } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Meetup — AI Meeting Workspace: Live Transcription & Summaries",
  description:
    "Meetup is the AI meeting workspace: live video rooms, real-time Hindi, Marathi & English transcription, instant summaries and action items. Start free.",
  path: "/",
  absoluteTitle: true,
  keywords: [
    "free meeting transcription",
    "AI meeting notes India",
    "meeting recorder online",
    "meeting summary generator",
  ],
});

// Signed-in visitors are redirected to /dashboard by proxy.ts, so this page is fully static.
export default function HomePage() {
  return (
    <div className="relative flex min-h-screen flex-col overflow-x-clip">
      <a
        href="#main"
        className="sr-only z-[60] rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <Navbar />
      <main id="main" className="flex-1">
        <Hero />
        <Features />
        <HowItWorks />
        <Languages />
        <Pricing />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd(FAQ_ITEMS)) }}
      />
    </div>
  );
}
