import { type BenchmarkPrice, createControlPlaneStore } from "@worthline/db";
import { unstable_cache } from "next/cache";

const BENCHMARK_CACHE_REVALIDATE_SECONDS = 86_400;

async function readBenchmarkPricesUncached(seriesId: string): Promise<BenchmarkPrice[]> {
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

const readBenchmarkPricesCached = unstable_cache(
  readBenchmarkPricesUncached,
  ["benchmark-prices"],
  { revalidate: BENCHMARK_CACHE_REVALIDATE_SECONDS },
);

/** Global benchmark series reader (control plane, 24h Next data cache per seriesId). */
export async function readBenchmarkPricesFromControlPlane(
  seriesId: string,
): Promise<BenchmarkPrice[]> {
  return readBenchmarkPricesCached(seriesId);
}
