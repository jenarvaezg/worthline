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
  if (price.source === "manual") return "manual";
  const ageDays =
    (new Date(nowIso).getTime() - new Date(price.fetchedAt).getTime()) / 86400000;
  return ageDays <= PRICE_TTL_DAYS[price.source] ? "fresh" : "stale";
}
