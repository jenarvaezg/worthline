/**
 * Secret crypto seam tests (S6 #387, ADR 0030 / extends ADR 0016). The seam
 * encrypts connected-source secrets at rest before they reach the cloud:
 * round-trippable, non-deterministic (random IV), tamper-evident (AES-GCM tag),
 * and a graceful passthrough where no key is configured (local single-user mode)
 * or where a legacy plaintext value predates encryption.
 */
import { describe, expect, it } from "vitest";

import { makeSecretCrypto } from "./crypto";

const KEY = "test-encryption-key-material";

describe("secret crypto", () => {
  it("round-trips: open(seal(x)) === x", () => {
    const { seal, open } = makeSecretCrypto(KEY);
    const secret = JSON.stringify({ apiKey: "abc", apiSecret: "xyz" });
    expect(open(seal(secret))).toBe(secret);
  });

  it("produces distinct ciphertext per call (random IV)", () => {
    const { seal } = makeSecretCrypto(KEY);
    expect(seal("same")).not.toBe(seal("same"));
  });

  it("seals to opaque, prefixed ciphertext — never the plaintext", () => {
    const { seal } = makeSecretCrypto(KEY);
    const sealed = seal("super-secret");
    expect(sealed).not.toContain("super-secret");
    expect(sealed.startsWith("wlsec1:")).toBe(true);
  });

  it("fails to open tampered ciphertext", () => {
    const { seal, open } = makeSecretCrypto(KEY);
    const sealed = seal("secret");
    const blob = Buffer.from(sealed.slice("wlsec1:".length), "base64");
    const last = blob.length - 1;
    blob[last] = (blob[last] ?? 0) ^ 0xff; // corrupt the last ciphertext byte
    const tampered = "wlsec1:" + blob.toString("base64");
    expect(() => open(tampered)).toThrow();
  });

  it("fails to open with the wrong key", () => {
    const sealed = makeSecretCrypto(KEY).seal("secret");
    expect(() => makeSecretCrypto("different-key").open(sealed)).toThrow();
  });

  it("is a passthrough when no key is configured (local mode)", () => {
    const { seal, open } = makeSecretCrypto(undefined);
    expect(seal("plain")).toBe("plain");
    expect(open("plain")).toBe("plain");
  });

  it("opens legacy plaintext unchanged even with a key set", () => {
    const { open } = makeSecretCrypto(KEY);
    const legacy = '{"apiKey":"legacy"}';
    expect(open(legacy)).toBe(legacy);
  });

  it("cannot open a sealed value once the key is removed", () => {
    const sealed = makeSecretCrypto(KEY).seal("secret");
    expect(() => makeSecretCrypto(undefined).open(sealed)).toThrow();
  });
});
