import type { LiquidityTier } from "./classification";
import { isPositiveDecimal } from "./decimal";

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

/**
 * Every provider value a stored `price_provider` can carry, RETIRED ONES
 * INCLUDED — the vocabulary of the data, not of what can be chosen today. Built
 * from an exhaustive `Record` so adding a member to the union breaks the build
 * here instead of leaving a stale hand-written list behind (the four literal
 * copies this replaces are exactly the drift #1329 warned about).
 */
export const INVESTMENT_PRICE_PROVIDERS = Object.keys({
  yahoo: true,
  stooq: true,
  finect: true,
  coingecko: true,
} satisfies Record<InvestmentPriceProvider, true>) as readonly InvestmentPriceProvider[];

/**
 * Providers that no longer fetch: the upstream is gone for good, so nothing new
 * may be pointed at them. Stooq deployed anti-bot protection and answers every
 * symbol with an error page (#1354, ADR 0011 amended), so it stays in the union
 * for the rows that already carry it and is refused for anything new.
 */
export const RETIRED_INVESTMENT_PRICE_PROVIDERS: ReadonlySet<InvestmentPriceProvider> =
  new Set<InvestmentPriceProvider>(["stooq"]);

/** The providers a user or agent may CHOOSE today (retired ones excluded). */
export const SELECTABLE_INVESTMENT_PRICE_PROVIDERS: readonly InvestmentPriceProvider[] =
  INVESTMENT_PRICE_PROVIDERS.filter(
    (provider) => !RETIRED_INVESTMENT_PRICE_PROVIDERS.has(provider),
  );

/** Whether a loose string names a provider the data model knows (retired included). */
export function isInvestmentPriceProvider(
  value: string | null | undefined,
): value is InvestmentPriceProvider {
  return (
    value !== null &&
    value !== undefined &&
    (INVESTMENT_PRICE_PROVIDERS as readonly string[]).includes(value)
  );
}

/** Whether a stored provider has been retired — it can never fetch again. */
export function isRetiredInvestmentPriceProvider(
  value: string | null | undefined,
): value is InvestmentPriceProvider {
  return (
    isInvestmentPriceProvider(value) && RETIRED_INVESTMENT_PRICE_PROVIDERS.has(value)
  );
}

const PROVIDER_SYMBOL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,19}$/;

/**
 * Whether a string is plausible as a provider symbol — a ticker ("VUSA.L"), a
 * CoinGecko id ("bitcoin") or a fund code ("N5572-myinvestor"): no whitespace,
 * no punctuation beyond `. _ : -`, at most 20 characters.
 *
 * A statement without ISINs groups its rows by the fund's NAME, and stamping
 * that name as the provider symbol condemned the holding to a daily lookup that
 * could never resolve — each attempt rewriting a `failed` price row (#1330).
 * No symbol is the honest answer: the holding is valued at cost until someone
 * maps it. Shape is all this can judge; whether the symbol RESOLVES is the
 * provider's answer, not ours.
 */
export function isProviderSymbolShaped(value: string): boolean {
  return PROVIDER_SYMBOL_SHAPE.test(value.trim());
}

/**
 * The one rule for "is this cache row a price at all" (#1330).
 *
 * A `failed` row is the pool's marker for "the fetch failed and no prior good
 * price exists" and carries price "0". Every reader that would multiply, divide
 * or attribute by that figure asks here instead of re-spelling the check: the
 * answer is the usable price, or null when the row only records a failure.
 */
export function usableCachedPrice(
  entry: Pick<AssetPrice, "freshnessState" | "price">,
): string | null {
  if (entry.freshnessState === "failed") return null;
  return isPositiveDecimal(entry.price) ? entry.price : null;
}

/**
 * Major-unit price per holding id — used to convert units contributions to money.
 *
 * Rows that are not a price are left out rather than handed downstream, where a
 * zero turns "how much money is this many units" into 0 € or a division by zero.
 */
export function unitPriceMajorByHoldingId(
  priceCache: readonly AssetPrice[],
): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const entry of priceCache) {
    const price = usableCachedPrice(entry);
    if (price !== null) entries.push([entry.assetId, price]);
  }
  return Object.fromEntries(entries);
}

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
