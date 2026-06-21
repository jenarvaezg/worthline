import { describe, expect, it } from "vitest";

import { assertSecretEncryptionConfigured } from "./encryption-config";

describe("assertSecretEncryptionConfigured", () => {
  it("throws in a hosted deployment (auth configured) when the key is missing", () => {
    expect(() =>
      assertSecretEncryptionConfigured({
        AUTH_GOOGLE_ID: "id",
        AUTH_GOOGLE_SECRET: "secret",
      }),
    ).toThrow(/WORTHLINE_ENCRYPTION_KEY/);
  });

  it("passes in a hosted deployment when the key is set", () => {
    expect(() =>
      assertSecretEncryptionConfigured({
        AUTH_GOOGLE_ID: "id",
        AUTH_GOOGLE_SECRET: "secret",
        WORTHLINE_ENCRYPTION_KEY: "a-strong-random-key",
      }),
    ).not.toThrow();
  });

  it("is a no-op in local no-auth mode (no key needed, secrets stay local)", () => {
    expect(() => assertSecretEncryptionConfigured({})).not.toThrow();
  });
});
