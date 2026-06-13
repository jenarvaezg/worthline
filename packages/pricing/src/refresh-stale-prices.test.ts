import type { AssetPrice } from "@worthline/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { refreshStalePrices } from "./refresh-stale-prices";

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
          liquidityTier: "retirement",
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
          liquidityTier: "retirement",
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
