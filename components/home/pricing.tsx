import Link from "next/link";
import { CheckCircle2, Crown, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/home/section-heading";
import { FREE_FEATURES, PRO_FEATURES, PRO_PRICE } from "@/lib/plans";

export function Pricing() {
  return (
    <section id="pricing" className="mx-auto max-w-5xl px-4 py-24 sm:px-6 lg:py-32">
      <SectionHeading
        eyebrow="Pricing"
        title="Start free. Upgrade when your team does."
        description="Run your first meetings on the Free plan. Move to Pro for unlimited meetings and the full AI toolkit."
      />

      <div className="mt-14 grid gap-5 md:grid-cols-2">
        {/* Free */}
        <div className="flex flex-col rounded-3xl border border-white/[0.08] bg-card/60 p-7">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-xl bg-white/[0.06] text-muted-foreground">
              <Zap className="size-4" />
            </span>
            <h3 className="font-display text-lg font-bold text-foreground">Free</h3>
          </div>
          <p className="mt-5 flex items-baseline gap-1.5">
            <span className="font-display text-5xl font-extrabold tracking-[-0.04em] text-foreground">₹0</span>
            <span className="text-sm text-muted-foreground">forever</span>
          </p>
          <p className="mt-1 text-sm text-muted-foreground">Perfect for trying Meetup with your team.</p>

          <ul className="mt-6 flex flex-1 flex-col gap-3">
            {FREE_FEATURES.map((feature) => (
              <li key={feature} className="flex items-center gap-2.5 text-sm text-foreground/85">
                <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                {feature}
              </li>
            ))}
          </ul>

          <Button
            asChild
            variant="outline"
            className="mt-8 h-11 rounded-xl border-white/12 bg-white/[0.03] text-sm font-semibold hover:bg-white/[0.07]"
          >
            <Link href="/sign-up">Create free account</Link>
          </Button>
        </div>

        {/* Pro */}
        <div className="relative flex flex-col rounded-3xl border border-primary/40 bg-linear-to-b from-primary/[0.14] to-card p-7 shadow-[0_30px_80px_-30px] shadow-primary/50">
          <span className="absolute -top-3 left-7 rounded-full bg-brand-gradient px-3 py-1 text-[11px] font-bold tracking-wide text-white uppercase">
            Most popular
          </span>
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-xl bg-primary/20 text-brand">
              <Crown className="size-4" />
            </span>
            <h3 className="font-display text-lg font-bold text-foreground">Pro</h3>
          </div>
          <p className="mt-5 flex items-baseline gap-1.5">
            <span className="font-display text-5xl font-extrabold tracking-[-0.04em] text-foreground">
              ₹{PRO_PRICE.inr}
            </span>
            <span className="text-sm text-muted-foreground">/ month · ${PRO_PRICE.usd} USD</span>
          </p>
          <p className="mt-1 text-sm text-muted-foreground">Everything in Free, plus:</p>

          <ul className="mt-6 flex flex-1 flex-col gap-3">
            {PRO_FEATURES.map((feature) => (
              <li key={feature} className="flex items-center gap-2.5 text-sm text-foreground/90">
                <CheckCircle2 className="size-4 shrink-0 text-brand" />
                {feature}
              </li>
            ))}
          </ul>

          <Button
            asChild
            className="mt-8 h-11 rounded-xl bg-brand-gradient text-sm font-semibold text-white shadow-[0_10px_30px_-8px] shadow-primary/60 transition-all hover:-translate-y-0.5 hover:brightness-110"
          >
            <Link href="/sign-up">Start with Pro</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
