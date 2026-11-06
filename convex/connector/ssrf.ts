/**
 * SSRF protection for webhook targets (CP1 §4). The service makes outbound
 * requests to a URL the caller chose, so it must never reach internal
 * infrastructure: loopback, link-local (incl. the cloud metadata address),
 * private (RFC 1918 / RFC 4193) and other special-purpose ranges.
 *
 * Pure functions only (no DNS, no Node built-ins) so they are unit-testable.
 * Resolution happens in the Node action, which validates every address it
 * resolves — and re-validates at connect time — using `isBlockedAddress`.
 */

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata"]);

function parseIPv4(value: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function isBlockedIPv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // RFC 1918
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 carrier-grade NAT
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local incl. 169.254.169.254 metadata
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 168) || // RFC 1918
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands an IPv6 literal (no brackets, no zone) into eight 16-bit groups. */
function parseIPv6(value: string): number[] | null {
  let text = value.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);

  // Embedded IPv4 tail, e.g. ::ffff:127.0.0.1
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    text = `${text.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;

  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.length !== 8) return null;
  const numbers = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
  return numbers.some(Number.isNaN) ? null : numbers;
}

function isBlockedIPv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const embeddedV4 = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];

  if (groups.every((group) => group === 0)) return true; // :: unspecified
  if (groups.slice(0, 7).every((group) => group === 0) && g7 === 1) return true; // ::1 loopback
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the embedded v4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return isBlockedIPv4(embeddedV4);
  }
  // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 address.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIPv4(embeddedV4);
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (RFC 4193)
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
  if (g0 === 0x2002) return isBlockedIPv4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]); // 6to4
  return false;
}

/** True for any address a webhook must never be sent to. Unparseable input is blocked. */
export function isBlockedAddress(address: string): boolean {
  const text = address.trim().replace(/^\[|\]$/g, "");
  const v4 = parseIPv4(text);
  if (v4) return isBlockedIPv4(v4);
  const v6 = text.includes(":") ? parseIPv6(text) : null;
  return v6 ? isBlockedIPv6(v6) : true;
}

export function isIpLiteral(host: string): boolean {
  const text = host.replace(/^\[|\]$/g, "");
  return parseIPv4(text) !== null || text.includes(":");
}

/**
 * Static checks on a caller-supplied URL (no DNS). `devMode` relaxes the rules for
 * local development only: plain http and private targets are then allowed.
 */
export function checkWebhookUrl(raw: string, options: { devMode?: boolean } = {}): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "The URL is not valid." };
  }

  if (options.devMode) {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false, reason: "The URL must use http or https." };
    }
    return { ok: true, url };
  }

  if (url.protocol !== "https:") {
    return { ok: false, reason: "Webhook URLs must use https." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "Webhook URLs must not contain credentials." };
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, reason: "The URL has no host." };

  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, reason: "Webhook URLs must not point at internal hosts." };
  }
  // WHATWG URL already normalises 2130706433, 0x7f.1, 017700000001 … to dotted form.
  if (isIpLiteral(host) && isBlockedAddress(host)) {
    return { ok: false, reason: "Webhook URLs must not point at private, loopback or link-local addresses." };
  }

  return { ok: true, url };
}
