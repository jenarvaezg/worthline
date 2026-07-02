import type { AssetPrice } from "@worthline/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coingeckoProvider } from "./coingecko";
import { finectProvider } from "./finect";
import { fetchAndCachePrice } from "./index";
import { fetchWithFallback } from "./registry";
import { stooqProvider } from "./stooq";
import { yahooProvider } from "./yahoo";

const baseCtx = {
  assetId: "asset-1",
  currency: "EUR",
  nowIso: "2024-01-15T12:00:00.000Z",
  symbol: "bitcoin",
};

describe("coingeckoProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchPrice returns price and currency on successful response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ bitcoin: { eur: 50000 } }),
    } as Response);

    const result = await coingeckoProvider.fetchPrice(baseCtx);

    expect(result).toEqual({ price: "50000", currency: "EUR" });
  });

  it("normalizes the symbol to a lowercase coin id (trims + lowercases)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ bitcoin: { eur: 50000 } }),
    } as Response);

    const result = await coingeckoProvider.fetchPrice({
      ...baseCtx,
      symbol: "  Bitcoin  ",
    });

    expect(result).toEqual({ price: "50000", currency: "EUR" });
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toContain("ids=bitcoin");
  });

  it("fetchPrice returns null for unknown symbol (empty response object)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    } as Response);

    const result = await coingeckoProvider.fetchPrice(baseCtx);

    expect(result).toBeNull();
  });

  it("fetchPrice returns null when response is not ok", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
    } as Response);

    const result = await coingeckoProvider.fetchPrice(baseCtx);

    expect(result).toBeNull();
  });

  describe("WORTHLINE_COINGECKO_API_KEY — demo-key rate-limit headroom", () => {
    const ORIGINAL = process.env.WORTHLINE_COINGECKO_API_KEY;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.WORTHLINE_COINGECKO_API_KEY;
      else process.env.WORTHLINE_COINGECKO_API_KEY = ORIGINAL;
    });

    it("sends the x-cg-demo-api-key header when the key env is set", async () => {
      process.env.WORTHLINE_COINGECKO_API_KEY = "  CG-test-key  ";
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ bitcoin: { eur: 50000 } }),
      } as Response);

      await coingeckoProvider.fetchPrice(baseCtx);

      const init = vi.mocked(fetch).mock.calls[0]![1];
      expect(init?.headers).toEqual({ "x-cg-demo-api-key": "CG-test-key" });
    });

    it("sends no demo-key header when the key env is absent", async () => {
      delete process.env.WORTHLINE_COINGECKO_API_KEY;
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ bitcoin: { eur: 50000 } }),
      } as Response);

      await coingeckoProvider.fetchPrice(baseCtx);

      const init = vi.mocked(fetch).mock.calls[0]![1];
      expect(init?.headers).toEqual({});
    });
  });
});

describe("stooqProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses valid CSV with header + data line", async () => {
    const csv =
      "Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL,2024-01-15,16:00:00,180.00,182.50,179.50,181.25,55000000";
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => csv,
    } as Response);

    const result = await stooqProvider.fetchPrice({ ...baseCtx, symbol: "aapl.us" });

    expect(result).toEqual({ price: "181.25", currency: "EUR", priceDate: "2024-01-15" });
  });

  it("reports a no-quote failure when close price is N/D", async () => {
    const csv =
      "Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL,2024-01-15,16:00:00,N/D,N/D,N/D,N/D,0";
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => csv,
    } as Response);

    const result = await stooqProvider.fetchPrice({ ...baseCtx, symbol: "aapl.us" });

    expect(result).toEqual({
      failed: true,
      reason: "El proveedor no devolvió cotización",
    });
  });

  it("reports a symbol-not-found failure when the CSV has no data row", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => "Symbol,Date,Time,Open,High,Low,Close,Volume",
    } as Response);

    const result = await stooqProvider.fetchPrice({ ...baseCtx, symbol: "nope.us" });

    expect(result).toEqual({
      failed: true,
      reason: "Símbolo no encontrado en el proveedor",
    });
  });

  it("reports an HTTP-error failure when response is not ok", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as Response);

    const result = await stooqProvider.fetchPrice({ ...baseCtx, symbol: "aapl.us" });

    expect(result).toEqual({
      failed: true,
      reason: "El proveedor respondió con un error (500)",
    });
  });
});

describe("yahooProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses the latest regular market price from Yahoo chart responses", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        chart: {
          result: [
            {
              meta: {
                currency: "EUR",
                regularMarketPrice: 123.45,
              },
            },
          ],
        },
      }),
    } as Response);

    const result = await yahooProvider.fetchPrice({ ...baseCtx, symbol: "SAN.MC" });

    expect(result).toEqual({ price: "123.45", currency: "EUR" });
  });

  it("prefers the latest valid chart close over stale Yahoo metadata", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        chart: {
          result: [
            {
              meta: {
                currency: "EUR",
                regularMarketPrice: 21.22,
              },
              timestamp: [1781074800, 1781161200, 1781247600, 1781506800],
              indicators: {
                quote: [
                  {
                    close: [
                      40.507999420166016,
                      40.746498107910156,
                      41.500999450683594,
                      null,
                    ],
                  },
                ],
              },
            },
          ],
        },
      }),
    } as Response);

    const result = await yahooProvider.fetchPrice({
      ...baseCtx,
      symbol: "IE0007987708.IR",
    });

    expect(result).toEqual({
      price: "41.50099945",
      currency: "EUR",
      priceDate: "2026-06-12",
    });
  });

  it("returns null for dead Yahoo listings whose latest market date is stale", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        chart: {
          result: [
            {
              meta: {
                currency: "EUR",
                regularMarketPrice: 20.28,
              },
              timestamp: [1443744000],
              indicators: {
                quote: [{ close: [20.28] }],
              },
            },
          ],
        },
      }),
    } as Response);

    const result = await yahooProvider.fetchPrice({
      ...baseCtx,
      nowIso: "2026-07-02T08:00:00.000Z",
      symbol: "IE00B4ND3602.IR",
    });

    expect(result).toBeNull();
  });

  it("converts non-EUR Yahoo prices to EUR through ECB rates", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          chart: {
            result: [
              {
                meta: {
                  currency: "USD",
                  regularMarketPrice: 100,
                },
              },
            ],
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          dataSets: [
            {
              series: {
                "0:0:0:0:0": {
                  observations: {
                    "0": [1.25],
                  },
                },
              },
            },
          ],
        }),
      } as Response);

    const result = await yahooProvider.fetchPrice({ ...baseCtx, symbol: "AAPL" });

    expect(result).toEqual({ price: "80", currency: "EUR" });
  });

  // The Yahoo→Stooq fallback is now POLICY (issue #243): the chain lives in
  // `./registry` and is applied by `fetchWithFallback`, not inside yahoo.ts.
  // These assert the same observable outcome through the policy runner +
  // `fetchAndCachePrice` (which honours the deliverer's stamped `source`).
  it("falls back to Stooq and records Stooq as the source when Yahoo has no price", async () => {
    const csv =
      "Symbol,Date,Time,Open,High,Low,Close,Volume\nSAN,2024-01-15,16:00:00,4.10,4.30,4.05,4.25,55000000";
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => csv,
      } as Response);

    const result = await fetchAndCachePrice(
      { name: "yahoo", fetchPrice: (ctx) => fetchWithFallback("yahoo", ctx) },
      { ...baseCtx, symbol: "SAN.MC" },
    );

    expect(result.freshnessState).toBe("fresh");
    expect(result.price).toBe("4.25");
    expect(result.source).toBe("stooq");
  });

  it("propagates the Stooq failure reason when both Yahoo and Stooq fail", async () => {
    const csv =
      "Symbol,Date,Time,Open,High,Low,Close,Volume\nNOPE,2024-01-15,16:00:00,N/D,N/D,N/D,N/D,0";
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => csv } as Response);

    const result = await fetchAndCachePrice(
      { name: "yahoo", fetchPrice: (ctx) => fetchWithFallback("yahoo", ctx) },
      { ...baseCtx, symbol: "NOPE.MC" },
    );

    expect(result.freshnessState).toBe("failed");
    expect(result.staleReason).toBe("El proveedor no devolvió cotización");
  });

  it("falls back to Stooq when the Yahoo request throws", async () => {
    const csv =
      "Symbol,Date,Time,Open,High,Low,Close,Volume\nSAN,2024-01-15,16:00:00,4.10,4.30,4.05,4.25,55000000";
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({
        ok: true,
        text: async () => csv,
      } as Response);

    const result = await fetchAndCachePrice(
      { name: "yahoo", fetchPrice: (ctx) => fetchWithFallback("yahoo", ctx) },
      { ...baseCtx, symbol: "SAN.MC" },
    );

    expect(result.freshnessState).toBe("fresh");
    expect(result.source).toBe("stooq");
  });
});

describe("finectProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses the pension plan NAV and valuation date from server-rendered HTML", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => `
        <html>
          <body>
            <h1>MyInvestor Indexado S&P 500 PP</h1>
            <p>Valor liquidativo</p>
            <strong>20,63 €</strong>
            <span>Fecha de valor liquidativo: 10/06/2026</span>
          </body>
        </html>
      `,
    } as Response);

    const result = await finectProvider.fetchPrice({ ...baseCtx, symbol: "N5394" });

    expect(result).toEqual({
      price: "20.63",
      currency: "EUR",
      priceDate: "2026-06-10",
    });
  });

  it("reports a symbol-not-found failure for the 'Producto no disponible' soft-404 page", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => `
        <html>
          <body>
            <h1>Producto no disponible</h1>
            <p>El plan que buscas no está disponible en Finect.</p>
          </body>
        </html>
      `,
    } as Response);

    const result = await finectProvider.fetchPrice({ ...baseCtx, symbol: "NOPE" });

    expect(result).toEqual({
      failed: true,
      reason: "Símbolo no encontrado en el proveedor",
    });
  });

  it("reports an HTTP-error failure when Finect responds with a non-2xx status", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 503 } as Response);

    const result = await finectProvider.fetchPrice({ ...baseCtx, symbol: "N5394" });

    expect(result).toEqual({
      failed: true,
      reason: "El proveedor respondió con un error (503)",
    });
  });
});

describe("fetchAndCachePrice", () => {
  it("returns failed AssetPrice when provider returns null", async () => {
    const provider = {
      name: "stooq" as const,
      fetchPrice: async () => null,
    };

    const result: AssetPrice = await fetchAndCachePrice(provider, baseCtx);

    expect(result.freshnessState).toBe("failed");
    expect(result.assetId).toBe("asset-1");
    expect(result.source).toBe("stooq");
    expect(result.staleReason).toBe("No price returned");
  });

  it("surfaces a discriminated provider failure reason as staleReason", async () => {
    const provider = {
      name: "finect" as const,
      fetchPrice: async () => ({
        failed: true as const,
        reason: "Símbolo no encontrado en el proveedor",
      }),
    };

    const result: AssetPrice = await fetchAndCachePrice(provider, baseCtx);

    expect(result.freshnessState).toBe("failed");
    expect(result.staleReason).toBe("Símbolo no encontrado en el proveedor");
    expect(result.source).toBe("finect");
  });

  it("returns failed AssetPrice when provider throws", async () => {
    const provider = {
      name: "coingecko" as const,
      fetchPrice: async (): Promise<null> => {
        throw new Error("Network timeout");
      },
    };

    const result: AssetPrice = await fetchAndCachePrice(provider, baseCtx);

    expect(result.freshnessState).toBe("failed");
    expect(result.staleReason).toBe("Network timeout");
  });

  it("returns fresh AssetPrice on successful fetch", async () => {
    const provider = {
      name: "stooq" as const,
      fetchPrice: async () => ({
        price: "42.50",
        currency: "EUR",
        priceDate: "2024-01-15",
      }),
    };

    const result: AssetPrice = await fetchAndCachePrice(provider, baseCtx);

    expect(result.freshnessState).toBe("fresh");
    expect(result.price).toBe("42.50");
    expect(result.currency).toBe("EUR");
    expect(result.priceDate).toBe("2024-01-15");
    expect(result.fetchedAt).toBe(baseCtx.nowIso);
  });

  it("returns failed AssetPrice when provider currency does not match asset currency", async () => {
    const provider = {
      name: "stooq" as const,
      fetchPrice: async () => ({
        price: "42.50",
        currency: "USD",
      }),
    };

    const result: AssetPrice = await fetchAndCachePrice(provider, baseCtx);

    expect(result.freshnessState).toBe("failed");
    expect(result.currency).toBe("EUR");
    expect(result.price).toBe("0");
    expect(result.staleReason).toBe(
      "La divisa del proveedor (USD) no coincide con la del activo (EUR)",
    );
  });
});
