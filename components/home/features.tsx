import {
  AudioLines,
  BrainCircuit,
  CalendarDays,
  FileText,
  ListChecks,
  PenTool,
  type LucideIcon,
} from "lucide-react";
import { SectionHeading } from "@/components/home/section-heading";
import { cn } from "@/lib/utils";

interface Feature {
  icon: LucideIcon;
  title: string;
  description: string;
  span: string;
  tone: string;
  preview?: React.ReactNode;
}

const FEATURES: Feature[] = [
  {
    icon: AudioLines,
    title: "Transcription that understands how you talk",
    description:
      "Every word captured live — in Hindi, Marathi, English or all three in the same sentence. Searchable the moment it's spoken.",
    span: "md:col-span-7",
    tone: "bg-emerald-500/12 text-emerald-300",
    preview: (
      <div className="mt-6 flex flex-wrap gap-2" aria-hidden="true">
        {["हिन्दी", "मराठी", "English", "Hinglish"].map((label) => (
          <span
            key={label}
            className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-foreground/80"
          >
            {label}
          </span>
        ))}
      </div>
    ),
  },
  {
    icon: BrainCircuit,
    title: "Summaries with decisions, not just notes",
    description:
      "AI distils the conversation into key points, decisions and owners while the meeting is still fresh in everyone's mind.",
    span: "md:col-span-5",
    tone: "bg-violet-500/12 text-violet-300",
  },
  {
    icon: ListChecks,
    title: "Action items on a real board",
    description:
      "Follow-ups from the summary become tasks you can assign, move and close on a Kanban board.",
    span: "md:col-span-4",
    tone: "bg-amber-500/12 text-amber-300",
  },
  {
    icon: FileText,
    title: "Minutes of meeting, one click",
    description:
      "Download a clean minutes document or email it to attendees without retyping a thing.",
    span: "md:col-span-4",
    tone: "bg-sky-500/12 text-sky-300",
  },
  {
    icon: PenTool,
    title: "A room that's more than video",
    description:
      "Screen share, chat, live reactions and a shared whiteboard — all inside the browser tab.",
    span: "md:col-span-4",
    tone: "bg-rose-500/12 text-rose-300",
  },
  {
    icon: CalendarDays,
    title: "Fits the tools you already use",
    description:
      "Sync scheduling with Google Calendar and send summaries, decisions and action items to Notion — invitations include calendar files out of the box.",
    span: "md:col-span-12",
    tone: "bg-primary/15 text-brand",
  },
];

export function Features() {
  return (
    <section id="features" className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:py-32">
      <SectionHeading
        eyebrow="Everything in one room"
        title="From the first hello to the follow-up email"
        description="Meetup replaces the stack of tabs you juggle around every meeting — video, notes, tasks and minutes — with one workspace."
      />

      <div className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-12">
        {FEATURES.map((feature, index) => {
          const Icon = feature.icon;
          const isWide = index === FEATURES.length - 1;
          return (
            <article
              key={feature.title}
              className={cn(
                "group relative overflow-hidden rounded-3xl border border-white/[0.08] bg-card/60 p-6 transition-colors duration-300 hover:border-white/15 hover:bg-card/90 sm:p-7",
                feature.span,
                isWide && "md:flex md:items-center md:gap-6",
              )}
            >
              <div
                className={cn(
                  "mb-5 flex size-11 shrink-0 items-center justify-center rounded-2xl transition-transform duration-300 group-hover:scale-105",
                  isWide && "md:mb-0 md:size-14",
                  feature.tone,
                )}
              >
                <Icon className="size-5 md:size-[1.35rem]" />
              </div>
              <div>
                <h3 className="font-display text-lg font-bold tracking-[-0.02em] text-foreground">
                  {feature.title}
                </h3>
                <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
                  {feature.description}
                </p>
                {feature.preview}
              </div>
              <div
                className="pointer-events-none absolute -right-10 -bottom-10 size-36 rounded-full bg-primary/10 opacity-0 blur-3xl transition-opacity duration-500 group-hover:opacity-100"
                aria-hidden="true"
              />
            </article>
          );
        })}
      </div>
    </section>
  );
}
