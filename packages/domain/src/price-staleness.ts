import type { AssetPrice } from "./prices";

/** Staleness threshold: prices older than this many milliseconds need refreshing. */
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Returns the subset of cache entries whose prices are stale and should be refreshed.
 *
 * Rules:
 * - manual quotes are never stale (user-controlled, no provider to refresh from)
 * - failed entries are not re-selected (already in error state; manual "Actualizar precios" handles retry)
 * - all other entries older than 24h are stale
 */
export function selectStalePrices(
  cacheEntries: AssetPrice[],
  nowIso: string,
): AssetPrice[] {
  const now = new Date(nowIso).getTime();

  return cacheEntries.filter((entry) => {
    if (entry.freshnessState === "manual") return false;
    if (entry.freshnessState === "failed") return false;

    const ageMs = now - new Date(entry.fetchedAt).getTime();
    return ageMs >= STALE_THRESHOLD_MS;
  });
}
