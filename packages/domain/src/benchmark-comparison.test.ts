import { describe, expect, test } from "vitest";

import { compareGrowthToBenchmark } from "./benchmark-comparison";

describe("benchmark comparison", () => {
  test("rebases both series at the first shared month and returns the real growth", () => {
    const result = compareGrowthToBenchmark({
      benchmark: [
        { dateKey: "2024-01-01", value: 100 },
        { dateKey: "2024-02-01", value: 105 },
        { dateKey: "2024-03-01", value: 110 },
      ],
      subject: [
        { dateKey: "2024-01-31", value: 100_000_00 },
        { dateKey: "2024-02-29", value: 120_000_00 },
        { dateKey: "2024-03-31", value: 130_000_00 },
      ],
    });

    const comparison = result.comparison;
    expect(comparison).toMatchObject({
      sinceDate: "2024-01-31",
      untilDate: "2024-03-31",
    });
    expect(comparison?.subjectGrowth).toBeCloseTo(0.3);
    expect(comparison?.benchmarkGrowth).toBeCloseTo(0.1);
    expect(comparison?.realGrowth).toBeCloseTo(0.18181818181818182);

    expect(comparison?.points.map((point) => point.dateKey)).toEqual([
      "2024-01-31",
      "2024-02-29",
      "2024-03-31",
    ]);
    expect(comparison?.points[1]?.subjectGrowth).toBeCloseTo(0.2);
    expect(comparison?.points[1]?.benchmarkGrowth).toBeCloseTo(0.05);
    expect(comparison?.points[1]?.realGrowth).toBeCloseTo(0.1428571428571428);
  });

  test("annualizes the subject, benchmark and real growth over the shared window", () => {
    const result = compareGrowthToBenchmark({
      benchmark: [
        { dateKey: "2023-01-01", value: 100 },
        { dateKey: "2024-01-01", value: 104 },
      ],
      subject: [
        { dateKey: "2023-01-31", value: 100_000_00 },
        { dateKey: "2024-01-31", value: 110_000_00 },
      ],
    });

    expect(result.comparison?.subjectAnnualGrowth).toBeCloseTo(0.1, 4);
    expect(result.comparison?.benchmarkAnnualGrowth).toBeCloseTo(0.04, 4);
    expect(result.comparison?.realAnnualGrowth).toBeCloseTo(1.1 / 1.04 - 1, 4);
  });

  test("returns an unavailable reason when the benchmark series does not cover the window", () => {
    expect(
      compareGrowthToBenchmark({
        benchmark: [{ dateKey: "2024-03-01", value: 110 }],
        subject: [
          { dateKey: "2024-01-31", value: 100_000_00 },
          { dateKey: "2024-02-29", value: 120_000_00 },
        ],
      }),
    ).toEqual({ comparison: null, unavailableReason: "benchmark_unavailable" });
  });
});
