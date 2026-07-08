import { describe, expect, test } from "vitest";

import type { InvestmentOperation } from "./investment-types";
import {
  compareHoldingToBenchmark,
  holdingBenchmarkComparison,
  holdingTwrIndexSeries,
} from "./holding-benchmark-comparison";

function op(
  kind: "buy" | "sell",
  units: string,
  pricePerUnit: string,
  executedAt: string,
): InvestmentOperation {
  return {
    assetId: "asset_inv",
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id: `op_${kind}_${executedAt}`,
    kind,
    pricePerUnit,
    units,
  };
}

describe("holding TWR index series", () => {
  test("chains Modified Dietz period returns into a 100-based index", () => {
    const series = holdingTwrIndexSeries({
      monthlyCloses: [
        { date: "2024-01-31", valueMinor: 100_000_00 },
        { date: "2024-02-29", valueMinor: 110_000_00 },
        { date: "2024-03-31", valueMinor: 121_000_00 },
      ],
      operations: [op("buy", "1000", "100", "2024-01-15")],
    });

    expect(series[0]).toEqual({ dateKey: "2024-01-31", value: 100 });
    expect(series[1]?.value).toBeCloseTo(110, 10);
    expect(series[2]?.value).toBeCloseTo(121, 10);
  });
});

describe("holding benchmark comparison", () => {
  test("compares the holding TWR index against the benchmark over the shared window", () => {
    const result = compareHoldingToBenchmark({
      benchmark: [
        { dateKey: "2024-01-01", value: 100 },
        { dateKey: "2024-02-01", value: 105 },
        { dateKey: "2024-03-01", value: 110 },
      ],
      monthlyCloses: [
        { date: "2024-01-31", valueMinor: 100_000_00 },
        { date: "2024-02-29", valueMinor: 120_000_00 },
        { date: "2024-03-31", valueMinor: 130_000_00 },
      ],
      operations: [op("buy", "1000", "100", "2024-01-15")],
      seriesId: "msci-world-tr",
      trackedIndex: "MSCI World",
      variant: "total_return",
    });

    expect(result.comparison?.seriesId).toBe("msci-world-tr");
    expect(result.comparison?.trackedIndex).toBe("MSCI World");
    expect(result.comparison?.variant).toBe("total_return");
    expect(result.comparison?.subjectGrowth).toBeCloseTo(0.3);
    expect(result.comparison?.benchmarkGrowth).toBeCloseTo(0.1);
    expect(result.comparison?.realGrowth).toBeCloseTo(0.18181818181818182);
    expect(result.comparison?.coverageNote).toContain("EUNL");
  });

  test("the distributing flag flips the resolved benchmark variant", () => {
    const accumulating = holdingBenchmarkComparison({
      benchmarkPrices: [
        { dateKey: "2024-01-01", value: "100" },
        { dateKey: "2024-03-01", value: "110" },
      ],
      distributing: false,
      monthlyCloses: [
        { date: "2024-01-31", valueMinor: 100_000_00 },
        { date: "2024-03-31", valueMinor: 110_000_00 },
      ],
      operations: [op("buy", "1000", "100", "2024-01-15")],
      trackedIndex: "MSCI World",
    });
    const distributing = holdingBenchmarkComparison({
      benchmarkPrices: [
        { dateKey: "2024-01-01", value: "100" },
        { dateKey: "2024-03-01", value: "105" },
      ],
      distributing: true,
      monthlyCloses: [
        { date: "2024-01-31", valueMinor: 100_000_00 },
        { date: "2024-03-31", valueMinor: 110_000_00 },
      ],
      operations: [op("buy", "1000", "100", "2024-01-15")],
      trackedIndex: "MSCI World",
    });

    expect(accumulating.comparison?.variant).toBe("total_return");
    expect(accumulating.comparison?.seriesId).toBe("msci-world-tr");
    expect(distributing.comparison?.variant).toBe("price");
    expect(distributing.comparison?.seriesId).toBe("msci-world-price");
    expect(distributing.comparison?.coverageNote).toContain("USD");
  });

  test("returns honest unavailable reasons", () => {
    expect(
      holdingBenchmarkComparison({
        benchmarkPrices: [],
        distributing: false,
        monthlyCloses: [],
        operations: [],
        trackedIndex: null,
      }),
    ).toEqual({ comparison: null, unavailableReason: "no_tracked_index" });

    expect(
      holdingBenchmarkComparison({
        benchmarkPrices: [],
        distributing: false,
        monthlyCloses: [],
        operations: [],
        trackedIndex: "FTSE All-World",
      }),
    ).toEqual({ comparison: null, unavailableReason: "benchmark_unmapped" });

    expect(
      holdingBenchmarkComparison({
        benchmarkPrices: [{ dateKey: "2024-03-01", value: "110" }],
        distributing: false,
        monthlyCloses: [{ date: "2024-01-31", valueMinor: 100_000_00 }],
        operations: [op("buy", "1000", "100", "2024-01-15")],
        trackedIndex: "MSCI World",
      }),
    ).toEqual({ comparison: null, unavailableReason: "twr_unavailable" });
  });
});
