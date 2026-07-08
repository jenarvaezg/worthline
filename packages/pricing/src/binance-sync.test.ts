/**
 * Binance sync orchestration (ADR 0021).
 *
 * Turns the account's wallet balances into token-position drafts ready to persist,
 * resolving each token's live EUR unit price via CoinGecko (symbol → id → price).
 * Every external dependency is injected, so this is a pure unit of work testable
 * without the network — the web action wires the real balance reader + price fetch.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  fetchCoinGeckoLogos,
  fetchCoinGeckoPriceEur,
  syncBinanceAccount,
} from "./binance-sync";
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
        imageUrl: null,
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
        imageUrl: null,
        currency: "EUR",
      },
    ]);
  });

  test("EUR cash is valued at flat 1:1 parity without a CoinGecko lookup", async () => {
    const priceEur = vi.fn(async () => 9_999);
    const drafts = await syncBinanceAccount({
      listBalances: async () => [{ asset: "EUR", wallet: "spot", balance: "1500.50" }],
      priceEur,
    });

    expect(priceEur).not.toHaveBeenCalled();
    expect(drafts[0]).toMatchObject({
      symbol: "EUR",
      unitPrice: "1",
      balance: "1500.50",
    });
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

  test("stamps each token's logo from the batched logoUrls dep, miss → null (#482)", async () => {
    const drafts = await syncBinanceAccount({
      listBalances: async () => [
        { asset: "BTC", wallet: "spot", balance: "0.5" },
        { asset: "ETH", wallet: "spot", balance: "2" },
      ],
      priceEur: async (id) => ({ bitcoin: 50_000, ethereum: 2_000 })[id] ?? null,
      logoUrls: async () => ({ bitcoin: "https://coin-images.test/btc.png" }), // eth missing
    });

    const bySymbol = new Map(drafts.map((d) => [d.symbol, d]));
    expect(bySymbol.get("BTC")?.imageUrl).toBe("https://coin-images.test/btc.png");
    expect(bySymbol.get("ETH")?.imageUrl).toBeNull(); // absent from the batch → glyph
  });

  test("requests logos once for the deduped, mapped CoinGecko id set (#482)", async () => {
    const calls: string[][] = [];
    await syncBinanceAccount({
      listBalances: async () => [
        { asset: "BTC", wallet: "spot", balance: "0.5" },
        { asset: "BTC", wallet: "funding", balance: "0.1" }, // same id, deduped
        { asset: "WAGMI", wallet: "spot", balance: "100" }, // unmapped → excluded
      ],
      priceEur: async () => 50_000,
      logoUrls: async (ids) => {
        calls.push([...ids]);
        return {};
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["bitcoin"]);
  });

  test("a logoUrls failure never aborts the sync — tokens fall back to null (#482)", async () => {
    const drafts = await syncBinanceAccount({
      listBalances: async () => [{ asset: "BTC", wallet: "spot", balance: "0.5" }],
      priceEur: async () => 50_000,
      logoUrls: async () => {
        throw new Error("coingecko down");
      },
    });

    expect(drafts[0]).toMatchObject({
      symbol: "BTC",
      unitPrice: "50000",
      imageUrl: null,
    });
  });
});

describe("fetchCoinGeckoLogos — the real batched logo seam (#482)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("maps each CoinGecko id to its markets-endpoint image in one call", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { id: "bitcoin", image: "https://coin-images.test/btc.png" },
        { id: "ethereum", image: "https://coin-images.test/eth.png" },
      ],
    } as Response);

    expect(await fetchCoinGeckoLogos(["bitcoin", "ethereum"])).toEqual({
      bitcoin: "https://coin-images.test/btc.png",
      ethereum: "https://coin-images.test/eth.png",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("an empty id set makes no request and returns an empty map", async () => {
    expect(await fetchCoinGeckoLogos([])).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a non-OK response or a throw degrades to an empty map (never aborts sync)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    expect(await fetchCoinGeckoLogos(["bitcoin"])).toEqual({});

    vi.mocked(fetch).mockRejectedValueOnce(new Error("network down"));
    expect(await fetchCoinGeckoLogos(["bitcoin"])).toEqual({});
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
        // CoinGecko /simple/price miss (429) — retried up to 3 times before the chain moves on:
        .mockResolvedValueOnce({ ok: false, status: 429 } as Response)
        .mockResolvedValueOnce({ ok: false, status: 429 } as Response)
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
