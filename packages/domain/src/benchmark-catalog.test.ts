import { describe, expect, test } from "vitest";

import {
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

  test("carries a coverage note per series", () => {
    expect(benchmarkCoverageNote("msci-world-tr")).toContain("EUNL");
    expect(benchmarkCoverageNote("msci-world-price")).toContain("USD");
    expect(benchmarkCoverageNote("unknown")).toBeNull();
  });
});
