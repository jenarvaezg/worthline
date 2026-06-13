import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { searchSymbols, searchYahooSymbols } from "./search";

describe("searchYahooSymbols", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps Yahoo quotes to candidates, preferring longname and exchDisp", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        quotes: [
          {
            symbol: "0P0001CLDK.F",
            longname: "Fidelity MSCI World Index Fund P-ACC-EUR",
            exchDisp: "Frankfurt",
            quoteType: "MUTUALFUND",
          },
        ],
      }),
    } as Response);

    const result = await searchYahooSymbols("IE00BYX5NX33");

    expect(result).toEqual([
      {
        provider: "yahoo",
        symbol: "0P0001CLDK.F",
        name: "Fidelity MSCI World Index Fund P-ACC-EUR",
        exchange: "Frankfurt",
        quoteType: "MUTUALFUND",
      },
    ]);
  });

  it("filters out irrelevant quote types and entries without a symbol", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        quotes: [
          { symbol: "AAPL", shortname: "Apple Inc.", quoteType: "EQUITY" },
          { symbol: "BTC-USD", shortname: "Bitcoin", quoteType: "CRYPTOCURRENCY" },
          { shortname: "No symbol", quoteType: "ETF" },
        ],
      }),
    } as Response);

    const result = await searchYahooSymbols("apple");

    expect(result).toEqual([
      { provider: "yahoo", symbol: "AAPL", name: "Apple Inc.", quoteType: "EQUITY" },
    ]);
  });

  it("returns no results for a blank query without fetching", async () => {
    const result = await searchYahooSymbols("   ");

    expect(result).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("degrades to no results on a non-OK response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);

    expect(await searchYahooSymbols("anything")).toEqual([]);
  });

  it("degrades to no results when fetch throws", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network"));

    expect(await searchYahooSymbols("anything")).toEqual([]);
  });
});

describe("searchSymbols", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prepends a resolved Finect plan when the query looks like a plan slug", async () => {
    // First call: Yahoo search (no hits for a Finect slug). Second: Finect page.
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ quotes: [] }) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => `
          <html>
            <head><title>N5394 - Myinvestor Indexado S&amp;P 500 PP</title></head>
            <body><strong>20,29 €</strong>
            <span>Fecha de valor liquidativo: 10/06/2026</span></body>
          </html>
        `,
      } as Response);

    const result = await searchSymbols("N5394-Myinvestor");

    expect(result[0]).toEqual({
      provider: "finect",
      symbol: "N5394-Myinvestor",
      name: "N5394 - Myinvestor Indexado S&P 500 PP",
      currency: "EUR",
      quoteType: "PENSIONPLAN",
    });
  });

  it("does not attempt a Finect lookup for a plain ISIN/name query", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        quotes: [
          { symbol: "VWCE.DE", shortname: "Vanguard FTSE All-World", quoteType: "ETF" },
        ],
      }),
    } as Response);

    const result = await searchSymbols("vanguard all world");

    // Exactly one fetch (Yahoo only) — the slug heuristic did not fire.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]?.provider).toBe("yahoo");
  });
});
