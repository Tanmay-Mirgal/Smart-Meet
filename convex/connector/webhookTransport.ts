/**
 * The one outbound HTTP seam. Production uses the Node transport in
 * deliveryNode.ts (DNS pinned/validated at connect time, no redirects, 5 s
 * connect + 10 s total). Tests install a fake so no sockets are opened.
 */
export type TransportRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Local development only: skip the private-address guard and allow http. */
  devMode: boolean;
};

export type TransportResponse = { status: number; body: string };

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export const MAX_RESPONSE_SNIPPET = 512;

let override: Transport | null = null;

/** Test hook. Pass null to restore the real transport. */
export function setWebhookTransportForTests(transport: Transport | null) {
  override = transport;
}

export function getWebhookTransportOverride(): Transport | null {
  return override;
}

export type HostResolver = (host: string) => Promise<string[]>;
let resolverOverride: HostResolver | null = null;

/** Test hook for DNS (registration-time SSRF validation). */
export function setHostResolverForTests(resolver: HostResolver | null) {
  resolverOverride = resolver;
}

export function getHostResolverOverride(): HostResolver | null {
  return resolverOverride;
}
