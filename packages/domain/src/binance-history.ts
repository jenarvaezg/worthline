/**
 * Binance monthly value history — the PURE builder (PRD #245, S5, ADR 0021).
 *
 * The reconstruction (in `@worthline/pricing`) derives two faithful inputs from
 * Binance's cheap daily SPOT snapshots + CoinGecko's historical range, and hands
 * them here as a `BinanceHistoryCurve`. This module is the leaf that VALUES that
 * curve on any date — it never fetches and never throws.
 *
 * The valuation rule (ADR 0021): a token's balance is a *step function* that holds
 * its month-end level across the whole month, while its price moves *daily*. So the
 * value on any date = Σ over tokens of (the token's month-end balance for that
 * date's month) × (the token's EUR price on that exact day). A token with no
 * balance that month, or no price that day, contributes 0 — unpriceable is valued
 * 0, never an error (the same contract the live sync uses for unmapped tokens).
 */

import type { DecimalString } from "./decimal";
import { multiplyToMinor } from "./decimal";

/**
 * The reconstructed inputs to the monthly value history. Both maps are keyed by
 * Binance symbol (e.g. "BTC"); the inner maps key by a calendar key:
 * - `monthEndBalances`: monthKey "YYYY-MM" → the balance held at that month's end.
 *   A step function — the level holds across every day of the month.
 * - `dailyPriceBySymbol`: dateKey "YYYY-MM-DD" → that day's EUR unit price.
 */
export interface BinanceHistoryCurve {
  monthEndBalances: ReadonlyMap<string, ReadonlyMap<string, DecimalString>>;
  dailyPriceBySymbol: ReadonlyMap<string, ReadonlyMap<string, DecimalString>>;
}

/** Last calendar day of a "YYYY-MM" month key, as YYYY-MM-DD (leap-aware). */
function lastDayOfMonthKey(monthKey: string): string {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  // Day 0 of the next month is the last day of `month` (1-based month here).
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${monthKey}-${String(day).padStart(2, "0")}`;
}

/**
 * The value in minor units on `dateKey`. For each symbol, take its balance for the
 * date's month (`monthKey = dateKey.slice(0, 7)`) and multiply by that symbol's
 * price on `dateKey`, summing across symbols. A symbol with no balance that month,
 * or a balance but no price that day, contributes 0 (unpriceable → 0, never throws).
 */
export function binanceValueAtDate(curve: BinanceHistoryCurve, dateKey: string): number {
  const monthKey = dateKey.slice(0, 7);
  let totalMinor = 0;

  for (const [symbol, monthBalances] of curve.monthEndBalances) {
    const balance = monthBalances.get(monthKey);
    if (balance === undefined) continue;

    const price = curve.dailyPriceBySymbol.get(symbol)?.get(dateKey);
    if (price === undefined) continue;

    totalMinor += multiplyToMinor(balance, price);
  }

  return totalMinor;
}

/**
 * The earliest date the curve can value — the first dateKey for which some symbol
 * has both a balance in that date's month and a price that day. This is what the UI
 * surfaces as "datos desde DD/MM". Null when the curve can value no date.
 */
export function binanceCurveStartDate(curve: BinanceHistoryCurve): string | null {
  let earliest: string | null = null;

  for (const [symbol, dailyPrices] of curve.dailyPriceBySymbol) {
    const monthBalances = curve.monthEndBalances.get(symbol);
    if (monthBalances === undefined) continue;

    for (const dateKey of dailyPrices.keys()) {
      // A price only counts as valuable if its month has a balance for this symbol.
      if (!monthBalances.has(dateKey.slice(0, 7))) continue;
      if (earliest === null || dateKey < earliest) earliest = dateKey;
    }
  }

  return earliest;
}

/**
 * The last-calendar-day date of each month the curve covers (across all symbols)
 * that is **strictly before** `today`'s month — a "completed" month, never the
 * current partial one — ascending. These are the month-end anchors the snapshot
 * ripple backfills (Pass B).
 */
export function completedMonthEndDates(
  curve: BinanceHistoryCurve,
  today: string,
): string[] {
  const currentMonthKey = today.slice(0, 7);
  const monthKeys = new Set<string>();

  for (const monthBalances of curve.monthEndBalances.values()) {
    for (const monthKey of monthBalances.keys()) {
      if (monthKey < currentMonthKey) monthKeys.add(monthKey);
    }
  }

  return [...monthKeys].sort().map(lastDayOfMonthKey);
}
