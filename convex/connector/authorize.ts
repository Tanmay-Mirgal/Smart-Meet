import { isRegisteredRedirectUri } from "./config";
import { parseScopeParam, type ScopeName } from "./scopes";

/**
 * Validation of `GET /connect/authorize` parameters (CP1 §2.1 / RFC 6749 §4.1.2.1).
 *
 * Two classes of failure, handled differently on purpose:
 *  - `fatal`: the client or redirect URI cannot be trusted → render an error
 *    page and NEVER redirect (an attacker must not be able to bounce users to
 *    an arbitrary URL).
 *  - `redirect`: the redirect URI is the registered one, so report the error
 *    back to the client with `error` + `state`.
 */
export type AuthorizeParams = {
  clientId?: string;
  redirectUri?: string;
  responseType?: string;
  scope?: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
};

export type AuthorizeValidation =
  | {
      ok: true;
      clientId: string;
      redirectUri: string;
      scopes: ScopeName[];
      state: string;
      codeChallenge: string;
    }
  | {
      ok: false;
      kind: "fatal";
      reason: "unknown_client" | "invalid_redirect_uri";
      message: string;
    }
  | {
      ok: false;
      kind: "redirect";
      redirectUri: string;
      error: "invalid_request" | "unsupported_response_type" | "invalid_scope";
      description: string;
      state?: string;
    };

// RFC 7636 §4.2: a SHA-256 challenge is 43 base64url characters.
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_STATE_LENGTH = 512;

export function validateAuthorizeParams(
  params: AuthorizeParams,
  registered: { clientId: string; redirectUris: string[] },
): AuthorizeValidation {
  if (!params.clientId || params.clientId !== registered.clientId) {
    return {
      ok: false,
      kind: "fatal",
      reason: "unknown_client",
      message: "This application is not registered to connect to Meetup.",
    };
  }

  if (
    !params.redirectUri ||
    !isRegisteredRedirectUri(params.redirectUri, registered.redirectUris)
  ) {
    return {
      ok: false,
      kind: "fatal",
      reason: "invalid_redirect_uri",
      message: "The return address of this request is not registered for the application.",
    };
  }

  const redirectUri = params.redirectUri;
  const state =
    params.state && params.state.length <= MAX_STATE_LENGTH ? params.state : undefined;
  const fail = (
    error: "invalid_request" | "unsupported_response_type" | "invalid_scope",
    description: string,
  ): AuthorizeValidation => ({ ok: false, kind: "redirect", redirectUri, error, description, state });

  if (params.responseType !== "code") {
    return fail("unsupported_response_type", "response_type must be 'code'.");
  }

  if (!state) {
    return fail("invalid_request", "A state parameter (up to 512 characters) is required.");
  }

  // PKCE is mandatory, and only the S256 method is accepted.
  if (params.codeChallengeMethod !== "S256") {
    return fail("invalid_request", "PKCE is required: code_challenge_method must be 'S256'.");
  }
  if (!params.codeChallenge || !CODE_CHALLENGE_RE.test(params.codeChallenge)) {
    return fail("invalid_request", "code_challenge must be a base64url SHA-256 digest (43 characters).");
  }

  const { scopes, unknown } = parseScopeParam(params.scope);
  if (unknown.length > 0) {
    return fail("invalid_scope", `Unknown scope: ${unknown.join(", ")}`);
  }
  if (scopes.length === 0) {
    return fail("invalid_scope", "At least one scope is required.");
  }

  return {
    ok: true,
    clientId: params.clientId,
    redirectUri,
    scopes,
    state,
    codeChallenge: params.codeChallenge,
  };
}

/** Appends OAuth response parameters to a (validated) redirect URI. */
export function buildRedirectUrl(
  redirectUri: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}
