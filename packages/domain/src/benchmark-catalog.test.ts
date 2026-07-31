import { describe, expect, test } from "vitest";

import {
  BENCHMARK_CATALOG,
  benchmarkCoverageNote,
  listMarketIndexSeriesIds,
  listTrackedIndexLabels,
  resolveBenchmarkSeriesId,
} from "./benchmark-catalog";

describe("benchmark catalog", () => {
  test("lists every market-index series for cron backfill", () => {
    expect(listMarketIndexSeriesIds()).toEqual([
      "sp500-tr",
      "sp500-price",
      "msci-world-tr",
      "msci-world-price",
      "msci-acwi-tr",
      "msci-acwi-price",
      "nasdaq-100-tr",
      "nasdaq-100-price",
      "gold-tr",
      "gold-price",
    ]);
  });

  test("exposes tracked-index labels for the exposure picker", () => {
    expect(listTrackedIndexLabels()).toEqual([
      "Gold",
      "MSCI ACWI",
      "MSCI World",
      "Nasdaq-100",
      "S&P 500",
    ]);
  });

  test("resolves accumulating holdings to total-return series", () => {
    expect(resolveBenchmarkSeriesId("MSCI World", false)).toBe("msci-world-tr");
    expect(resolveBenchmarkSeriesId("Nasdaq-100", false)).toBe("nasdaq-100-tr");
  });

  test("resolves distributing holdings to price-index series", () => {
    expect(resolveBenchmarkSeriesId("MSCI World", true)).toBe("msci-world-price");
    expect(resolveBenchmarkSeriesId("S&P 500", true)).toBe("sp500-price");
  });

  test("returns null for unknown labels", () => {
    expect(resolveBenchmarkSeriesId("FTSE All-World", false)).toBeNull();
    expect(resolveBenchmarkSeriesId("", false)).toBeNull();
    expect(resolveBenchmarkSeriesId(null, false)).toBeNull();
  });

  test("every series carries a Yahoo symbol, never a lower-case Stooq one (#1354)", () => {
    // Stooq symbols were lower-case with an exchange suffix (`sxr8.de`, `^spx`);
    // Yahoo's are upper-case (`SXR8.DE`, `^GSPC`, `GC=F`). A lower-case letter
    // here means a Stooq leftover survived the retirement.
    for (const entry of BENCHMARK_CATALOG) {
      expect(entry.yahooSymbol).toBe(entry.yahooSymbol.toUpperCase());
      expect(entry.yahooSymbol).not.toBe("");
    }
    expect(
      BENCHMARK_CATALOG.find((entry) => entry.seriesId === "sp500-price")?.yahooSymbol,
    ).toBe("^GSPC");
  });

  test("carries a coverage note per series", () => {
    expect(benchmarkCoverageNote("msci-world-tr")).toContain("EUNL");
    expect(benchmarkCoverageNote("msci-world-price")).toContain("USD");
    expect(benchmarkCoverageNote("unknown")).toBeNull();
  });
});
