"use client";

import { useEffect, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { AlertTriangle, Building2, Check, ShieldCheck } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { LoadingBlock } from "@/components/shared/loading-block";
import { cn } from "@/lib/utils";

type AuthorizeParams = Partial<
  Record<
    | "clientId"
    | "redirectUri"
    | "responseType"
    | "scope"
    | "state"
    | "codeChallenge"
    | "codeChallengeMethod",
    string
  >
>;

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full max-w-lg overflow-hidden rounded-xl border border-border/60 bg-card/80 shadow-sm">
      {children}
    </div>
  );
}

function Notice({ title, message }: { title: string; message: string }) {
  return (
    <Frame>
      <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-destructive/30 bg-destructive/10 text-destructive">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">{message}</p>
      </div>
    </Frame>
  );
}

/**
 * Consent screen for the ecosystem connector (CP1 §2.1): shows who wants to
 * connect, exactly what they could do, and lets the user pin the connection to
 * ONE of their organizations.
 */
export function ConsentScreen({ params }: { params: AuthorizeParams }) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const prepared = useQuery(
    api.connector.consent.prepare,
    isAuthenticated ? params : "skip",
  );
  const approve = useMutation(api.connector.consent.approve);

  const [chosenOrgId, setChosenOrgId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A request that is wrong but came from the registered client is reported
  // back to that client (RFC 6749 §4.1.2.1). The URL is built by the server.
  useEffect(() => {
    if (prepared?.status === "redirect") {
      window.location.replace(prepared.redirectUrl);
    }
  }, [prepared]);

  if (isLoading || (isAuthenticated && prepared === undefined)) {
    return (
      <Frame>
        <LoadingBlock className="h-80 w-full" />
      </Frame>
    );
  }

  if (!isAuthenticated) {
    const returnUrl = typeof window !== "undefined" ? window.location.href : "/connect/authorize";
    return (
      <Frame>
        <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-primary/30 bg-primary/10 text-primary">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <h1 className="text-lg font-semibold text-foreground">Sign in required</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Please sign in to your Meetup account to authorize this connection.
          </p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <Button onClick={() => window.location.assign(`/sign-in?redirect_url=${encodeURIComponent(returnUrl)}`)}>
              Sign in to Meetup
            </Button>
            <Button variant="outline" onClick={() => window.location.assign(`/sign-up?redirect_url=${encodeURIComponent(returnUrl)}`)}>
              Create Account
            </Button>
          </div>
        </div>
      </Frame>
    );
  }

  if (!prepared || prepared.status === "disabled") {
    return <Notice title="Not available" message="Connecting apps is not enabled." />;
  }

  if (prepared.status === "fatal") {
    return <Notice title="We can't continue" message={prepared.message} />;
  }

  if (prepared.status === "redirect") {
    return <Notice title="Returning to the app…" message="This request could not be completed." />;
  }

  const organizations = prepared.organizations;
  const selectedOrgId =
    chosenOrgId ?? (organizations.length === 1 ? organizations[0].id : null);

  async function allow() {
    if (!selectedOrgId) return;
    setSubmitting(true);
    setError(null);
    try {
      const { redirectUrl } = await approve({ ...params, orgId: selectedOrgId });
      window.location.assign(redirectUrl);
    } catch {
      setError("We couldn't complete the connection. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <Frame>
      <div className="border-b border-border/60 bg-muted/10 px-6 py-6">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-muted text-foreground">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <h1 className="text-xl font-semibold text-foreground">
          {prepared.hubName} wants to connect to your Meetup account
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{prepared.user.name}</span>
          {prepared.user.email ? ` (${prepared.user.email})` : ""}
        </p>
      </div>

      <div className="space-y-6 px-6 py-6">
        <section className="space-y-3">
          <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/60">
            {prepared.hubName} will be able to
          </p>
          <ul className="space-y-2.5 rounded-lg border border-border/60 bg-muted/20 p-4">
            {prepared.scopes.map((scope) => (
              <li key={scope.name} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <Check className="h-3 w-3 text-brand" />
                </span>
                <span className="text-sm leading-relaxed text-foreground">{scope.description}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-3">
          <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/60">
            Choose the organization to connect
          </p>
          {organizations.length === 0 ? (
            <p className="rounded-lg border border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground">
              You don&apos;t belong to a Meetup organization yet. Create or join one, then try again.
            </p>
          ) : (
            <div role="radiogroup" aria-label="Organization" className="space-y-2">
              {organizations.map((organization) => {
                const selected = organization.id === selectedOrgId;
                return (
                  <button
                    key={organization.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setChosenOrgId(organization.id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors",
                      selected
                        ? "border-primary/60 bg-primary/10"
                        : "border-border/60 bg-muted/20 hover:bg-muted/40",
                    )}
                  >
                    <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 text-sm font-medium text-foreground">
                      {organization.name}
                    </span>
                    {selected && <Check className="h-4 w-4 text-brand" />}
                  </button>
                );
              })}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            The connection is limited to this one organization, and never lets {prepared.hubName} do
            more than you can do in Meetup. You can disconnect at any time from Integrations →
            Connected apps.
          </p>
        </section>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 bg-muted/10 px-6 py-4">
        <Button
          variant="outline"
          disabled={submitting}
          onClick={() => window.location.assign(prepared.cancelUrl)}
        >
          Cancel
        </Button>
        <Button disabled={submitting || !selectedOrgId} onClick={allow}>
          {submitting ? "Connecting…" : "Allow"}
        </Button>
      </div>
    </Frame>
  );
}
