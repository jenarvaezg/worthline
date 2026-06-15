import type { AssetPrice } from "@worthline/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { REFRESH_CONCURRENCY_LIMIT, refreshStalePrices } from "./refresh-stale-prices";

function stalePrice(assetId: string): AssetPrice {
  return {
    assetId,
    currency: "EUR",
    fetchedAt: "2026-06-08T10:00:00Z",
    freshnessState: "fresh",
    price: "100",
    source: "stooq",
  };
}

describe("refreshStalePrices provider routing", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("retirement investments default to Finect when no price provider is set", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => `
        <p>Valor liquidativo</p>
        <strong>20,63 €</strong>
        <span>Fecha de valor liquidativo: 10/06/2026</span>
      `,
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
      price: "20.63",
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

  test("surfaces each failed symbol with its human-readable reason", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => "<h1>Producto no disponible</h1>",
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
      { symbol: "N5394", reason: "Símbolo no encontrado en el proveedor" },
    ]);
  });

  test("explicit price provider overrides the liquidity-tier default", async () => {
    const csv =
      "Symbol,Date,Time,Open,High,Low,Close,Volume\nVUSA,2026-06-09,16:00:00,80,81,79,80.50,1234";
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => csv,
    } as Response);

    const result = await refreshStalePrices(
      [stalePrice("asset-direct-stooq")],
      [
        {
          id: "asset-direct-stooq",
          currency: "EUR",
          liquidityTier: "market",
          priceProvider: "stooq",
          providerSymbol: "VUSA.L",
        },
      ],
      "2026-06-09T10:00:00Z",
    );

    expect(result.refreshed[0]).toMatchObject({
      assetId: "asset-direct-stooq",
      price: "80.50",
      source: "stooq",
    });
  });
});

/**
 * Builds a controllable Stooq CSV `fetch` mock that lets the test observe how
 * many provider calls are in flight at once (issue #202). Each call resolves
 * only after the test releases it, so the peak concurrency is deterministic.
 */
function makeGatedStooqFetch(opts: {
  failingSymbols?: Set<string>;
  onStart?: () => void;
  onEnd?: () => void;
}) {
  let open = false;
  const release: Array<() => void> = [];
  const fetchMock = vi.fn(async (url: string) => {
    opts.onStart?.();
    // Stooq URL carries the symbol as the `s` query param.
    const symbol = new URL(url, "https://stooq.com").searchParams.get("s") ?? "";
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
      // Symbol row present but close is "N/D" -> provider returns no quote.
      return {
        ok: true,
        text: async () =>
          `Symbol,Date,Time,Open,High,Low,Close,Volume\n${symbol.toUpperCase()},2026-06-09,16:00:00,N/D,N/D,N/D,N/D,0`,
      } as Response;
    }
    return {
      ok: true,
      text: async () =>
        `Symbol,Date,Time,Open,High,Low,Close,Volume\n${symbol.toUpperCase()},2026-06-09,16:00:00,80,81,79,80.50,1234`,
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

function stooqAsset(id: string) {
  return {
    id,
    currency: "EUR",
    liquidityTier: "market" as const,
    priceProvider: "stooq" as const,
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
    const { fetchMock, releaseAll } = makeGatedStooqFetch({
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
      ids.map((id) => stooqAsset(id)),
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
    const { fetchMock, releaseAll } = makeGatedStooqFetch({});
    vi.stubGlobal("fetch", fetchMock);

    const count = REFRESH_CONCURRENCY_LIMIT * 2 + 1;
    const ids = Array.from({ length: count }, (_, i) => `m${i}`);

    const promise = refreshStalePrices(
      ids.map((id) => stalePrice(id)),
      ids.map((id) => stooqAsset(id)),
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
    const { fetchMock, releaseAll } = makeGatedStooqFetch({
      failingSymbols: failing,
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = refreshStalePrices(
      ids.map((id) => stalePrice(id)),
      ids.map((id) => stooqAsset(id)),
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
      expect(failure.reason).toBe("El proveedor no devolvió cotización");
    }
    // Never throws: a normal result is returned even with failures interleaved.
    expect(result.refreshed.every((p) => p.assetId.startsWith("p"))).toBe(true);
  });

  test("invokes onRefreshed once per refreshable asset across batches", async () => {
    const { fetchMock, releaseAll } = makeGatedStooqFetch({});
    vi.stubGlobal("fetch", fetchMock);

    const count = REFRESH_CONCURRENCY_LIMIT * 2 + 1;
    const ids = Array.from({ length: count }, (_, i) => `c${i}`);
    const seen: string[] = [];

    const promise = refreshStalePrices(
      ids.map((id) => stalePrice(id)),
      ids.map((id) => stooqAsset(id)),
      "2026-06-09T10:00:00Z",
      (price) => seen.push(price.assetId),
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
