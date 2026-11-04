// NOTE: this file is also imported by Convex functions, so it must stay free of
// Next.js / browser-only imports.

export const PRODUCTION_APP_URL = "https://meetup.tanmaymirgal.dev";
export const LOCAL_APP_URL = "http://localhost:3000";

export const PUBLIC_APP_URL_ERROR =
  "Public app URL is not configured. Falling back to the default Meetup URL.";

function normalizeAppUrlCandidate(candidate: string) {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    return url.origin.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function firstValidUrl(candidates: Array<string | undefined>) {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const normalized = normalizeAppUrlCandidate(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

/**
 * Resolves the canonical public origin of the app.
 *
 * Order: explicit env override → Vercel preview URL (previews only) →
 * localhost while developing → the production domain. Production never falls back
 * to a `*.vercel.app` host, so canonical URLs and invite links stay on the brand domain.
 */
export function getPublicAppUrl() {
  const explicit = firstValidUrl([
    process.env.APP_BASE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.SITE_URL,
  ]);
  if (explicit) {
    return explicit;
  }

  if (process.env.VERCEL_ENV === "preview") {
    const preview = firstValidUrl([process.env.VERCEL_URL]);
    if (preview) {
      return preview;
    }
  }

  return process.env.NODE_ENV === "development" ? LOCAL_APP_URL : PRODUCTION_APP_URL;
}

export function buildPublicAppUrl(pathname: string) {
  const baseUrl = getPublicAppUrl();
  if (!baseUrl) {
    return null;
  }

  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${baseUrl}${path}`;
}
