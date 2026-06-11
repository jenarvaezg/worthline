export type PriceSource = "manual" | "ecb" | "coingecko" | "stooq";
export type PriceFreshnessState = "fresh" | "stale" | "failed" | "manual";

export interface AssetPrice {
  assetId: string;
  currency: string;
  price: string;
  source: PriceSource;
  priceDate?: string;
  fetchedAt: string;
  freshnessState: PriceFreshnessState;
  staleReason?: string;
}

export const PRICE_TTL_DAYS: Record<PriceSource, number> = {
  manual: 30,
  ecb: 1,
  coingecko: 1,
  stooq: 1,
};

export function getPriceFreshness(
  price: Pick<AssetPrice, "source" | "fetchedAt" | "freshnessState">,
  nowIso: string,
): PriceFreshnessState {
  if (price.freshnessState === "failed") return "failed";
  if (price.freshnessState === "manual") return "manual";

  const ttlMs = PRICE_TTL_DAYS[price.source] * 86400000;
  const ageMs = new Date(nowIso).getTime() - new Date(price.fetchedAt).getTime();

  return ageMs >= ttlMs ? "stale" : "fresh";
}

/**
 * Single staleness rule (issue #67): returns cache entries that need refreshing.
 *
 * Rules:
 * - manual quotes (freshnessState === "manual") are never stale — user-controlled,
 *   no provider to refresh from.
 * - failed entries are not re-selected — already in error state; manual
 *   "Actualizar precios" handles retry.
 * - all other entries are stale when their age reaches the per-source TTL from
 *   PRICE_TTL_DAYS (ecb/coingecko/stooq = 1 day, manual tier = 30 days).
 */
export function selectStalePrices(
  cacheEntries: AssetPrice[],
  nowIso: string,
): AssetPrice[] {
  const now = new Date(nowIso).getTime();

  return cacheEntries.filter((entry) => {
    if (entry.freshnessState === "manual") return false;
    if (entry.freshnessState === "failed") return false;

    const ttlMs = PRICE_TTL_DAYS[entry.source] * 86400000;
    const ageMs = now - new Date(entry.fetchedAt).getTime();
    return ageMs >= ttlMs;
  });
}
