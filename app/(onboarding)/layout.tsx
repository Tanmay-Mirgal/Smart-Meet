import { Providers } from "@/components/providers";
import { Logo } from "@/components/brand/logo";

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <div className="relative flex min-h-screen flex-col overflow-hidden bg-background">
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div className="bg-dot-grid absolute inset-0 opacity-40" />
          <div className="absolute -top-40 left-1/2 h-[26rem] w-[44rem] -translate-x-1/2 rounded-full bg-primary/20 blur-[120px]" />
        </div>

        <header className="relative z-10 flex items-center justify-between px-6 py-5 sm:px-10">
          <Logo />
        </header>

        <main className="relative z-10 flex flex-1 flex-col items-center justify-start p-6 pb-20 sm:p-12">
          <div className="w-full max-w-3xl">{children}</div>
        </main>
      </div>
    </Providers>
  );
}
