/**
 * Unit tests for the pure Binance TILE helpers (PRD #245/#248, ADR 0021): the
 * cross-rung value aggregation + the re-exported generic helpers + credential
 * shaping/read-back. No store, no network.
 */

import type { SourcePosition, TokenPosition } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  aggregateSourceValueMinor,
  countNonDustTokens,
  formatLastSync,
  parseBinanceCredentials,
  readBinanceCredentials,
  resolveConnectingOwnership,
  serializeBinanceCredentials,
} from "./binance-helpers";

function asset(id: string, amountMinor: number) {
  return { id, currentValue: { amountMinor } };
}

function token(
  symbol: string,
  balance: string,
  unitPrice: string | null,
  wallet = "spot",
): TokenPosition {
  return {
    kind: "token",
    id: `${symbol}-${wallet}`,
    sourceId: "src",
    externalId: `${symbol}:${wallet}`,
    name: symbol,
    symbol,
    balance,
    wallet,
    liquidityTier: "market",
    unitPrice,
    imageUrl: null,
    currency: "EUR",
  };
}

describe("re-exported generic helpers", () => {
  test("resolveConnectingOwnership is the shared numista helper", () => {
    expect(resolveConnectingOwnership([{ id: "mJ", name: "Jose" }], undefined)).toEqual([
      { memberId: "mJ", shareBps: 10_000 },
    ]);
  });

  test("formatLastSync is the shared numista helper", () => {
    expect(formatLastSync(null)).toBe("Nunca");
    expect(formatLastSync("2026-06-16T11:20:00.000Z")).toMatch(/2026/);
  });
});

describe("Binance credentials", () => {
  test("parses key + secret, trimming, and rejects a missing half", () => {
    expect(parseBinanceCredentials("  key  ", "  secret  ")).toEqual({
      apiKey: "key",
      apiSecret: "secret",
    });
    expect(parseBinanceCredentials("key", "")).toBeNull();
    expect(parseBinanceCredentials(null, "secret")).toBeNull();
  });

  test("serializes and reads stored credentials", () => {
    const creds = { apiKey: "k", apiSecret: "s" };
    expect(readBinanceCredentials(serializeBinanceCredentials(creds))).toEqual(creds);
    expect(readBinanceCredentials("not json")).toBeNull();
    expect(readBinanceCredentials(JSON.stringify({ apiKey: "k" }))).toBeNull();
  });
});

describe("aggregateSourceValueMinor", () => {
  test("a single market asset returns its value", () => {
    const ids = new Set(["market"]);
    expect(aggregateSourceValueMinor([asset("market", 2_500_000)], ids)).toBe(2_500_000);
  });

  test("a market + term-locked pair returns the summed value (#248)", () => {
    const ids = new Set(["market", "locked"]);
    expect(
      aggregateSourceValueMinor(
        [asset("market", 2_500_000), asset("locked", 600_000)],
        ids,
      ),
    ).toBe(3_100_000);
  });

  test("assets not in the source's set are excluded", () => {
    const ids = new Set(["market"]);
    expect(
      aggregateSourceValueMinor(
        [asset("market", 2_500_000), asset("unrelated", 9_999_999)],
        ids,
      ),
    ).toBe(2_500_000);
  });

  test("an empty set sums to zero", () => {
    expect(aggregateSourceValueMinor([asset("market", 2_500_000)], new Set())).toBe(0);
  });
});

describe("countNonDustTokens (#479)", () => {
  test("counts DISTINCT tokens, folding one held across wallets into one", () => {
    expect(
      countNonDustTokens([
        token("BTC", "0.5", "50000", "spot"),
        token("BTC", "0.1", "50000", "funding"),
        token("ETH", "2", "2000"),
      ]),
    ).toBe(2);
  });

  test("excludes dust — value rounds to 0,00 €, incl. unpriceable tokens", () => {
    expect(
      countNonDustTokens([
        token("BTC", "0.5", "50000"), // 25 000 € — kept
        token("WAGMI", "100", null), // unpriceable → 0 € — dust
        token("SHIB", "0.004", "1"), // 0,004 € → 0 minor — dust
      ]),
    ).toBe(1);
  });

  test("ignores non-token positions", () => {
    const coin = { kind: "coin" } as unknown as SourcePosition;
    expect(countNonDustTokens([coin, token("BTC", "0.5", "50000")])).toBe(1);
  });
});
