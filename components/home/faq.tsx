import { ChevronDown } from "lucide-react";
import { SectionHeading } from "@/components/home/section-heading";
import { PRO_PRICE } from "@/lib/plans";

export const FAQ_ITEMS = [
  {
    question: "What is Meetup?",
    answer:
      "Meetup is an AI meeting workspace. You host live video meetings in the browser and Meetup transcribes the conversation in real time, then turns it into a summary, decisions, action items and minutes of meeting you can share.",
  },
  {
    question: "Which languages does live transcription support?",
    answer:
      "Hindi, Marathi and English, including conversations that mix them. You can pick a transcription mode for each meeting — Hindi + English, Hindi + Marathi + English, or a single language — or leave it on Auto.",
  },
  {
    question: "Do my participants need to install anything?",
    answer:
      "No. Meetings run in the browser using WebRTC. Invite people by email and they join from a link after signing in.",
  },
  {
    question: "Is Meetup free?",
    answer: `Yes — the Free plan includes up to 10 meetings, live rooms, team invitations, chat and a shared whiteboard. Pro is ₹${PRO_PRICE.inr} per month and adds unlimited meetings, AI summaries, action item tracking, minutes of meeting, recordings and integrations.`,
  },
  {
    question: "Can I export minutes and sync with my other tools?",
    answer:
      "Yes. Download or email minutes of meeting, sync scheduling with Google Calendar, and send summaries, decisions and action items to Notion.",
  },
  {
    question: "How is my workspace kept private?",
    answer:
      "Sign-in and organisations are handled by Clerk, every workspace is scoped to your organisation, and meetings can be limited to the people you invite.",
  },
] as const;

export function Faq() {
  return (
    <section id="faq" className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:py-20">
      <SectionHeading
        eyebrow="FAQ"
        title="Questions, answered"
        description="Can't find what you need? Create a free account and try it — it takes under a minute."
      />

      <div className="mt-12 flex flex-col gap-3">
        {FAQ_ITEMS.map((item) => (
          <details
            key={item.question}
            className="group rounded-2xl border border-white/[0.08] bg-card/50 transition-colors open:border-white/15 open:bg-card/80"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-5 py-4 text-left text-[15px] font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [&::-webkit-details-marker]:hidden">
              {item.question}
              <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
            </summary>
            <p className="px-5 pb-5 text-sm leading-relaxed text-muted-foreground">{item.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
