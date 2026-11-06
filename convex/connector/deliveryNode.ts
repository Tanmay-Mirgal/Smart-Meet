"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { isConnectorDevMode } from "./config";
import { decryptSecret, signWebhookPayload } from "./crypto";
import { checkWebhookUrl, isBlockedAddress, isIpLiteral } from "./ssrf";
import {
  MAX_RESPONSE_SNIPPET,
  getHostResolverOverride,
  getWebhookTransportOverride,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from "./webhookTransport";

// NOTE: this file runs in the Node runtime and may only export actions. The
// DNS / HTTP work needs Node built-ins; they are imported lazily so merely
// loading the module (e.g. in tests) never depends on them.

type SendJob =
  | { kind: "skip" }
  | { kind: "send"; url: string; secretEnc: string; deliveryUuid: string; attempt: number; eventType: string; body: string };

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

const CONNECT_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 10_000;

/**
 * The real transport. SSRF defence in depth:
 *  - the URL is re-checked here (registration was only the first check),
 *  - every address the host resolves to is validated AT CONNECT TIME by a custom
 *    `lookup`, so DNS rebinding between registration and delivery cannot help,
 *  - redirects are never followed (a Node request returns the 3xx as-is).
 */
const nodeTransport: Transport = async (request: TransportRequest): Promise<TransportResponse> => {
  const [{ default: dns }, { default: http }, { default: https }] = await Promise.all([
    import("node:dns"),
    import("node:http"),
    import("node:https"),
  ]);

  const target = new URL(request.url);
  const secure = target.protocol === "https:";

  const guardedLookup = (hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
    dns.lookup(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error, "", 4);
      if (addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address))) {
        return callback(
          Object.assign(new Error("The destination resolves to a blocked address"), { code: "EBLOCKED" }),
          "",
          4,
        );
      }
      return options.all
        ? callback(null, addresses)
        : callback(null, addresses[0].address, addresses[0].family);
    });
  };

  return await new Promise<TransportResponse>((resolve, reject) => {
    const options = {
      method: "POST",
      hostname: target.hostname.replace(/^\[|\]$/g, ""),
      port: target.port || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      headers: { ...request.headers, "Content-Length": String(new TextEncoder().encode(request.body).length) },
      agent: false as const, // no pooled sockets: every delivery is validated afresh
      ...(request.devMode ? {} : { lookup: guardedLookup as never }),
    };

    const client = (secure ? https : http).request(options, (response) => {
      let received = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        if (received.length < MAX_RESPONSE_SNIPPET) received += chunk;
      });
      response.on("end", () => {
        clearTimeout(totalTimer);
        resolve({ status: response.statusCode ?? 0, body: received.slice(0, MAX_RESPONSE_SNIPPET) });
      });
      response.on("error", reject);
    });

    const totalTimer = setTimeout(() => client.destroy(new Error("The request timed out")), TOTAL_TIMEOUT_MS);
    client.on("socket", (socket) => {
      if (!socket.connecting) return;
      const connectTimer = setTimeout(
        () => client.destroy(new Error("The connection timed out")),
        CONNECT_TIMEOUT_MS,
      );
      socket.once(secure ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
      socket.once("close", () => clearTimeout(connectTimer));
    });
    client.on("error", (error) => {
      clearTimeout(totalTimer);
      reject(error);
    });
    client.end(request.body);
  });
};

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Delivery failed";
  return message.slice(0, 200);
}

export const deliverOne = internalAction({
  args: { deliveryId: v.id("connector_deliveries") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job: SendJob = await ctx.runMutation(internal.connector.dispatch.loadForDelivery, {
      deliveryId: args.deliveryId,
      now: Date.now(),
    });
    if (job.kind === "skip") return null;

    let outcome:
      | { kind: "response"; status: number; body: string }
      | { kind: "error"; message: string };

    try {
      const devMode = isConnectorDevMode();
      // Re-check at delivery time: never trust a stored URL blindly.
      const check = checkWebhookUrl(job.url, { devMode });
      if (!check.ok) throw new Error(check.reason);

      const secret = await decryptSecret(job.secretEnc);
      const timestamp = Math.floor(Date.now() / 1000);
      const transport = getWebhookTransportOverride() ?? nodeTransport;
      const response = await transport({
        url: job.url,
        devMode,
        body: job.body,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Meetup-Connector/1.0",
          "X-CP-Event": job.eventType,
          // Stable across retries of the same delivery.
          "X-CP-Delivery": job.deliveryUuid,
          "X-CP-Timestamp": String(timestamp),
          "X-CP-Signature": await signWebhookPayload(secret, timestamp, job.body),
        },
      });
      outcome = { kind: "response", status: response.status, body: response.body };
    } catch (error) {
      outcome = { kind: "error", message: describeError(error) };
    }

    await ctx.runMutation(internal.connector.dispatch.recordAttempt, {
      deliveryId: args.deliveryId,
      outcome,
      now: Date.now(),
    });
    return null;
  },
});

/**
 * Registration-time SSRF check: static URL rules, then every address the host
 * resolves to must be public. (Delivery re-validates at connect time.)
 */
export const validateTarget = internalAction({
  args: { url: v.string() },
  returns: v.object({ ok: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (_ctx, args) => {
    const devMode = isConnectorDevMode();
    const check = checkWebhookUrl(args.url, { devMode });
    if (!check.ok) return { ok: false, reason: check.reason };
    if (devMode) return { ok: true };

    const host = check.url.hostname.replace(/^\[|\]$/g, "");
    if (isIpLiteral(host)) return { ok: true }; // already judged by the static check

    let addresses: string[];
    try {
      const resolver = getHostResolverOverride();
      if (resolver) {
        addresses = await resolver(host);
      } else {
        const { default: dns } = await import("node:dns");
        addresses = (await dns.promises.lookup(host, { all: true })).map((entry) => entry.address);
      }
    } catch {
      return { ok: false, reason: "The host name could not be resolved." };
    }

    if (addresses.length === 0 || addresses.some((address) => isBlockedAddress(address))) {
      return {
        ok: false,
        reason: "The host resolves to a private, loopback or link-local address.",
      };
    }
    return { ok: true };
  },
});
