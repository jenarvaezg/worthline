import { createControlPlaneStore } from "@worthline/db";
import {
  holdingBenchmarkComparison,
  resolveBenchmarkSeriesId,
  type HoldingBenchmarkComparisonResult,
  type InvestmentOperation,
  type MonthlyCloseValue,
} from "@worthline/domain";

export async function readBenchmarkPricesFromControlPlane(
  seriesId: string,
): Promise<{ dateKey: string; value: string }[]> {
  const url = process.env.WORTHLINE_CONTROL_PLANE_DB_URL;
  if (!url) return [];

  const controlPlane = await createControlPlaneStore({
    url,
    ...(process.env.WORTHLINE_DB_AUTH_TOKEN
      ? { authToken: process.env.WORTHLINE_DB_AUTH_TOKEN }
      : {}),
  });
  try {
    return await controlPlane.readBenchmarkPrices(seriesId);
  } finally {
    controlPlane.close();
  }
}

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
