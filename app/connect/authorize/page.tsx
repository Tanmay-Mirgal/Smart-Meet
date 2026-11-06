import { notFound } from "next/navigation";
import { ConsentScreen } from "@/features/connector/components/consent-screen";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Connect an app",
  description: "Review and approve a connection to your Meetup account.",
  path: "/connect/authorize",
  index: false,
});

// The flag below is read per request. Without this, a build made with the connector
// off would prerender a permanent 404 (notFound() runs before searchParams is read).
export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * CP1 consent page (`GET /connect/authorize`). All validation happens in
 * Convex (`connector.consent.prepare`), never here; this route only forwards
 * the raw query parameters.
 */
export default async function AuthorizePage({ searchParams }: { searchParams: SearchParams }) {
  // Connector disabled ⇒ the route does not exist (CP1 §6).
  if (process.env.CONNECTOR_ENABLED !== "true") {
    notFound();
  }

  const query = await searchParams;
  const candidates = {
    clientId: first(query.client_id),
    redirectUri: first(query.redirect_uri),
    responseType: first(query.response_type),
    scope: first(query.scope),
    state: first(query.state),
    codeChallenge: first(query.code_challenge),
    codeChallengeMethod: first(query.code_challenge_method),
  };

  // Convex rejects `undefined` argument values, so only pass what was sent.
  const params = Object.fromEntries(
    Object.entries(candidates).filter(([, value]) => value !== undefined),
  ) as Partial<Record<keyof typeof candidates, string>>;

  return <ConsentScreen params={params} />;
}
