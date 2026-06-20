/**
 * Historical price source (#380, ADR 0033).
 *
 * The abstraction the backfill plan reads from: `fetchSeriesEur(providerSymbol,
 * fromMs, toMs)` → `{ pricesByDate, source }`. Two implementations:
 *  - CoinGecko: resolves the symbol → CoinGecko id and reuses the existing
 *    range fetch (`fetchCoinGeckoHistoryEur`); an unmapped symbol → empty series.
 *  - Manual CSV (date,price): the long-range fallback the user controls; gaps in
 *    the CSV stay gaps — prices are never invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coingeckoHistoricalSource, parsePriceCsv } from "./historical-price-source";

describe("coingeckoHistoricalSource (#380)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves a Binance-style symbol → CoinGecko id and fetches the EUR series", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        prices: [
          [Date.UTC(2026, 1, 1, 12, 0), 40000],
          [Date.UTC(2026, 2, 1, 12, 0), 50000],
        ],
      }),
    } as Response);

    const result = await coingeckoHistoricalSource.fetchSeriesEur(
      "BTC",
      Date.UTC(2026, 1, 1),
      Date.UTC(2026, 2, 1),
    );

    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      "/coins/bitcoin/market_chart/range",
    );
    expect(result.source).toBe("coingecko");
    expect(result.pricesByDate).toEqual(
      new Map([
        ["2026-02-01", "40000"],
        ["2026-03-01", "50000"],
      ]),
    );
  });

  it("accepts a bare CoinGecko id directly (provider symbol = 'bitcoin')", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ prices: [[Date.UTC(2026, 1, 1, 12, 0), 40000]] }),
    } as Response);

    await coingeckoHistoricalSource.fetchSeriesEur("bitcoin", 0, 1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      "/coins/bitcoin/market_chart/range",
    );
  });

  it("returns an EMPTY series for an unmapped symbol — never fetches, never invents", async () => {
    const result = await coingeckoHistoricalSource.fetchSeriesEur("WAGMI", 0, 1);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.pricesByDate.size).toBe(0);
    expect(result.source).toBe("coingecko");
  });

  it("degrades a provider outage to an empty series (never throws)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    const result = await coingeckoHistoricalSource.fetchSeriesEur("BTC", 0, 1);
    expect(result.pricesByDate.size).toBe(0);
  });
});

describe("parsePriceCsv (#380) — manual long-range fallback", () => {
  it("parses date,price rows into a dateKey → decimal map", () => {
    const csv = "date,price\n2021-01-01,29000\n2021-02-01,33000\n";
    expect(parsePriceCsv(csv)).toEqual(
      new Map([
        ["2021-01-01", "29000"],
        ["2021-02-01", "33000"],
      ]),
    );
  });

  it("tolerates a header-less CSV and whitespace", () => {
    const csv = " 2021-01-01 , 29000 \n2021-02-01,33000";
    expect(parsePriceCsv(csv)).toEqual(
      new Map([
        ["2021-01-01", "29000"],
        ["2021-02-01", "33000"],
      ]),
    );
  });

  it("skips blank and malformed rows — gaps stay gaps, no fabricated price", () => {
    const csv = "2021-01-01,29000\n\nnot-a-date,oops\n2021-02-01,33000\n2021-03-01,";
    expect(parsePriceCsv(csv)).toEqual(
      new Map([
        ["2021-01-01", "29000"],
        ["2021-02-01", "33000"],
      ]),
    );
  });

  it("returns an empty map for an empty CSV", () => {
    expect(parsePriceCsv("")).toEqual(new Map());
  });

  it("skips a negative price row (a bad row stays a gap, never frozen)", () => {
    const csv = "2021-01-01,-5\n2021-02-01,33000";
    expect(parsePriceCsv(csv)).toEqual(new Map([["2021-02-01", "33000"]]));
  });

  it("skips a zero price (0 is 'no price' → a gap, not a frozen 0-value month)", () => {
    const csv = "2021-01-01,0\n2021-02-01,33000";
    expect(parsePriceCsv(csv)).toEqual(new Map([["2021-02-01", "33000"]]));
  });

  it("on a duplicate date the LAST row wins (Map override semantics)", () => {
    const csv = "2021-01-01,29000\n2021-01-01,31000";
    expect(parsePriceCsv(csv)).toEqual(new Map([["2021-01-01", "31000"]]));
  });
});
