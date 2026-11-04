import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MeetingPreview } from "@/components/home/meeting-preview";

function delay(ms: number) {
  return { "--delay": `${ms}ms` } as React.CSSProperties;
}

function HeroBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <div className="bg-dot-grid absolute inset-0 opacity-60" />
      <div className="animate-aurora absolute -top-40 left-1/2 h-[520px] w-[860px] -translate-x-1/2 rounded-full bg-primary/25 blur-[120px]" />
      <div className="animate-aurora absolute top-24 -right-24 h-[320px] w-[320px] rounded-full bg-warm/15 blur-[110px] [animation-delay:-8s]" />
      <div className="absolute inset-x-0 bottom-0 h-40 bg-linear-to-t from-background to-transparent" />
    </div>
  );
}

export function Hero() {
  return (
    <section className="relative isolate px-4 pt-32 pb-20 sm:px-6 lg:pt-40">
      <HeroBackdrop />

      <div className="mx-auto max-w-4xl text-center">
        <div
          className="animate-fade-up inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 py-1.5 pr-4 pl-1.5 text-xs font-medium text-foreground/90"
          style={delay(0)}
        >
          <span className="inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-semibold text-primary-foreground">
            <Sparkles className="size-3" />
            New
          </span>
          Live transcription in Hindi, Marathi &amp; English
        </div>

        <h1
          className="animate-fade-up mt-7 font-display text-[clamp(2.6rem,7.2vw,5.25rem)] leading-[1.02] font-extrabold tracking-[-0.045em] text-balance text-foreground"
          style={delay(80)}
        >
          Meetings that write <span className="text-brand-gradient">their own minutes.</span>
        </h1>

        <p
          className="animate-fade-up mx-auto mt-6 max-w-2xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg"
          style={delay(160)}
        >
          Meetup is the AI meeting workspace for modern teams — live video rooms, real-time
          transcription, instant summaries and action items that land on your board before anyone
          closes the tab.
        </p>

        <div
          className="animate-fade-up mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row"
          style={delay(240)}
        >
          <Button
            asChild
            className="h-12 w-full gap-2 rounded-xl bg-brand-gradient px-7 text-[15px] font-semibold text-white shadow-[0_10px_30px_-8px] shadow-primary/60 transition-all hover:-translate-y-0.5 hover:brightness-110 sm:w-auto"
          >
            <Link href="/sign-up">
              Start for free
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          <Button
            asChild
            variant="outline"
            className="h-12 w-full rounded-xl border-white/12 bg-white/[0.03] px-7 text-[15px] font-semibold text-foreground transition-all hover:-translate-y-0.5 hover:bg-white/[0.07] sm:w-auto"
          >
            <Link href="#how-it-works">See how it works</Link>
          </Button>
        </div>

        <p className="animate-fade-up mt-5 text-[13px] text-muted-foreground/80" style={delay(320)}>
          Free plan · No credit card · Runs in your browser, nothing to install
        </p>
      </div>

      <div className="animate-fade-up mx-auto mt-16 max-w-6xl" style={delay(420)}>
        <MeetingPreview />
      </div>
    </section>
  );
}
