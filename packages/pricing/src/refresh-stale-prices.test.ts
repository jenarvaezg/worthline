import type { AssetPrice } from "@worthline/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  FUND_USD_HTML,
  PENSION_PLAN_EUR_HTML,
  PRODUCTO_NO_DISPONIBLE_HTML,
} from "./__fixtures__/finect";
import { REFRESH_CONCURRENCY_LIMIT, refreshStalePrices } from "./refresh-stale-prices";

function stalePrice(assetId: string): AssetPrice {
  return {
    assetId,
    currency: "EUR",
    fetchedAt: "2026-06-08T10:00:00Z",
    freshnessState: "fresh",
    price: "100",
    source: "yahoo",
  };
}

describe("refreshStalePrices provider routing", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("retirement investments default to Finect when no price provider is set", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => PENSION_PLAN_EUR_HTML,
    } as Response);

    const result = await refreshStalePrices(
      [stalePrice("asset-pension")],
      [
        {
          id: "asset-pension",
          currency: "EUR",
          liquidityTier: "term-locked",
          providerSymbol: "N5394",
        },
      ],
      "2026-06-09T10:00:00Z",
    );

    expect(result.updated).toBe(1);
    expect(result.refreshed[0]).toMatchObject({
      assetId: "asset-pension",
      price: "21.64353",
      source: "finect",
    });
  });

  test("non-retirement investments default to Yahoo when no price provider is set", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        chart: {
          result: [
            {
              meta: {
                currency: "EUR",
                regularMarketPrice: 12.34,
              },
              timestamp: [Math.floor(Date.parse("2026-06-09T08:00:00Z") / 1000)],
              indicators: {
                quote: [{ close: [12.34] }],
              },
            },
          ],
        },
      }),
    } as Response);

    const result = await refreshStalePrices(
      [stalePrice("asset-etf")],
      [
        {
          id: "asset-etf",
          currency: "EUR",
          liquidityTier: "market",
          providerSymbol: "VUSA.L",
        },
      ],
      "2026-06-09T10:00:00Z",
    );

    expect(result.refreshed[0]).toMatchObject({
      assetId: "asset-etf",
      price: "12.34",
      source: "yahoo",
    });
  });

  test("crypto investments route to CoinGecko and resolve a derived price", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ bitcoin: { eur: 58000 } }),
    } as Response);

    const result = await refreshStalePrices(
      [stalePrice("asset-btc")],
      [
        {
          id: "asset-btc",
          currency: "EUR",
          liquidityTier: "market",
          priceProvider: "coingecko",
          providerSymbol: "Bitcoin",
        },
      ],
      "2026-06-09T10:00:00Z",
    );

    expect(result.updated).toBe(1);
    expect(result.refreshed[0]).toMatchObject({
      assetId: "asset-btc",
      price: "58000",
      source: "coingecko",
    });
  });

  test("investments without a cache row get their first automatic refresh", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ bitcoin: { eur: 61000 } }),
    } as Response);

    const result = await refreshStalePrices(
      [],
      [
        {
          id: "asset-btc",
          currency: "EUR",
          liquidityTier: "market",
          priceProvider: "coingecko",
          providerSymbol: "bitcoin",
        },
      ],
      "2026-06-09T10:00:00Z",
    );

    expect(result.updated).toBe(1);
    expect(result.refreshed[0]).toMatchObject({
      assetId: "asset-btc",
      price: "61000",
      source: "coingecko",
    });
  });

  test("surfaces each failed symbol with its human-readable reason", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => PRODUCTO_NO_DISPONIBLE_HTML,
    } as Response);

    const result = await refreshStalePrices(
      [stalePrice("asset-pension")],
      [
        {
          id: "asset-pension",
          currency: "EUR",
          liquidityTier: "term-locked",
          providerSymbol: "N5394",
        },
      ],
      "2026-06-09T10:00:00Z",
    );

    expect(result.updated).toBe(0);
    expect(result.failedSymbols).toEqual(["N5394"]);
    expect(result.failures).toEqual([
      { symbol: "N5394", reason: "Finect: símbolo no encontrado" },
    ]);
  });

  test("a USD fund with no ECB rate keeps its price and names the missing piece (#1357)", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, text: async () => FUND_USD_HTML } as Response)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response);

    const result = await refreshStalePrices(
      [stalePrice("asset-fund-usd")],
      [
        {
          id: "asset-fund-usd",
          currency: "EUR",
          liquidityTier: "term-locked",
          providerSymbol: "IE00BDZVHT63-Fidelity_msci_pac_ex_jpn_idx_usd_p_acc",
        },
      ],
      "2026-06-09T10:00:00Z",
    );

    // Transient by design: an ECB blip must not zero a good price, and the
    // banner says what is missing rather than the whole sentence.
    expect(result.refreshed[0]).toMatchObject({
      assetId: "asset-fund-usd",
      price: "100",
      freshnessState: "stale",
      staleReason: "Finect: sin tipo de cambio USD",
    });
    expect(result.failedSymbols).toEqual([]);
  });

  test("preserves the prior good price when a transient outage blips", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("timeout"));

    const prior = stalePrice("asset-etf");
    const result = await refreshStalePrices(
      [prior],
      [
        {
          id: "asset-etf",
          currency: "EUR",
          liquidityTier: "market",
          priceProvider: "yahoo",
          providerSymbol: "VUSA.L",
        },
      ],
      "2026-06-09T10:00:00Z",
    );

    expect(result.updated).toBe(0);
    expect(result.refreshed[0]).toMatchObject({
      assetId: "asset-etf",
      price: "100",
      freshnessState: "stale",
    });
    expect(result.failedSymbols).toEqual([]);
  });

  test("a holding stored on the retired Stooq keeps its price and says what to do (#1354)", async () => {
    // The retired provider must not touch the network, and must not let the cache
    // layer zero a good price: it fails TRANSIENTLY so the last known value
    // survives as stale, carrying an actionable reason into salud de datos.
    const fetchMock = vi.mocked(fetch);
    const prior = { ...stalePrice("asset-direct-stooq"), source: "stooq" as const };

    const result = await refreshStalePrices(
      [prior],
      [
        {
          id: "asset-direct-stooq",
          currency: "EUR",
          liquidityTier: "market",
          priceProvider: "stooq",
          providerSymbol: "san.mc",
        },
      ],
      "2026-06-09T10:00:00Z",
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.updated).toBe(0);
    expect(result.refreshed[0]).toMatchObject({
      assetId: "asset-direct-stooq",
      price: "100",
      freshnessState: "stale",
      source: "stooq",
      staleReason: "Proveedor retirado: asigna un símbolo de Yahoo a esta posición",
    });
  });

  test("a retired-provider holding with no good prior price records a failed row, not a silent skip (#1354)", async () => {
    const result = await refreshStalePrices(
      [],
      [
        {
          id: "asset-new-stooq",
          currency: "EUR",
          liquidityTier: "market",
          priceProvider: "stooq",
          providerSymbol: "san.mc",
        },
      ],
      "2026-06-09T10:00:00Z",
    );

    expect(result.refreshed[0]).toMatchObject({
      assetId: "asset-new-stooq",
      freshnessState: "failed",
      price: "0",
    });
    expect(result.failures).toEqual([
      {
        symbol: "san.mc",
        reason: "Proveedor retirado: asigna un símbolo de Yahoo a esta posición",
      },
    ]);
  });

  test("preserves the prior good price when the single provider times out (#925 AC)", async () => {
    // Yahoo has no rescuing chain since #1354, so the whole refresh is one leg:
    // a timeout is transient and the good price must survive as stale.
    vi.mocked(fetch).mockRejectedValue(new Error("timeout"));

    const prior = { ...stalePrice("asset-etf"), source: "yahoo" as const };
    const result = await refreshStalePrices(
      [prior],
      [
        {
          id: "asset-etf",
          currency: "EUR",
          liquidityTier: "market",
          priceProvider: "yahoo",
          providerSymbol: "GBSE.MI",
        },
      ],
      "2026-06-09T10:00:00Z",
    );

    expect(result.updated).toBe(0);
    expect(result.refreshed[0]).toMatchObject({
      assetId: "asset-etf",
      price: "100",
      freshnessState: "stale",
    });
  });

  test("explicit price provider overrides the liquidity-tier default", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ bitcoin: { eur: 4.25 } }),
    } as Response);

    const result = await refreshStalePrices(
      [stalePrice("asset-term-locked")],
      [
        {
          id: "asset-term-locked",
          // A term-locked tier defaults to Finect; the explicit provider wins.
          currency: "EUR",
          liquidityTier: "term-locked",
          priceProvider: "coingecko",
          providerSymbol: "bitcoin",
        },
      ],
      "2026-06-09T10:00:00Z",
    );

    expect(result.refreshed[0]).toMatchObject({
      assetId: "asset-term-locked",
      price: "4.25",
      source: "coingecko",
    });
  });
});

/**
 * Builds a controllable CoinGecko `fetch` mock that lets the test observe how
 * many provider calls are in flight at once (issue #202). Each call resolves
 * only after the test releases it, so the peak concurrency is deterministic.
 * (It drove Stooq until #1354 retired that provider; the bounding it proves is
 * provider-agnostic.)
 */
function makeGatedCoinGeckoFetch(opts: {
  failingSymbols?: Set<string>;
  onStart?: () => void;
  onEnd?: () => void;
}) {
  let open = false;
  const release: Array<() => void> = [];
  const fetchMock = vi.fn(async (url: string) => {
    opts.onStart?.();
    // The CoinGecko URL carries the coin id as the `ids` query param.
    const symbol =
      new URL(url, "https://api.coingecko.com").searchParams.get("ids") ?? "";
    await new Promise<void>((resolve) => {
      const settle = () => {
        opts.onEnd?.();
        resolve();
      };
      // Once the gate is open, later calls (subsequent batches) resolve at once.
      if (open) {
        settle();
      } else {
        release.push(settle);
      }
    });
    if (opts.failingSymbols?.has(symbol.toLowerCase())) {
      // Unknown coin id -> empty object -> the provider returns no quote.
      return { ok: true, json: async () => ({}) } as Response;
    }
    return {
      ok: true,
      json: async () => ({ [symbol]: { eur: 80.5 } }),
    } as Response;
  });
  return {
    fetchMock,
    releaseAll: () => {
      // Open the gate so any future batch resolves immediately, then drain the
      // calls already waiting.
      open = true;
      while (release.length > 0) {
        const next = release.shift();
        next?.();
      }
    },
  };
}

function coingeckoAsset(id: string) {
  return {
    id,
    currency: "EUR",
    liquidityTier: "market" as const,
    priceProvider: "coingecko" as const,
    providerSymbol: id.toUpperCase(),
  };
}

describe("refreshStalePrices concurrency bounding (issue #202)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("exposes a documented concurrency limit constant", () => {
    expect(typeof REFRESH_CONCURRENCY_LIMIT).toBe("number");
    expect(REFRESH_CONCURRENCY_LIMIT).toBeGreaterThan(0);
  });

  test("never exceeds the concurrency limit with more assets than the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const { fetchMock, releaseAll } = makeGatedCoinGeckoFetch({
      onStart: () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
      },
      onEnd: () => {
        inFlight -= 1;
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const count = REFRESH_CONCURRENCY_LIMIT * 3 + 1;
    const ids = Array.from({ length: count }, (_, i) => `s${i}`);

    const promise = refreshStalePrices(
      ids.map((id) => stalePrice(id)),
      ids.map((id) => coingeckoAsset(id)),
      "2026-06-09T10:00:00Z",
    );

    // Let microtasks flush so the first wave of fetches can register as in-flight.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // With unbounded Promise.all, every fetch starts at once and peak === count.
    expect(peak).toBeLessThanOrEqual(REFRESH_CONCURRENCY_LIMIT);

    releaseAll();
    const result = await promise;

    expect(result.refreshed).toHaveLength(count);
    expect(result.updated).toBe(count);
    expect(peak).toBeLessThanOrEqual(REFRESH_CONCURRENCY_LIMIT);
  });

  test("preserves order and result mapping when batching", async () => {
    const { fetchMock, releaseAll } = makeGatedCoinGeckoFetch({});
    vi.stubGlobal("fetch", fetchMock);

    const count = REFRESH_CONCURRENCY_LIMIT * 2 + 1;
    const ids = Array.from({ length: count }, (_, i) => `m${i}`);

    const promise = refreshStalePrices(
      ids.map((id) => stalePrice(id)),
      ids.map((id) => coingeckoAsset(id)),
      "2026-06-09T10:00:00Z",
    );
    releaseAll();
    const result = await promise;

    // refreshed[i] must align with assets[i] regardless of batch completion order.
    ids.forEach((id, i) => {
      expect(result.refreshed[i]!.assetId).toBe(id);
    });
  });

  test("preserves partial-failure semantics when batched over the limit", async () => {
    const count = REFRESH_CONCURRENCY_LIMIT * 2 + 1;
    const ids = Array.from({ length: count }, (_, i) => `p${i}`);
    // Fail the assets at even indices.
    const failing = new Set(
      ids.filter((_, i) => i % 2 === 0).map((id) => id.toLowerCase()),
    );
    const { fetchMock, releaseAll } = makeGatedCoinGeckoFetch({
      failingSymbols: failing,
    });
    vi.stubGlobal("fetch", fetchMock);

    // No prior cache rows: a miss must surface as a failure instead of preserving
    // a good price (the preservation path has its own tests above).
    const promise = refreshStalePrices(
      [],
      ids.map((id) => coingeckoAsset(id)),
      "2026-06-09T10:00:00Z",
    );
    releaseAll();
    const result = await promise;

    const expectedFailures = ids.filter((_, i) => i % 2 === 0);
    expect(result.refreshed).toHaveLength(count);
    expect(result.updated).toBe(count - expectedFailures.length);
    expect(result.failedSymbols.sort()).toEqual(
      expectedFailures.map((id) => id.toUpperCase()).sort(),
    );
    expect(result.failures).toHaveLength(expectedFailures.length);
    for (const failure of result.failures) {
      expect(failure.reason).toBe("CoinGecko: sin cotización");
    }
    // Never throws: a normal result is returned even with failures interleaved.
    expect(result.refreshed.every((p) => p.assetId.startsWith("p"))).toBe(true);
  });

  test("invokes onRefreshed once per refreshable asset across batches", async () => {
    const { fetchMock, releaseAll } = makeGatedCoinGeckoFetch({});
    vi.stubGlobal("fetch", fetchMock);

    const count = REFRESH_CONCURRENCY_LIMIT * 2 + 1;
    const ids = Array.from({ length: count }, (_, i) => `c${i}`);
    const seen: string[] = [];

    const promise = refreshStalePrices(
      ids.map((id) => stalePrice(id)),
      ids.map((id) => coingeckoAsset(id)),
      "2026-06-09T10:00:00Z",
      { onRefreshed: (price) => seen.push(price.assetId) },
    );
    releaseAll();
    await promise;

    expect(seen).toHaveLength(count);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  test("makes no provider calls when nothing is refreshable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshStalePrices([], [], "2026-06-09T10:00:00Z");

    expect(result).toEqual({
      refreshed: [],
      updated: 0,
      failedSymbols: [],
      failures: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
