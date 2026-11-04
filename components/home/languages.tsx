import { Check } from "lucide-react";
import { SectionHeading } from "@/components/home/section-heading";

const MODES = [
  { label: "Auto", hint: "Let Meetup pick up the language" },
  { label: "Hindi + English", hint: "Hinglish, the way teams really talk" },
  { label: "Hindi + Marathi + English", hint: "Code-switching across all three" },
  { label: "Hindi", hint: "Hindi only" },
  { label: "Marathi", hint: "Marathi only" },
  { label: "English", hint: "English only" },
] as const;

const SAMPLE = [
  { lang: "EN", text: "Can we ship the invoice export this sprint?" },
  { lang: "हि", text: "हाँ, backend तैयार है, बस UI बाकी है." },
  { lang: "मरा", text: "ठीक आहे, मी आज संध्याकाळपर्यंत review करतो." },
] as const;

export function Languages() {
  return (
    <section id="languages" className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:py-32">
      <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
        <div>
          <SectionHeading
            align="left"
            eyebrow="Languages"
            title={
              <>
                Built for how <span className="text-brand-gradient">India actually talks</span>
              </>
            }
            description="Pick a transcription mode per meeting — or leave it on Auto. Meetup keeps Hindi, Marathi and English in the script they were spoken in, so names and technical terms stay intact."
          />

          <ul className="mt-8 grid gap-2.5 sm:grid-cols-2">
            {MODES.map((mode) => (
              <li
                key={mode.label}
                className="flex items-start gap-3 rounded-2xl border border-white/[0.08] bg-card/50 px-4 py-3"
              >
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-brand">
                  <Check className="size-3" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-foreground">{mode.label}</span>
                  <span className="block text-xs text-muted-foreground">{mode.hint}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative" aria-hidden="true">
          <div className="pointer-events-none absolute -inset-6 -z-10 rounded-[3rem] bg-linear-to-br from-primary/20 to-warm/10 blur-3xl" />
          <div className="rounded-3xl border border-white/10 bg-card/80 p-5 shadow-2xl backdrop-blur-xl sm:p-6">
            <div className="mb-4 flex items-center justify-between">
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Mode · Hindi + Marathi + English
              </p>
              <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-300">
                <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
                Live
              </span>
            </div>
            <ul className="flex flex-col gap-3">
              {SAMPLE.map((line) => (
                <li key={line.lang} className="flex items-start gap-3 rounded-2xl bg-white/[0.04] p-3.5">
                  <span className="mt-0.5 shrink-0 rounded-md bg-primary/20 px-2 py-0.5 text-[11px] font-bold text-brand">
                    {line.lang}
                  </span>
                  <p className="text-[15px] leading-relaxed text-foreground/90">{line.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
