import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface PageHeaderProps {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  description: string;
  /** Right-aligned content: stats, badges or buttons. */
  children?: React.ReactNode;
  className?: string;
}

/** Hero header shared by every workspace page. */
export function PageHeader({
  icon: Icon,
  eyebrow,
  title,
  description,
  children,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "relative overflow-hidden rounded-3xl border border-border bg-card p-6 lg:p-8",
        className,
      )}
    >
      <div
        className="pointer-events-none absolute -top-24 -right-16 size-72 rounded-full bg-primary/15 blur-3xl"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -bottom-24 left-1/3 size-64 rounded-full bg-warm/10 blur-3xl"
        aria-hidden="true"
      />

      <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="mb-3 flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary/15">
              <Icon className="size-4 text-brand" />
            </span>
            <span className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              {eyebrow}
            </span>
          </div>
          <h1 className="font-display text-3xl font-extrabold tracking-[-0.03em] text-foreground lg:text-4xl">
            {title}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
        </div>

        {children ? <div className="flex flex-wrap items-center gap-3">{children}</div> : null}
      </div>
    </header>
  );
}

interface HeaderStatProps {
  icon: LucideIcon;
  value: React.ReactNode;
  label: string;
  /** `live` tints the stat green for things that are happening right now. */
  tone?: "default" | "live";
}

/** Compact number + label tile that lives inside a PageHeader. */
export function HeaderStat({ icon: Icon, value, label, tone = "default" }: HeaderStatProps) {
  const isLive = tone === "live";
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border px-4 py-2.5 backdrop-blur-sm",
        isLive ? "border-emerald-500/30 bg-emerald-500/10" : "border-border bg-background/60",
      )}
    >
      <span
        className={cn(
          "flex size-8 items-center justify-center rounded-lg",
          isLive ? "bg-emerald-500/15 text-emerald-400" : "bg-primary/15 text-brand",
        )}
      >
        <Icon className="size-4" />
      </span>
      <div>
        <p
          className={cn(
            "text-xl font-bold tabular-nums",
            isLive ? "text-emerald-400" : "text-foreground",
          )}
        >
          {value}
        </p>
        <p className={cn("text-[11px]", isLive ? "text-emerald-400/70" : "text-muted-foreground")}>
          {label}
        </p>
      </div>
    </div>
  );
}
