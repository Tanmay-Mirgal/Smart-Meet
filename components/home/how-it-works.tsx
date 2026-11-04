import { AudioLines, BrainCircuit, Send, Zap, type LucideIcon } from "lucide-react";
import { SectionHeading } from "@/components/home/section-heading";

const STEPS: ReadonlyArray<{
  icon: LucideIcon;
  title: string;
  description: string;
}> = [
  {
    icon: Zap,
    title: "Start a room",
    description: "Create an instant meeting or schedule one and invite your team by email.",
  },
  {
    icon: AudioLines,
    title: "Just talk",
    description: "Meetup transcribes each speaker live, in the language mode you pick.",
  },
  {
    icon: BrainCircuit,
    title: "Get the summary",
    description: "AI turns the transcript into key points, decisions and action items.",
  },
  {
    icon: Send,
    title: "Share and follow up",
    description: "Send minutes, push to Notion and track tasks until they're done.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-20">
      <SectionHeading
        eyebrow="How it works"
        title="From meeting to minutes in four steps"
        description="No bots to invite and nothing to install. Open a room and start talking."
      />

      <ol className="relative mt-14 grid gap-8 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
        <div
          className="pointer-events-none absolute top-7 right-[12.5%] left-[12.5%] hidden h-px bg-linear-to-r from-transparent via-white/15 to-transparent lg:block"
          aria-hidden="true"
        />
        {STEPS.map((step, index) => {
          const Icon = step.icon;
          return (
            <li key={step.title} className="relative flex flex-col items-start gap-4 lg:items-center lg:text-center">
              <div className="relative flex size-14 items-center justify-center rounded-2xl border border-primary/30 bg-background shadow-[0_0_30px_-8px] shadow-primary/50">
                <Icon className="size-6 text-brand" />
                <span className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
                  {index + 1}
                </span>
              </div>
              <div>
                <h3 className="font-display text-lg font-bold tracking-[-0.02em] text-foreground">
                  {step.title}
                </h3>
                <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-muted-foreground">
                  {step.description}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
