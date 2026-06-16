/**
 * Binance sync orchestration (ADR 0021).
 *
 * Turns the account's wallet balances into token-position drafts ready to persist,
 * resolving each token's live EUR unit price via CoinGecko (symbol → id → price).
 * Every external dependency is injected, so this is a pure unit of work testable
 * without the network — the web action wires the real balance reader + price fetch.
 */
import { describe, expect, test } from "vitest";

import { syncBinanceAccount } from "./binance-sync";

describe("syncBinanceAccount — balances → live-valued token drafts", () => {
  test("maps spot balances to market-rung token drafts with the live EUR price", async () => {
    const drafts = await syncBinanceAccount({
      listBalances: async () => [
        { asset: "BTC", wallet: "spot", balance: "0.5" },
        { asset: "ETH", wallet: "spot", balance: "2" },
      ],
      priceEur: async (id) => ({ bitcoin: 50_000, ethereum: 2_000 })[id] ?? null,
    });

    expect(drafts).toEqual([
      {
        kind: "token",
        externalId: "BTC:spot",
        name: "BTC",
        symbol: "BTC",
        balance: "0.5",
        wallet: "spot",
        liquidityTier: "market",
        unitPrice: "50000",
        currency: "EUR",
      },
      {
        kind: "token",
        externalId: "ETH:spot",
        name: "ETH",
        symbol: "ETH",
        balance: "2",
        wallet: "spot",
        liquidityTier: "market",
        unitPrice: "2000",
        currency: "EUR",
      },
    ]);
  });

  test("an unmapped symbol carries a null price (value 0 + warning), still a draft", async () => {
    const drafts = await syncBinanceAccount({
      listBalances: async () => [{ asset: "WAGMI", wallet: "spot", balance: "100" }],
      priceEur: async () => 9_999, // never consulted — the symbol resolves to no id
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ symbol: "WAGMI", balance: "100", unitPrice: null });
  });

  test("a mapped but unpriceable token (CoinGecko miss/outage) carries a null price", async () => {
    const drafts = await syncBinanceAccount({
      listBalances: async () => [{ asset: "BTC", wallet: "spot", balance: "0.5" }],
      priceEur: async () => null,
    });

    expect(drafts[0]).toMatchObject({ symbol: "BTC", unitPrice: null });
  });

  test("resolves each CoinGecko id at most once even across repeated symbols", async () => {
    const seen: string[] = [];
    await syncBinanceAccount({
      listBalances: async () => [
        { asset: "BTC", wallet: "spot", balance: "0.5" },
        { asset: "BTC", wallet: "funding", balance: "0.1" },
      ],
      priceEur: async (id) => {
        seen.push(id);
        return 50_000;
      },
    });

    expect(seen).toEqual(["bitcoin"]); // one lookup, reused for both BTC lines
  });
});
