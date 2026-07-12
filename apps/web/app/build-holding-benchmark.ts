import {
  type HoldingBenchmarkComparisonResult,
  holdingBenchmarkComparison,
  type InvestmentOperation,
  type MonthlyCloseValue,
  resolveBenchmarkSeriesId,
} from "@worthline/domain";

/**
 * Resolve a holding's tracked-index benchmark lens (ADR 0060, #626). Returns an
 * honest unavailable reason when the label is absent, unmapped, or the series
 * does not cover the TWR window — never a fabricated comparison.
 */
export async function buildHoldingBenchmarkComparison(input: {
  trackedIndex: string | null | undefined;
  distributing: boolean;
  operations: readonly InvestmentOperation[];
  monthlyCloses: readonly MonthlyCloseValue[];
  readBenchmarkPrices?: (
    seriesId: string,
  ) => Promise<readonly { dateKey: string; value: string }[]>;
}): Promise<HoldingBenchmarkComparisonResult> {
  const label = input.trackedIndex?.trim();
  if (!label) {
    return { comparison: null, unavailableReason: "no_tracked_index" };
  }

  const seriesId = resolveBenchmarkSeriesId(label, input.distributing);
  if (!seriesId) {
    return { comparison: null, unavailableReason: "benchmark_unmapped" };
  }

  if (!input.readBenchmarkPrices) {
    return { comparison: null, unavailableReason: "benchmark_unavailable" };
  }

  try {
    const benchmarkPrices = await input.readBenchmarkPrices(seriesId);
    return holdingBenchmarkComparison({
      benchmarkPrices,
      distributing: input.distributing,
      monthlyCloses: input.monthlyCloses,
      operations: input.operations,
      trackedIndex: label,
    });
  } catch {
    return { comparison: null, unavailableReason: "benchmark_unavailable" };
  }
}
