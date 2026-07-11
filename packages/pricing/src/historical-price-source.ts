/**
 * Historical price source (#380, ADR 0033).
 *
 * The abstraction the historical-price backfill reads from: given a provider
 * symbol and a millisecond range, return the daily EUR prices keyed by YYYY-MM-DD
 * plus the source label that produced them. Two implementations:
 *
 *  - `coingeckoHistoricalSource`: resolves the symbol → a CoinGecko id (the
 *    Binance ticker map, or a bare id passed straight through) and reuses the
 *    existing range fetch (`fetchCoinGeckoHistoryEur` — never throws, empty on a
 *    miss, demo-key aware). An unmapped ticker resolves to no id → an empty
 *    series, never a fabricated price.
 *  - `yahooHistoricalSource`: daily closes from Yahoo's chart API over a
 *    millisecond range, converted to EUR with the same rules as live Yahoo pricing.
 *  - `parsePriceCsv`: the user-controlled long-range fallback — a `date,price`
 *    CSV parsed into the same map. Blank/malformed rows are skipped (gaps stay
 *    gaps); it never invents a price for a date the CSV omits.
 *
 * Both honor the issue's central guarantee: prices are never invented; a date the
 * source cannot price is simply absent from the map, so the plan records a gap.
 */

import type { DecimalString, InvestmentPriceProvider } from "@worthline/domain";
import { fetchCoinGeckoHistoryEur } from "./binance-history";
import { resolveCoinGeckoId } from "./binance-symbols";
import { yahooHistoricalSource } from "./yahoo-historical";

/** A historical EUR price series plus the source that produced it. */
export interface HistoricalPriceSeries {
  /** Daily EUR prices keyed by YYYY-MM-DD; absent dates are gaps, never invented. */
  pricesByDate: ReadonlyMap<string, DecimalString>;
  /** The source label (audit metadata surfaced in the UI). */
  source: string;
  /** Set when the upstream fetch failed (e.g. CoinGecko HTTP 429). */
  fetchError?: string;
}

/** A historical price source: provider symbol + range → EUR series. */
export interface HistoricalPriceSource {
  fetchSeriesEur: (
    providerSymbol: string,
    fromMs: number,
    toMs: number,
  ) => Promise<HistoricalPriceSeries>;
}

/**
 * Resolve a configured provider symbol to a CoinGecko id, or null when it cannot
 * be priced from CoinGecko. The Binance ticker map covers tickers (`BTC` →
 * `bitcoin`); a symbol that is already a lower-case CoinGecko id (`bitcoin`,
 * `usd-coin`) is passed through directly. An unmapped UPPER-case ticker (`WAGMI`)
 * resolves to null so the source returns an empty series without a wasted fetch.
 */
function resolveCoinGeckoIdForBackfill(providerSymbol: string): string | null {
  const mapped = resolveCoinGeckoId(providerSymbol);
  if (mapped !== null) return mapped;

  const trimmed = providerSymbol.trim();
  // A bare CoinGecko id is lower-case (and may carry hyphens). An unmapped
  // upper-case ticker is rejected — there is no id to fetch, so we don't guess.
  if (trimmed.length > 0 && trimmed === trimmed.toLowerCase()) {
    return trimmed;
  }
  return null;
}

/**
 * The CoinGecko historical source. Reuses `fetchCoinGeckoHistoryEur`, which is
 * demo-key aware and never throws (empty series on a miss/outage). The public
 * endpoint's ~365-day range limit (CONTEXT.md / ADR 0021) means a long backdated
 * range yields gaps the plan reports — the CSV source is the long-range fallback.
 */
export const coingeckoHistoricalSource: HistoricalPriceSource = {
  fetchSeriesEur: async (providerSymbol, fromMs, toMs) => {
    const id = resolveCoinGeckoIdForBackfill(providerSymbol);
    if (id === null) {
      return { pricesByDate: new Map(), source: "coingecko" };
    }
    const { pricesByDate, fetchError } = await fetchCoinGeckoHistoryEur(id, fromMs, toMs);
    return { pricesByDate, source: "coingecko", ...(fetchError ? { fetchError } : {}) };
  },
};

/**
 * Resolve an investment's configured price provider to its historical source
 * (#923). Yahoo and CoinGecko fetch real series; providers without a long-range
 * API yet degrade to an empty map (gaps stay gaps, never invented).
 */
export function resolveHistoricalPriceSource(
  priceProvider: InvestmentPriceProvider,
): HistoricalPriceSource {
  switch (priceProvider) {
    case "yahoo":
      return yahooHistoricalSource;
    case "coingecko":
      return coingeckoHistoricalSource;
    case "stooq":
    case "finect":
      return emptyHistoricalSource(priceProvider);
  }
}

function emptyHistoricalSource(source: string): HistoricalPriceSource {
  return {
    fetchSeriesEur: async () => ({ pricesByDate: new Map(), source }),
  };
}

/** True when `value` is a YYYY-MM-DD date key. */
function isDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * True when `value` is a finite, STRICTLY POSITIVE decimal number string. A
 * negative price is a bad row (skipped → stays a gap); `0` is treated as "no
 * price" (a free holding is implausible) so it becomes a gap rather than freezing
 * a 0-value month. Scientific notation (`1e9`) parses finite and is accepted.
 */
function isPrice(value: string): boolean {
  if (value === "") return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

/**
 * Parse a `date,price` CSV into a dateKey → price map (the manual long-range
 * fallback). Tolerates a `date,price` header, surrounding whitespace, and a
 * trailing newline. Blank and malformed rows are skipped — a date the CSV omits
 * (or carries no parseable price for) stays a gap, never a fabricated price.
 */
export function parsePriceCsv(csv: string): ReadonlyMap<string, DecimalString> {
  const byDate = new Map<string, DecimalString>();
  for (const rawLine of csv.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;

    const [rawDate, rawPrice] = line.split(",");
    const dateKey = rawDate?.trim() ?? "";
    const price = rawPrice?.trim() ?? "";
    if (!isDateKey(dateKey) || !isPrice(price)) continue;

    byDate.set(dateKey, price);
  }
  return byDate;
}
