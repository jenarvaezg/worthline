import {
  type BenchmarkVariant,
  benchmarkCatalogEntryBySeriesId,
  benchmarkCoverageNote,
  resolveBenchmarkSeriesId,
} from "./benchmark-catalog";
import {
  type BenchmarkComparison,
  type BenchmarkComparisonResult,
  compareGrowthToBenchmark,
  type GrowthSeriesPoint,
} from "./benchmark-comparison";
import { daysBetween } from "./dates";
import type { InvestmentOperation } from "./investment-types";
import type { MonthlyCloseValue } from "./returns";
import { operationTwrCashflows } from "./returns";

export interface HoldingBenchmarkComparison extends BenchmarkComparison {
  seriesId: string;
  trackedIndex: string;
  variant: BenchmarkVariant;
  coverageNote: string;
}

export type HoldingBenchmarkUnavailableReason =
  | "no_tracked_index"
  | "benchmark_unmapped"
  | "twr_unavailable"
  | "benchmark_unavailable"
  | "zero_start_value";

export type HoldingBenchmarkComparisonResult =
  | { comparison: HoldingBenchmarkComparison; unavailableReason?: never }
  | { comparison: null; unavailableReason: HoldingBenchmarkUnavailableReason };

/**
 * Build the holding's cumulative TWR index rebased to 100 at the first monthly
 * close. Modified Dietz period returns are chained across the snapshot span
 * (ADR 0040) — the series the per-holding benchmark lens rides.
 */
export function holdingTwrIndexSeries(input: {
  monthlyCloses: readonly MonthlyCloseValue[];
  operations: readonly InvestmentOperation[];
}): GrowthSeriesPoint[] {
  const monthlyCloses = [...input.monthlyCloses].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  if (monthlyCloses.length < 2) {
    return [];
  }

  const cashflows = operationTwrCashflows(input.operations);
  let factor = 1;
  const points: GrowthSeriesPoint[] = [{ dateKey: monthlyCloses[0]!.date, value: 100 }];

  for (let index = 1; index < monthlyCloses.length; index += 1) {
    const start = monthlyCloses[index - 1]!;
    const end = monthlyCloses[index]!;
    const periodDays = daysBetween(start.date, end.date);
    if (periodDays <= 0) {
      return [];
    }

    const periodCashflows = cashflows.filter(
      (cashflow) => cashflow.date > start.date && cashflow.date <= end.date,
    );
    const totalCashflowMinor = periodCashflows.reduce(
      (sum, cashflow) => sum + cashflow.amountMinor,
      0,
    );
    const weightedCashflowMinor = periodCashflows.reduce(
      (sum, cashflow) =>
        sum + cashflow.amountMinor * (daysBetween(cashflow.date, end.date) / periodDays),
      0,
    );
    const denominator = start.valueMinor + weightedCashflowMinor;
    if (denominator === 0) {
      return [];
    }

    const periodRate =
      (end.valueMinor - start.valueMinor - totalCashflowMinor) / denominator;
    factor *= 1 + periodRate;
    points.push({ dateKey: end.date, value: 100 * factor });
  }

  return points;
}

function toHoldingComparison(
  seriesId: string,
  trackedIndex: string,
  variant: BenchmarkVariant,
  base: BenchmarkComparison,
): HoldingBenchmarkComparison {
  return {
    ...base,
    coverageNote: benchmarkCoverageNote(seriesId) ?? "",
    seriesId,
    trackedIndex,
    variant,
  };
}

function mapUnavailableReason(
  reason: BenchmarkComparisonResult["unavailableReason"],
): HoldingBenchmarkUnavailableReason {
  return reason === "zero_start_value" ? "zero_start_value" : "benchmark_unavailable";
}

/**
 * Compare a holding's chained TWR index against a benchmark price series over
 * the shared monthly window, rebased to 100 at the first overlap (ADR 0060).
 */
export function compareHoldingToBenchmark(input: {
  operations: readonly InvestmentOperation[];
  monthlyCloses: readonly MonthlyCloseValue[];
  benchmark: GrowthSeriesPoint[];
  seriesId: string;
  trackedIndex: string;
  variant: BenchmarkVariant;
}): HoldingBenchmarkComparisonResult {
  const subject = holdingTwrIndexSeries({
    monthlyCloses: input.monthlyCloses,
    operations: input.operations,
  });
  if (subject.length < 2) {
    return { comparison: null, unavailableReason: "twr_unavailable" };
  }

  const result = compareGrowthToBenchmark({
    benchmark: input.benchmark,
    subject,
  });
  if (!result.comparison) {
    return {
      comparison: null,
      unavailableReason: mapUnavailableReason(result.unavailableReason),
    };
  }

  return {
    comparison: toHoldingComparison(
      input.seriesId,
      input.trackedIndex,
      input.variant,
      result.comparison,
    ),
  };
}

/**
 * Resolve the benchmark series for a holding and compare its TWR to the cached
 * price series. Returns an honest unavailable reason when the label does not
 * map, history is too short, or the benchmark does not cover the window.
 */
export function holdingBenchmarkComparison(input: {
  trackedIndex: string | null | undefined;
  distributing: boolean;
  operations: readonly InvestmentOperation[];
  monthlyCloses: readonly MonthlyCloseValue[];
  benchmarkPrices: ReadonlyArray<{ dateKey: string; value: string }>;
}): HoldingBenchmarkComparisonResult {
  const label = input.trackedIndex?.trim();
  if (!label) {
    return { comparison: null, unavailableReason: "no_tracked_index" };
  }

  const seriesId = resolveBenchmarkSeriesId(label, input.distributing);
  if (!seriesId) {
    return { comparison: null, unavailableReason: "benchmark_unmapped" };
  }

  const entry = benchmarkCatalogEntryBySeriesId(seriesId);
  if (!entry) {
    return { comparison: null, unavailableReason: "benchmark_unmapped" };
  }

  return compareHoldingToBenchmark({
    benchmark: input.benchmarkPrices.map((point) => ({
      dateKey: point.dateKey,
      value: Number(point.value),
    })),
    monthlyCloses: input.monthlyCloses,
    operations: input.operations,
    seriesId,
    trackedIndex: label,
    variant: entry.variant,
  });
}
