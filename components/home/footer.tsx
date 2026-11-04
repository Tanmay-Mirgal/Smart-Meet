import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Logo, LogoMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { SITE_DOMAIN, SITE_NAME } from "@/lib/site";

const PRODUCT_LINKS = [
  { label: "Features", href: "/#features" },
  { label: "How it works", href: "/#how-it-works" },
  { label: "Languages", href: "/#languages" },
  { label: "Pricing", href: "/#pricing" },
  { label: "FAQ", href: "/#faq" },
] as const;

const ACCOUNT_LINKS = [
  { label: "Sign in", href: "/sign-in" },
  { label: "Create account", href: "/sign-up" },
] as const;

export function FinalCta() {
  return (
    <section className="mx-auto max-w-5xl px-4 py-16 sm:px-6 lg:py-24">
      <div className="relative isolate overflow-hidden rounded-[2rem] border border-primary/30 bg-linear-to-br from-primary/25 via-card to-card px-6 py-14 text-center sm:px-12 sm:py-20">
        <div
          className="pointer-events-none absolute -top-24 left-1/2 -z-10 h-64 w-[34rem] -translate-x-1/2 rounded-full bg-primary/30 blur-[100px]"
          aria-hidden="true"
        />
        <LogoMark className="mx-auto mb-6 size-14 shadow-[0_12px_40px_-8px] shadow-primary/60" />
        <h2 className="font-display text-balance text-3xl leading-[1.1] font-extrabold tracking-[-0.035em] text-foreground sm:text-5xl">
          Run your next meeting on Meetup
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
          Create a free workspace, invite your team and let the minutes write themselves.
        </p>
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button
            asChild
            className="h-12 w-full gap-2 rounded-xl bg-white px-7 text-[15px] font-semibold text-neutral-900 shadow-[0_10px_30px_-10px] shadow-black/60 transition-all hover:-translate-y-0.5 hover:bg-white/90 sm:w-auto"
          >
            <Link href="/sign-up">
              Create free account
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          <Button
            asChild
            variant="outline"
            className="h-12 w-full rounded-xl border-white/15 bg-white/[0.04] px-7 text-[15px] font-semibold hover:bg-white/[0.09] sm:w-auto"
          >
            <Link href="/sign-in">Sign in</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="mt-8 border-t border-white/[0.07]">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <Logo />
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted-foreground">
            The AI meeting workspace — live video, real-time transcription, summaries and action
            items in one place.
          </p>
        </div>

        <nav aria-label="Product">
          <p className="mb-4 text-[11px] font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">
            Product
          </p>
          <ul className="flex flex-col gap-2.5">
            {PRODUCT_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <nav aria-label="Account">
          <p className="mb-4 text-[11px] font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">
            Account
          </p>
          <ul className="flex flex-col gap-2.5">
            {ACCOUNT_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      <div className="border-t border-white/[0.05]">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-6 text-xs text-muted-foreground/70 sm:flex-row sm:px-6">
          <p>
            © {new Date().getFullYear()} {SITE_NAME}. All rights reserved.
          </p>
          <p>{SITE_DOMAIN}</p>
        </div>
      </div>
    </footer>
  );
}
