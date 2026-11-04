import { AudioLines, BrainCircuit, CheckCircle2, ListChecks, Users, type LucideIcon } from "lucide-react";
import { Logo } from "@/components/brand/logo";

const HIGHLIGHTS: ReadonlyArray<{
  icon: LucideIcon;
  title: string;
  description: string;
  tone: string;
}> = [
  {
    icon: AudioLines,
    title: "Live transcription",
    description: "Hindi, Marathi and English, even mixed",
    tone: "bg-emerald-500/12 text-emerald-300",
  },
  {
    icon: BrainCircuit,
    title: "AI summaries",
    description: "Decisions and key points, instantly",
    tone: "bg-violet-500/12 text-violet-300",
  },
  {
    icon: ListChecks,
    title: "Action items",
    description: "Follow-ups on a shared task board",
    tone: "bg-amber-500/12 text-amber-300",
  },
  {
    icon: Users,
    title: "Team workspaces",
    description: "Invite your team and keep history in one place",
    tone: "bg-sky-500/12 text-sky-300",
  },
];

const TRUST = ["Free plan available", "No credit card", "Runs in your browser"] as const;

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background">
      {/* ── Brand panel ── */}
      <aside className="relative hidden flex-1 flex-col justify-between overflow-hidden border-r border-border p-10 lg:flex xl:p-14">
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div className="bg-dot-grid absolute inset-0 opacity-50" />
          <div className="animate-aurora absolute -top-32 -left-24 h-[28rem] w-[28rem] rounded-full bg-primary/25 blur-[110px]" />
          <div className="animate-aurora absolute -right-20 bottom-0 h-80 w-80 rounded-full bg-warm/15 blur-[100px] [animation-delay:-9s]" />
        </div>

        <div className="relative z-10">
          <Logo size="lg" />
        </div>

        <div className="relative z-10 flex max-w-xl flex-col gap-10">
          <div>
            <h1 className="font-display text-4xl leading-[1.05] font-extrabold tracking-[-0.04em] text-balance text-foreground xl:text-5xl">
              Meetings that write <span className="text-brand-gradient">their own minutes.</span>
            </h1>
            <p className="mt-4 max-w-md text-base leading-relaxed text-muted-foreground">
              Live video, real-time transcription, AI summaries and action items — in one workspace.
            </p>
          </div>

          <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {HIGHLIGHTS.map((item) => (
              <li
                key={item.title}
                className="flex items-center gap-3 rounded-2xl border border-white/[0.08] bg-card/50 p-3.5 backdrop-blur-sm"
              >
                <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${item.tone}`}>
                  <item.icon className="size-[1.15rem]" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-foreground">{item.title}</span>
                  <span className="block text-xs text-muted-foreground">{item.description}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <ul className="relative z-10 flex flex-wrap items-center gap-x-5 gap-y-2">
          {TRUST.map((text) => (
            <li key={text} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle2 className="size-3.5 text-emerald-400" />
              {text}
            </li>
          ))}
        </ul>
      </aside>

      {/* ── Form panel ── */}
      <main className="relative flex flex-1 flex-col items-center justify-center p-6 lg:p-10">
        <div
          className="pointer-events-none absolute inset-0 lg:hidden"
          aria-hidden="true"
        >
          <div className="absolute -top-24 left-1/2 h-64 w-96 -translate-x-1/2 rounded-full bg-primary/20 blur-[90px]" />
        </div>
        <div className="relative mb-8 lg:hidden">
          <Logo />
        </div>
        <div className="relative w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
