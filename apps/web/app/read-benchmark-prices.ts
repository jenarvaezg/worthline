import type { BenchmarkPrice, BenchmarkPriceCache } from "@worthline/db";
import { unstable_cache } from "next/cache";

import { withOptionalControlPlaneStore } from "./control-plane-store";

const BENCHMARK_CACHE_REVALIDATE_SECONDS = 86_400;

async function readBenchmarkPricesUncached(seriesId: string): Promise<BenchmarkPrice[]> {
  const prices = await withOptionalControlPlaneStore<
    BenchmarkPrice[],
    Pick<BenchmarkPriceCache, "readBenchmarkPrices">
  >((controlPlane) => controlPlane.readBenchmarkPrices(seriesId));
  return prices ?? [];
}

const readBenchmarkPricesCached = unstable_cache(
  readBenchmarkPricesUncached,
  ["benchmark-prices"],
  { revalidate: BENCHMARK_CACHE_REVALIDATE_SECONDS },
);

function isMissingIncrementalCache(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("incrementalCache missing") ||
      (error as { __NEXT_ERROR_CODE?: string }).__NEXT_ERROR_CODE === "E469")
  );
}

/** Global benchmark series reader (control plane, 24h Next data cache per seriesId). */
export async function readBenchmarkPricesFromControlPlane(
  seriesId: string,
): Promise<BenchmarkPrice[]> {
  try {
    return await readBenchmarkPricesCached(seriesId);
  } catch (error) {
    if (!isMissingIncrementalCache(error)) throw error;
    return readBenchmarkPricesUncached(seriesId);
  }
}
