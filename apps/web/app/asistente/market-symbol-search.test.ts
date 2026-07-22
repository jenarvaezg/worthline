import type { SymbolCandidate } from "@worthline/pricing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isMarketInstrument,
  resolveMarketSymbolCandidates,
} from "./market-symbol-search";

const searchSymbols = vi.hoisted(() => vi.fn());

vi.mock("@worthline/pricing", () => ({ searchSymbols }));

beforeEach(() => {
  searchSymbols.mockReset();
});

describe("isMarketInstrument (#1186)", () => {
  it("is true for the market instruments this tool resolves (AC1)", () => {
    for (const instrument of ["fund", "etf", "stock", "index", "crypto"]) {
      expect(isMarketInstrument(instrument as never)).toBe(true);
    }
  });

  it("is false for out-of-scope instruments and for nothing", () => {
    // pension_plan reprices by a Finect symbol but is out of this tool's scope
    // (the wizard's Finect flow owns it); the warning path still covers it.
    expect(isMarketInstrument("pension_plan" as never)).toBe(false);
    expect(isMarketInstrument("current_account" as never)).toBe(false);
    expect(isMarketInstrument("property" as never)).toBe(false);
    expect(isMarketInstrument(null)).toBe(false);
    expect(isMarketInstrument(undefined)).toBe(false);
  });
});

describe("resolveMarketSymbolCandidates (#1186)", () => {
  it("routes the instrument to searchSymbols and shapes candidates for disambiguation", async () => {
    const candidates: SymbolCandidate[] = [
      {
        provider: "yahoo",
        symbol: "VUSA.L",
        name: "Vanguard S&P 500 UCITS ETF",
        exchange: "LSE",
        currency: "GBP",
        quoteType: "ETF",
      },
      {
        provider: "yahoo",
        symbol: "VUSA.AS",
        name: "Vanguard S&P 500 UCITS ETF",
        exchange: "Amsterdam",
        currency: "EUR",
        quoteType: "ETF",
      },
    ];
    searchSymbols.mockResolvedValue(candidates);

    const matches = await resolveMarketSymbolCandidates("Vanguard S&P 500", "etf");

    expect(searchSymbols).toHaveBeenCalledWith("Vanguard S&P 500", "etf");
    // Same symbol, different market suffix → the market/currency keep them apart.
    expect(matches).toEqual([
      {
        provider: "yahoo",
        symbol: "VUSA.L",
        name: "Vanguard S&P 500 UCITS ETF",
        market: "LSE",
        currency: "GBP",
        quoteType: "ETF",
      },
      {
        provider: "yahoo",
        symbol: "VUSA.AS",
        name: "Vanguard S&P 500 UCITS ETF",
        market: "Amsterdam",
        currency: "EUR",
        quoteType: "ETF",
      },
    ]);
  });

  it("maps a crypto id (not the ticker) as the symbol, exposing the ticker as market", async () => {
    searchSymbols.mockResolvedValue([
      { provider: "coingecko", symbol: "bitcoin", name: "Bitcoin", exchange: "BTC" },
    ]);

    const matches = await resolveMarketSymbolCandidates("bitcoin", "crypto");

    expect(searchSymbols).toHaveBeenCalledWith("bitcoin", "crypto");
    expect(matches[0]).toEqual({
      provider: "coingecko",
      symbol: "bitcoin",
      name: "Bitcoin",
      market: "BTC",
    });
  });

  it("short-circuits a blank query with no network call", async () => {
    expect(await resolveMarketSymbolCandidates("   ")).toEqual([]);
    expect(searchSymbols).not.toHaveBeenCalled();
  });

  it("caps the candidate list to keep the tool output legible", async () => {
    searchSymbols.mockResolvedValue(
      Array.from({ length: 20 }, (_unused, i) => ({
        provider: "yahoo",
        symbol: `SYM${i}`,
        name: `Fund ${i}`,
      })),
    );

    const matches = await resolveMarketSymbolCandidates("fund", "fund");

    expect(matches).toHaveLength(8);
  });

  it("routes an unknown/non-market instrument as the mixed legacy search (undefined)", async () => {
    searchSymbols.mockResolvedValue([]);

    await resolveMarketSymbolCandidates("something", "current_account");

    expect(searchSymbols).toHaveBeenCalledWith("something", undefined);
  });
});
