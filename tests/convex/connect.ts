import { expect } from "vitest";
import { api } from "../../convex/_generated/api";
import { bytesToBase64Url, randomBytes, sha256Base64Url } from "../../convex/connector/crypto";
import { ORG, as, type TestConvex, type TestUser, HOST } from "./fixtures";
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, TEST_REDIRECT } from "./helpers";

/** Runs the real consent + token exchange and returns the bearer token. */
export async function connect(
  t: TestConvex,
  options: { who?: TestUser; orgId?: string; scope: string },
) {
  const who = options.who ?? HOST;
  const verifier = bytesToBase64Url(randomBytes(32));
  const { redirectUrl } = await as(t, who).mutation(api.connector.consent.approve, {
    clientId: TEST_CLIENT_ID,
    redirectUri: TEST_REDIRECT,
    responseType: "code",
    scope: options.scope,
    state: "s",
    codeChallenge: await sha256Base64Url(verifier),
    codeChallengeMethod: "S256",
    orgId: options.orgId ?? ORG,
  });
  const response = await t.fetch("/connect/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: TEST_CLIENT_ID,
      client_secret: TEST_CLIENT_SECRET,
      code: new URL(redirectUrl).searchParams.get("code")!,
      redirect_uri: TEST_REDIRECT,
      code_verifier: verifier,
    }).toString(),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { access_token: string; refresh_token: string };
  return { token: body.access_token, refreshToken: body.refresh_token };
}

export const bearer = (token: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  ...extra,
});

/** GET through the real HTTP handler; returns status, headers and parsed JSON. */
export async function getJson(
  t: TestConvex,
  token: string,
  path: string,
  headers: Record<string, string> = {},
) {
  const response = await t.fetch(`/connect/v1${path}`, { headers: bearer(token, headers) });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: text ? (JSON.parse(text) as Record<string, any>) : null, // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}
