import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { MobileNav } from "@/components/home/mobile-nav";

export const HOME_NAV_LINKS = [
  { label: "Features", href: "#features" },
  { label: "How it works", href: "#how-it-works" },
  { label: "Languages", href: "#languages" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" },
] as const;

export function Navbar() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-4">
      <div className="relative mx-auto flex h-14 max-w-6xl items-center justify-between rounded-2xl border border-white/10 bg-background/70 pr-2.5 pl-4 shadow-[0_8px_30px_-12px_rgb(0_0_0/0.6)] backdrop-blur-xl backdrop-saturate-150 sm:pr-3 sm:pl-5">
        <Logo />

        <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
          {HOME_NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-lg px-3 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-1.5">
          <Link
            href="/sign-in"
            className="hidden rounded-lg px-3 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
          >
            Sign in
          </Link>
          <Button
            asChild
            className="hidden h-9 rounded-xl bg-brand-gradient px-4 text-[13px] font-semibold text-white shadow-[0_6px_20px_-6px] shadow-primary/60 transition-all hover:-translate-y-px hover:brightness-110 sm:inline-flex"
          >
            <Link href="/sign-up">Get started free</Link>
          </Button>
          <MobileNav links={HOME_NAV_LINKS} />
        </div>
      </div>
    </header>
  );
}
