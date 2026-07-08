import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { HoldingBenchmarkComparison } from "@worthline/domain";

import HoldingBenchmarkComparisonCard from "./holding-benchmark-comparison-card";

const comparison: HoldingBenchmarkComparison = {
  benchmarkAnnualGrowth: 0.04,
  benchmarkGrowth: 0.04,
  coverageNote: "Rentabilidad total (ETF acumulador EUR, EUNL).",
  points: [],
  realAnnualGrowth: 1.1 / 1.04 - 1,
  realGrowth: 1.1 / 1.04 - 1,
  seriesId: "msci-world-tr",
  sinceDate: "2023-01-31",
  subjectAnnualGrowth: 0.1,
  subjectGrowth: 0.1,
  trackedIndex: "MSCI World",
  untilDate: "2024-01-31",
  variant: "total_return",
};

describe("HoldingBenchmarkComparisonCard", () => {
  test("renders the TWR vs index verdict with coverage note", () => {
    const markup = renderToStaticMarkup(
      <HoldingBenchmarkComparisonCard
        result={{ comparison }}
        trackedIndex="MSCI World"
      />,
    );

    expect(markup).toContain("vs MSCI World");
    expect(markup).toContain("TWR sin aportaciones");
    expect(markup).toContain("+5,8 pp/año");
    expect(markup).toContain("Índice/año");
    expect(markup).toContain("EUNL");
    expect(markup).toContain("100 €");
    expect(markup).toContain("106 €");
  });

  test("renders an honest empty state when the benchmark is unavailable", () => {
    const markup = renderToStaticMarkup(
      <HoldingBenchmarkComparisonCard
        result={{
          comparison: null,
          unavailableReason: "benchmark_unavailable",
        }}
        trackedIndex="MSCI World"
      />,
    );

    expect(markup).toContain("Sin datos del índice todavía");
    expect(markup).not.toContain("pp/año");
  });
});
