import type { AssetPrice } from "@worthline/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coingeckoProvider } from "./coingecko";
import { finectProvider } from "./finect";
import { fetchAndCachePrice } from "./index";
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

  it("canFetch returns true when symbol is present", () => {
    expect(coingeckoProvider.canFetch(baseCtx)).toBe(true);
  });

  it("canFetch returns false when symbol is empty", () => {
    expect(coingeckoProvider.canFetch({ ...baseCtx, symbol: "" })).toBe(false);
  });

  it("fetchPrice returns price and currency on successful response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ bitcoin: { eur: 50000 } }),
    } as Response);

    const result = await coingeckoProvider.fetchPrice(baseCtx);

    expect(result).toEqual({ price: "50000", currency: "EUR" });
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
});

describe("stooqProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("canFetch returns true when symbol is present", () => {
    expect(stooqProvider.canFetch({ ...baseCtx, symbol: "aapl.us" })).toBe(true);
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

  it("returns null when close price is N/D", async () => {
    const csv =
      "Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL,2024-01-15,16:00:00,N/D,N/D,N/D,N/D,0";
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => csv,
    } as Response);

    const result = await stooqProvider.fetchPrice({ ...baseCtx, symbol: "aapl.us" });

    expect(result).toBeNull();
  });

  it("returns null when response is not ok", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);

    const result = await stooqProvider.fetchPrice({ ...baseCtx, symbol: "aapl.us" });

    expect(result).toBeNull();
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

  it("falls back to Stooq and records Stooq as the source when Yahoo has no price", async () => {
    const csv =
      "Symbol,Date,Time,Open,High,Low,Close,Volume\nSAN,2024-01-15,16:00:00,4.10,4.30,4.05,4.25,55000000";
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => csv,
      } as Response);

    const result = await fetchAndCachePrice(yahooProvider, {
      ...baseCtx,
      symbol: "SAN.MC",
    });

    expect(result.freshnessState).toBe("fresh");
    expect(result.price).toBe("4.25");
    expect(result.source).toBe("stooq");
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

    const result = await fetchAndCachePrice(yahooProvider, {
      ...baseCtx,
      symbol: "SAN.MC",
    });

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
});

describe("fetchAndCachePrice", () => {
  it("returns failed AssetPrice when provider returns null", async () => {
    const provider = {
      name: "stooq" as const,
      canFetch: () => true,
      fetchPrice: async () => null,
    };

    const result: AssetPrice = await fetchAndCachePrice(provider, baseCtx);

    expect(result.freshnessState).toBe("failed");
    expect(result.assetId).toBe("asset-1");
    expect(result.source).toBe("stooq");
    expect(result.staleReason).toBe("No price returned");
  });

  it("returns failed AssetPrice when provider throws", async () => {
    const provider = {
      name: "coingecko" as const,
      canFetch: () => true,
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
      canFetch: () => true,
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
});
