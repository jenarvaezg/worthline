import type { LiquidityTier } from "./classification";

export type PriceSource =
  | "manual"
  | "ecb"
  | "coingecko"
  | "stooq"
  | "yahoo"
  | "finect"
  | "numista"
  | "binance";
export type InvestmentPriceProvider = "yahoo" | "stooq" | "finect" | "coingecko";
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
  yahoo: 1,
  finect: 1,
  // The coin-collection holding's valuation freshness (PRD #160, ADR 0017): a
  // daily cadence so metal-spot moves show up the next day. The numismatic
  // estimate rides a separate long TTL (30 days) so the daily pass stays well
  // under Numista's request cap. Both coin-value cadences live together in the
  // single coin-value staleness config — `COIN_VALUE_TTL_DAYS` in
  // packages/pricing/src/coin-valuation.ts (#240), which sources `metalSpot`
  // FROM this `numista` entry. Keep them in step: this is the metal-spot clock.
  numista: 1,
  // The Binance holding's live valuation freshness (ADR 0021): a daily cadence so
  // a fresh CoinGecko price (and re-read balances) show up the next day on the
  // stale-price pass (#249), the same cadence the manual crypto path rides.
  binance: 1,
};

export function defaultInvestmentPriceProvider(
  liquidityTier: LiquidityTier,
): InvestmentPriceProvider {
  return liquidityTier === "term-locked" ? "finect" : "yahoo";
}

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
 * - failed entries are re-selected once their per-source TTL elapses so a
 *   transient outage can recover on the next auto-refresh pass (issue #730).
 *   Manual "Actualizar precios" (`force: true`) retries immediately.
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

    const ttlMs = PRICE_TTL_DAYS[entry.source] * 86400000;
    const ageMs = now - new Date(entry.fetchedAt).getTime();
    return ageMs >= ttlMs;
  });
}

/**
 * Whether a single source's valuation needs refreshing: never valued, or past
 * the per-source TTL (`selectStalePrices`' canonical rule applied to one row).
 * Shared by the connected-source refreshers (Numista, Binance) so the gate is
 * the same single staleness rule.
 */
export function isPriceStale(freshness: AssetPrice | null, nowIso: string): boolean {
  if (freshness === null) return true;
  return selectStalePrices([freshness], nowIso).length > 0;
}
