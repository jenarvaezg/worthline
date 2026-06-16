import { describe, expect, test } from "vitest";

import { resolveCoinGeckoId } from "./binance-symbols";

describe("resolveCoinGeckoId — Binance symbol → CoinGecko id (ADR 0021)", () => {
  test("maps common symbols to their CoinGecko id", () => {
    expect(resolveCoinGeckoId("BTC")).toBe("bitcoin");
    expect(resolveCoinGeckoId("ETH")).toBe("ethereum");
    expect(resolveCoinGeckoId("USDT")).toBe("tether");
    expect(resolveCoinGeckoId("BNB")).toBe("binancecoin");
  });

  test("is case-insensitive and trims (Binance reports upper-case symbols)", () => {
    expect(resolveCoinGeckoId("btc")).toBe("bitcoin");
    expect(resolveCoinGeckoId("  ETH ")).toBe("ethereum");
  });

  test("returns null for an unmapped symbol — the caller values it 0 + warns", () => {
    expect(resolveCoinGeckoId("WAGMI")).toBeNull();
    expect(resolveCoinGeckoId("")).toBeNull();
  });
});
