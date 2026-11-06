import { Providers } from "@/components/providers";

/**
 * Wraps the connector consent screen with the Convex + Clerk providers. The
 * route itself is protected in proxy.ts (`/connect(.*)`), so an anonymous
 * visitor is sent to sign in and returned here with the full query string.
 */
export default function ConnectLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <main className="flex min-h-screen items-center justify-center px-4 py-10">
        {children}
      </main>
    </Providers>
  );
}
