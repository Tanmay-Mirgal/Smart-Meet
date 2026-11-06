import { describe, expect, it } from "vitest";
import { checkWebhookUrl, isBlockedAddress, isIpLiteral } from "../../convex/connector/ssrf";

describe("isBlockedAddress (C17)", () => {
  it.each([
    // loopback / unspecified
    "127.0.0.1", "127.255.255.254", "0.0.0.0", "0.1.2.3", "::1", "::", "[::1]",
    // RFC 1918
    "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.255.255",
    // link-local + cloud metadata
    "169.254.169.254", "169.254.0.1", "fe80::1", "fe80::abcd%eth0", "febf::1",
    // RFC 4193 unique local (incl. AWS IPv6 metadata)
    "fc00::1", "fd00:ec2::254", "fdff::1",
    // carrier-grade NAT, benchmarking, documentation, multicast, reserved, broadcast
    "100.64.0.1", "100.127.255.255", "198.18.0.1", "198.19.255.255", "192.0.2.1", "198.51.100.1",
    "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255", "ff02::1", "2001:db8::1",
    // IPv4 hidden inside IPv6
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::127.0.0.1",
    "64:ff9b::7f00:1", "64:ff9b::a00:1", "2002:7f00:1::1", "2002:a9fe:a9fe::1",
    // garbage is blocked, never allowed
    "", "not-an-ip", "999.1.1.1", "1.2.3", "::g",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    "8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "192.167.1.1", "100.63.255.255",
    "100.128.0.1", "169.253.1.1", "11.0.0.1", "198.17.0.1", "198.20.0.1", "223.255.255.255",
    "2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1",
  ])("allows public address %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("checkWebhookUrl", () => {
  const ok = (url: string) => checkWebhookUrl(url);
  const reason = (url: string, devMode = false) => {
    const result = checkWebhookUrl(url, { devMode });
    return result.ok ? null : result.reason;
  };

  it("accepts ordinary https endpoints", () => {
    expect(ok("https://hub.example.com/hooks/meetup").ok).toBe(true);
    expect(ok("https://hub.example.com:8443/x?y=1").ok).toBe(true);
    expect(ok("https://8.8.8.8/hook").ok).toBe(true);
  });

  it("requires https in production", () => {
    expect(reason("http://hub.example.com/hook")).toMatch(/https/);
    expect(reason("ftp://hub.example.com/hook")).toMatch(/https/);
    expect(reason("javascript:alert(1)")).not.toBeNull();
    expect(reason("not a url")).toMatch(/not valid/);
  });

  it("rejects credentials in the URL", () => {
    expect(reason("https://user:pass@hub.example.com/hook")).toMatch(/credentials/);
    expect(reason("https://user@hub.example.com/hook")).toMatch(/credentials/);
  });

  it("rejects internal host names", () => {
    for (const url of [
      "https://localhost/hook",
      "https://LOCALHOST./hook",
      "https://api.localhost/hook",
      "https://printer.local/hook",
      "https://db.internal/hook",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://nas.home.arpa/hook",
    ]) {
      expect(reason(url), url).toMatch(/internal/);
    }
  });

  it("rejects private IP literals, including every obfuscated spelling of 127.0.0.1", () => {
    for (const url of [
      "https://127.0.0.1/hook",
      "https://10.1.2.3/hook",
      "https://192.168.1.1:8443/hook",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/hook",
      "https://[fd00:ec2::254]/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://2130706433/hook", // decimal
      "https://0x7f000001/hook", // hex
      "https://017700000001/hook", // octal
      "https://127.1/hook", // short form
      "https://0/hook",
    ]) {
      expect(reason(url), url).toMatch(/private|loopback|link-local|internal/);
    }
  });

  it("relaxes the rules only in dev mode", () => {
    expect(reason("http://localhost:4000/hook", true)).toBeNull();
    expect(reason("https://127.0.0.1/hook", true)).toBeNull();
    expect(reason("ftp://localhost/hook", true)).toMatch(/http/);
  });

  it("recognises IP literals", () => {
    expect(isIpLiteral("1.2.3.4")).toBe(true);
    expect(isIpLiteral("[::1]")).toBe(true);
    expect(isIpLiteral("example.com")).toBe(false);
  });
});
