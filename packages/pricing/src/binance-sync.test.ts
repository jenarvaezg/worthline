/**
 * Binance sync orchestration (ADR 0021).
 *
 * Turns the account's wallet balances into token-position drafts ready to persist,
 * resolving each token's live EUR unit price via CoinGecko (symbol → id → price).
 * Every external dependency is injected, so this is a pure unit of work testable
 * without the network — the web action wires the real balance reader + price fetch.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { fetchCoinGeckoPriceEur, syncBinanceAccount } from "./binance-sync";
import { fallbackChains } from "./registry";

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

  test("maps a locked-earn balance to a TERM-LOCKED rung draft (S3, #248)", async () => {
    const drafts = await syncBinanceAccount({
      listBalances: async () => [
        { asset: "BTC", wallet: "spot", balance: "0.5" },
        { asset: "ETH", wallet: "locked-earn", balance: "3" },
      ],
      priceEur: async (id) => ({ bitcoin: 50_000, ethereum: 2_000 })[id] ?? null,
    });

    const byWallet = new Map(drafts.map((d) => [d.wallet, d]));
    // spot stays market; locked-earn lifts onto the term-locked rung.
    expect(byWallet.get("spot")?.liquidityTier).toBe("market");
    expect(byWallet.get("locked-earn")?.liquidityTier).toBe("term-locked");
    expect(byWallet.get("locked-earn")?.externalId).toBe("ETH:locked-earn");
  });

  test("funding and flexible-earn stay on the market rung", async () => {
    const drafts = await syncBinanceAccount({
      listBalances: async () => [
        { asset: "BTC", wallet: "funding", balance: "0.1" },
        { asset: "USDT", wallet: "flexible-earn", balance: "500" },
      ],
      priceEur: async (id) => ({ bitcoin: 50_000, tether: 1 })[id] ?? null,
    });

    expect(drafts.every((d) => d.liquidityTier === "market")).toBe(true);
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

describe("fetchCoinGeckoPriceEur — the real live-price seam (ADR 0021 consistency)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("resolves the EUR quote through the shared CoinGecko provider", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ bitcoin: { eur: 50_000 } }),
    } as Response);

    expect(await fetchCoinGeckoPriceEur("bitcoin", "2026-06-16T00:00:00.000Z")).toBe(
      50_000,
    );
  });

  test("a provider miss (non-OK / no quote) normalizes to null — token valued 0 + warning", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    expect(
      await fetchCoinGeckoPriceEur("bitcoin", "2026-06-16T00:00:00.000Z"),
    ).toBeNull();

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ bitcoin: {} }), // no eur field
    } as Response);
    expect(
      await fetchCoinGeckoPriceEur("bitcoin", "2026-06-16T00:00:00.000Z"),
    ).toBeNull();
  });

  test("a non-positive price normalizes to null (never a 0/negative unit price)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ bitcoin: { eur: 0 } }),
    } as Response);
    expect(
      await fetchCoinGeckoPriceEur("bitcoin", "2026-06-16T00:00:00.000Z"),
    ).toBeNull();
  });

  test("a thrown provider error is swallowed to null (never aborts the whole sync)", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network down"));
    expect(
      await fetchCoinGeckoPriceEur("bitcoin", "2026-06-16T00:00:00.000Z"),
    ).toBeNull();
  });

  test("routes through the pricing seam: a coingecko miss rides a declared fallback chain", async () => {
    // The revalue now goes through fetchPriceNow("coingecko", ctx) (ADR 0026),
    // so a token price participates in any chain declared for coingecko — under
    // the old direct resolveProvider("coingecko") call a miss returned null
    // regardless of any fallback. Declare a temporary coingecko→stooq chain and
    // confirm a CoinGecko miss is rescued by Stooq's EUR quote.
    const previous = fallbackChains.coingecko;
    fallbackChains.coingecko = ["stooq"];
    try {
      vi.mocked(fetch)
        // CoinGecko /simple/price miss (non-OK):
        .mockResolvedValueOnce({ ok: false, status: 429 } as Response)
        // Stooq rescue with a valid EUR close:
        .mockResolvedValueOnce({
          ok: true,
          text: async () =>
            "Symbol,Date,Time,Open,High,Low,Close,Volume\nBTC,2026-06-16,16:00:00,49000,51000,48000,50000,123",
        } as Response);

      expect(await fetchCoinGeckoPriceEur("bitcoin", "2026-06-16T00:00:00.000Z")).toBe(
        50_000,
      );
    } finally {
      if (previous === undefined) delete fallbackChains.coingecko;
      else fallbackChains.coingecko = previous;
    }
  });
});
