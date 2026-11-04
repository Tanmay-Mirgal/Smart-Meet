import {
  CheckCircle2,
  Hand,
  Languages,
  Mic,
  MonitorUp,
  PhoneOff,
  Sparkles,
  Video,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Decorative product preview for the hero. Everything here is sample content
 * drawn with plain markup, so it adds no JavaScript and no images.
 */

const PARTICIPANTS = [
  { name: "Aarav", initials: "AM", tone: "from-violet-500/50 to-indigo-700/60", speaking: true },
  { name: "Priya", initials: "PS", tone: "from-fuchsia-500/40 to-purple-800/60", speaking: false },
  { name: "Rohan", initials: "RK", tone: "from-sky-500/40 to-indigo-800/60", speaking: false },
  { name: "Ishita", initials: "IP", tone: "from-orange-400/40 to-rose-700/60", speaking: false },
] as const;

const TRANSCRIPT = [
  {
    who: "Aarav",
    time: "00:41",
    lang: "EN",
    text: "Let's lock the launch for Friday — design sign-off is done.",
  },
  {
    who: "Priya",
    time: "00:52",
    lang: "हि",
    text: "ठीक है, मैं QA आज शाम तक complete कर देती हूँ.",
  },
  {
    who: "Rohan",
    time: "01:07",
    lang: "मरा",
    text: "आपण उद्या सकाळी demo तयार करूया.",
  },
] as const;

function SpeakingBars() {
  return (
    <span className="flex h-3 items-end gap-0.5" aria-hidden="true">
      {[0, 120, 240, 80].map((delay) => (
        <span
          key={delay}
          className="animate-wave-bar h-3 w-0.5 rounded-full bg-emerald-400"
          style={{ "--delay": `${delay}ms` } as React.CSSProperties}
        />
      ))}
    </span>
  );
}

export function MeetingPreview({ className }: { className?: string }) {
  return (
    <div className={cn("relative", className)} aria-hidden="true">
      {/* soft glow behind the window */}
      <div className="pointer-events-none absolute -inset-x-6 -inset-y-8 -z-10 rounded-[3rem] bg-linear-to-b from-primary/25 via-primary/10 to-transparent blur-3xl" />

      <div className="overflow-hidden rounded-3xl border border-white/10 bg-card/80 shadow-[0_40px_100px_-30px_rgb(0_0_0/0.8)] ring-1 ring-white/5 backdrop-blur-xl">
        {/* window chrome */}
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="hidden gap-1.5 sm:flex">
              <span className="size-2.5 rounded-full bg-white/15" />
              <span className="size-2.5 rounded-full bg-white/15" />
              <span className="size-2.5 rounded-full bg-white/15" />
            </div>
            <p className="truncate text-[13px] font-semibold text-foreground">Product sync · Sprint 14</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/15 px-2.5 py-1 text-[11px] font-semibold text-rose-300">
              <span className="size-1.5 animate-pulse rounded-full bg-rose-400" />
              REC 12:48
            </span>
            <span className="hidden items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-300 sm:inline-flex">
              <Languages className="size-3" />
              हि · मरा · EN
            </span>
          </div>
        </div>

        <div className="grid gap-0 lg:grid-cols-[1.35fr_1fr]">
          {/* video stage */}
          <div className="flex flex-col gap-3 p-3 sm:p-4">
            <div className="grid grid-cols-2 gap-2.5 sm:gap-3">
              {PARTICIPANTS.map((p) => (
                <div
                  key={p.name}
                  className={cn(
                    "relative flex aspect-[16/10] items-center justify-center overflow-hidden rounded-2xl bg-linear-to-br",
                    p.tone,
                    p.speaking && "ring-2 ring-emerald-400/70",
                  )}
                >
                  <div className="flex size-12 items-center justify-center rounded-full bg-white/15 font-display text-sm font-bold text-white backdrop-blur sm:size-14 sm:text-base">
                    {p.initials}
                  </div>
                  <div className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-full bg-black/45 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">
                    {p.speaking ? <SpeakingBars /> : <Mic className="size-3 text-white/70" />}
                    {p.name}
                  </div>
                </div>
              ))}
            </div>

            {/* controls */}
            <div className="mx-auto flex items-center gap-2 rounded-full border border-white/10 bg-black/30 p-1.5">
              {[Mic, Video, MonitorUp, Hand].map((Icon, index) => (
                <span
                  key={index}
                  className="flex size-9 items-center justify-center rounded-full bg-white/[0.07] text-white/80"
                >
                  <Icon className="size-4" />
                </span>
              ))}
              <span className="flex h-9 items-center gap-1.5 rounded-full bg-rose-500 px-4 text-xs font-semibold text-white">
                <PhoneOff className="size-3.5" />
                Leave
              </span>
            </div>
          </div>

          {/* transcript + summary */}
          <div className="flex flex-col gap-3 border-t border-white/[0.07] p-3 sm:p-4 lg:border-t-0 lg:border-l">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Live transcript
              </p>
              <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-300">
                <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
                Listening
              </span>
            </div>

            <ul className="flex flex-col gap-2.5">
              {TRANSCRIPT.map((line) => (
                <li key={line.time} className="rounded-xl bg-white/[0.04] px-3 py-2.5">
                  <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="font-semibold text-foreground/90">{line.who}</span>
                    <span>{line.time}</span>
                    <span className="ml-auto rounded-md bg-primary/20 px-1.5 py-0.5 font-semibold text-brand">
                      {line.lang}
                    </span>
                  </div>
                  <p className="text-[13px] leading-relaxed text-foreground/90">{line.text}</p>
                </li>
              ))}
            </ul>

            <div className="rounded-2xl border border-primary/25 bg-linear-to-br from-primary/15 to-primary/[0.03] p-3.5">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-brand">
                <Sparkles className="size-3.5" />
                AI summary · draft
              </p>
              <p className="mb-2.5 text-[13px] leading-relaxed text-foreground/90">
                Launch moves to Friday. QA wraps tonight; demo prep starts tomorrow morning.
              </p>
              <ul className="flex flex-col gap-1.5 text-[12.5px] text-foreground/85">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
                  <span>Priya — finish QA by 6 PM</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
                  <span>Rohan — prepare demo (tomorrow)</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
