/**
 * The price symbol of a product MyInvestor brings (#1880): «nobody quotes it» and
 * «the search failed» both leave the product valued at cost, but only the failure
 * is the server's to know about (#1876).
 */
import { describe, expect, test, vi } from "vitest";
import { myInvestorSymbolResolver } from "./myinvestor-symbol-search";

describe("the symbol lookup of «Incluir con su histórico»", () => {
  test("the first candidate of a provider worthline prices with", async () => {
    const resolve = myInvestorSymbolResolver(async () => [
      { provider: "finect", symbol: "IE0000000011-fondo" },
      { provider: "yahoo", symbol: "0P0000.F" },
    ]);

    expect(await resolve("IE0000000011", "fund")).toEqual({
      provider: "finect",
      symbol: "IE0000000011-fondo",
    });
  });

  test("nobody quotes it: null, and nothing is logged", async () => {
    const log = vi.fn();
    const resolve = myInvestorSymbolResolver(async () => [], log);

    expect(await resolve("IE0000000011", "fund")).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  test("the search failed: null too, but the server logs it, without the code", async () => {
    const log = vi.fn();
    const resolve = myInvestorSymbolResolver(async () => {
      throw new Error("socket hang up");
    }, log);

    expect(await resolve("IE0000000011", "etf")).toBeNull();
    expect(log).toHaveBeenCalledWith("[myinvestor] symbol search failed", {
      error: "socket hang up",
      instrument: "etf",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("IE0000000011");
  });
});
