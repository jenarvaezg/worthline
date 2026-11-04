import { describe, expect, it } from "vitest";

import { readMyInvestorRelayConfig, requireMyInvestorRelayConfig } from "./relay-config";

const SECRET = "k".repeat(32);

describe("the relay configuration", () => {
  it("is absent when neither variable is set: the connector is off", () => {
    expect(readMyInvestorRelayConfig({})).toBeNull();
    expect(
      readMyInvestorRelayConfig({
        MYINVESTOR_RELAY_URL: " ",
        MYINVESTOR_RELAY_SECRET: "",
      }),
    ).toBeNull();
  });

  it("reads both variables", () => {
    expect(
      readMyInvestorRelayConfig({
        MYINVESTOR_RELAY_URL: "https://relay.example.workers.dev",
        MYINVESTOR_RELAY_SECRET: SECRET,
      }),
    ).toEqual({ url: "https://relay.example.workers.dev/", secret: SECRET });
  });

  it("fails fast when only one is set", () => {
    expect(() =>
      readMyInvestorRelayConfig({
        MYINVESTOR_RELAY_URL: "https://relay.example.workers.dev",
      }),
    ).toThrow(/MYINVESTOR_RELAY_SECRET/);
    expect(() => readMyInvestorRelayConfig({ MYINVESTOR_RELAY_SECRET: SECRET })).toThrow(
      /MYINVESTOR_RELAY_URL/,
    );
  });

  it("fails fast on a relay that is not https or a secret too short to guess", () => {
    expect(() =>
      readMyInvestorRelayConfig({
        MYINVESTOR_RELAY_URL: "http://relay.example.workers.dev",
        MYINVESTOR_RELAY_SECRET: SECRET,
      }),
    ).toThrow(/https/);
    expect(() =>
      readMyInvestorRelayConfig({
        MYINVESTOR_RELAY_URL: "not a url",
        MYINVESTOR_RELAY_SECRET: SECRET,
      }),
    ).toThrow(/MYINVESTOR_RELAY_URL/);
    expect(() =>
      readMyInvestorRelayConfig({
        MYINVESTOR_RELAY_URL: "https://relay.example.workers.dev",
        MYINVESTOR_RELAY_SECRET: "short",
      }),
    ).toThrow(/32/);
  });

  it("never puts the secret in its messages", () => {
    try {
      readMyInvestorRelayConfig({
        MYINVESTOR_RELAY_URL: "http://relay.example.workers.dev",
        MYINVESTOR_RELAY_SECRET: SECRET,
      });
    } catch (error) {
      expect(String(error)).not.toContain(SECRET);
    }
  });

  it("is required where the connector runs", () => {
    expect(() => requireMyInvestorRelayConfig({})).toThrow(/MYINVESTOR_RELAY_URL/);
  });
});
