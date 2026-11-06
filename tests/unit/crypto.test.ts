import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  decryptSecret,
  encryptSecret,
  generateToken,
  hashSecret,
  hmacSha256Hex,
  signWebhookPayload,
  timingSafeEqualStrings,
  verifyPkceS256,
} from "../../convex/connector/crypto";

const PEPPER = "p".repeat(48);
const KEY_V1 = "00".repeat(32);
const KEY_V2 = "ab".repeat(32);

beforeEach(() => {
  vi.stubEnv("CONNECTOR_TOKEN_PEPPER", PEPPER);
  vi.stubEnv("CONNECTOR_ENCRYPTION_KEY", KEY_V1);
});
afterEach(() => vi.unstubAllEnvs());

describe("tokens", () => {
  it("are prefixed, opaque and at least 32 random bytes", () => {
    const token = generateToken("cp1_meetup_");
    expect(token.startsWith("cp1_meetup_")).toBe(true);
    // 32 bytes -> 43 base64url chars
    expect(token.length - "cp1_meetup_".length).toBeGreaterThanOrEqual(43);
    expect(generateToken("cp1_meetup_")).not.toBe(token);
  });

  it("are stored only as HMAC-SHA256(pepper, token)", async () => {
    const token = generateToken("cp1_meetup_");
    const hash = await hashSecret(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(await hashSecret(token)).toBe(hash);
    expect(hash).toBe(await hmacSha256Hex(PEPPER, token));
  });

  it("hash changes with the pepper", async () => {
    const before = await hashSecret("abc");
    vi.stubEnv("CONNECTOR_TOKEN_PEPPER", "q".repeat(48));
    expect(await hashSecret("abc")).not.toBe(before);
  });

  it("refuses to hash without a strong pepper", async () => {
    vi.stubEnv("CONNECTOR_TOKEN_PEPPER", "short");
    await expect(hashSecret("abc")).rejects.toThrow(/PEPPER/);
  });
});

describe("timingSafeEqualStrings", () => {
  it("compares correctly regardless of length", () => {
    expect(timingSafeEqualStrings("abc", "abc")).toBe(true);
    expect(timingSafeEqualStrings("abc", "abd")).toBe(false);
    expect(timingSafeEqualStrings("abc", "abcd")).toBe(false);
    expect(timingSafeEqualStrings("", "")).toBe(true);
    expect(timingSafeEqualStrings("", "a")).toBe(false);
  });
});

describe("PKCE (C02)", () => {
  // RFC 7636 Appendix B test vector.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("accepts the right verifier", async () => {
    expect(await verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it("rejects a wrong verifier", async () => {
    expect(await verifyPkceS256("x".repeat(43), challenge)).toBe(false);
  });

  it("rejects malformed verifiers", async () => {
    expect(await verifyPkceS256("short", challenge)).toBe(false);
    expect(await verifyPkceS256("a".repeat(129), challenge)).toBe(false);
    expect(await verifyPkceS256(`${verifier}!`, challenge)).toBe(false);
  });
});

describe("webhook signing (C15)", () => {
  it("signs `<timestamp>.<rawBody>` with HMAC-SHA256 as v1=<hex>", async () => {
    const signature = await signWebhookPayload("whsec_test", 1700000000, '{"a":1}');
    expect(signature).toBe(`v1=${await hmacSha256Hex("whsec_test", '1700000000.{"a":1}')}`);
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it("matches a known HMAC-SHA256 vector", async () => {
    // RFC 4231 test case 2
    expect(await hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });
});

describe("AES-256-GCM secret encryption", () => {
  it("round-trips and never stores plaintext", async () => {
    const blob = await encryptSecret("whsec_super_secret");
    expect(blob.startsWith("enc:v1:")).toBe(true);
    expect(blob).not.toContain("whsec_super_secret");
    expect(await decryptSecret(blob)).toBe("whsec_super_secret");
  });

  it("uses a fresh IV every time", async () => {
    expect(await encryptSecret("same")).not.toBe(await encryptSecret("same"));
  });

  it("detects tampering", async () => {
    const blob = await encryptSecret("secret");
    const parts = blob.split(":");
    const bytes = base64UrlToBytes(parts[3]);
    bytes[0] ^= 0xff;
    parts[3] = bytesToBase64Url(bytes);
    await expect(decryptSecret(parts.join(":"))).rejects.toThrow();
  });

  it("supports key rotation: new data uses the newest key, old data still decrypts", async () => {
    const oldBlob = await encryptSecret("old");
    vi.stubEnv("CONNECTOR_ENCRYPTION_KEY_V2", KEY_V2);
    const newBlob = await encryptSecret("new");
    expect(newBlob.startsWith("enc:v2:")).toBe(true);
    expect(await decryptSecret(oldBlob)).toBe("old");
    expect(await decryptSecret(newBlob)).toBe("new");
  });

  it("rejects a malformed key", async () => {
    vi.stubEnv("CONNECTOR_ENCRYPTION_KEY", "nothex");
    await expect(encryptSecret("x")).rejects.toThrow(/64 hex/);
  });
});
