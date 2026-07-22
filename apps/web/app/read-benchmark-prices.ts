import {
  type BenchmarkPrice,
  type BenchmarkPriceCache,
  createControlPlaneStore,
} from "@worthline/db";
import { unstable_cache } from "next/cache";

const BENCHMARK_CACHE_REVALIDATE_SECONDS = 86_400;

async function readBenchmarkPricesUncached(seriesId: string): Promise<BenchmarkPrice[]> {
  const url = process.env.WORTHLINE_CONTROL_PLANE_DB_URL;
  if (!url) return [];

  const controlPlane: Pick<BenchmarkPriceCache, "readBenchmarkPrices"> & {
    close(): void;
  } = await createControlPlaneStore({
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
