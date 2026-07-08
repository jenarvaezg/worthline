import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { BenchmarkComparison } from "@worthline/domain";

import BenchmarkComparisonCard from "./benchmark-comparison-card";

const comparison: BenchmarkComparison = {
  benchmarkAnnualGrowth: 0.04,
  benchmarkGrowth: 0.04,
  points: [],
  realAnnualGrowth: 1.1 / 1.04 - 1,
  realGrowth: 1.1 / 1.04 - 1,
  sinceDate: "2023-01-31",
  subjectAnnualGrowth: 0.1,
  subjectGrowth: 0.1,
  untilDate: "2024-01-31",
};

describe("BenchmarkComparisonCard", () => {
  test("renders the real net-worth verdict first with CPI context", () => {
    const markup = renderToStaticMarkup(
      <BenchmarkComparisonCard result={{ comparison }} />,
    );

    expect(markup).toContain("Patrimonio real");
    expect(markup).toContain("incluye aportaciones");
    expect(markup).toContain("+5,8 pp/año real");
    expect(markup).toContain("IPC");
    expect(markup).toContain("+4,0 %");
    expect(markup).toContain("100 €");
    expect(markup).toContain("106 €");
  });

  test("renders an honest empty state when CPI is unavailable", () => {
    const markup = renderToStaticMarkup(
      <BenchmarkComparisonCard
        result={{
          comparison: null,
          unavailableReason: "benchmark_unavailable",
        }}
      />,
    );

    expect(markup).toContain("Sin datos de IPC todavía");
    expect(markup).not.toContain("pp/año real");
  });
});
