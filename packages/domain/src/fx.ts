import type { CurrencyCode, MoneyMinor } from "./money";
import { money } from "./money";

/**
 * Honest multi-currency: a single {@link MoneyConverter} port with an EUR pivot
 * (PRD #1000, #1065). It converts a {@link MoneyMinor} to a target currency using
 * the ECB rate DATED to `asOf` (the latest observation acts as the spot rate for a
 * present-day `asOf`), and treats the ABSENCE of a rate as an explicit failure
 * (`{ ok: false }`) — it NEVER falls back to 1:1. This is what lets the aggregation
 * exclude-and-mark a non-convertible figure honestly instead of silently summing a
 * non-EUR amount as if it were EUR (the pre-#1065 behavior) or throwing.
 *
 * The port is deliberately PURE: it consumes an {@link FxRateSnapshot} of already
 * fetched observations, so the domain takes no network dependency. The ECB fetch +
 * spot/dated assembly is an adapter in `@worthline/pricing` (`resolveFxRateSnapshot`).
 *
 * v1 minor-unit assumption: like the rest of the money model, this treats every
 * currency as having 2 decimal places (`amountMinor` scaled ×100). Zero- or
 * three-decimal currencies (JPY, KWD) are not modeled yet; the realistic non-EUR
 * holdings a connector brings (USD/GBP/CHF) are all 2-decimal.
 *
 * Rate representation: `eurPerUnit` is a `number`, matching the ECB adapter this is
 * fed from (`ecb.ts` / `yahoo-historical.ts` already return `number` rates). CONTEXT
 * prefers decimal strings for stored rates/quantities to preserve precision; here the
 * rate is used for exactly ONE multiply-and-round to an integer minor unit, so the
 * float error stays well below the 1-cent rounding step for any realistic amount —
 * routing it through a decimal string and back would be precision theatre and diverge
 * from the ECB fetcher's type. The persisted, mass-backfill FX path (#884) is deferred.
 */

export const BASE_CURRENCY: CurrencyCode = "EUR";

/**
 * How far back an `asOf` may reach for an observation. ECB publishes business days
 * only, so a weekend/holiday `asOf` carries the previous business day's rate
 * forward; beyond a week the rate is considered missing and the pair is
 * unconvertible (identical policy to the historical backfill, #1065).
 */
export const FX_CARRY_FORWARD_DAYS = 7;

const MS_PER_DAY = 86_400_000;

/** One dated observation: the EUR value of a single unit of some currency. */
export interface FxRatePoint {
  /** UTC calendar day of the observation, `YYYY-MM-DD`. */
  dateKey: string;
  /** EUR per one unit of the currency; strictly positive. */
  eurPerUnit: number;
}

/** An immutable, currency-keyed set of dated ECB observations. */
export interface FxRateSnapshot {
  /**
   * EUR-per-unit for `currency` effective at `asOf`: the observation on-or-before
   * `asOf` within the {@link FX_CARRY_FORWARD_DAYS} window (the latest observation
   * therefore serves as the spot rate for a present-day `asOf`). EUR is always `1`.
   * Returns `null` when no observation covers `asOf` — never an invented rate.
   */
  eurPerUnit(currency: CurrencyCode, asOf: string): number | null;
}

/** Why {@link MoneyConverter.convert} could not convert. */
export type FxUnconvertibleReason = "missing-rate";

/**
 * The outcome of a conversion. A missing rate is a typed `{ ok: false }` — callers
 * exclude-and-mark the figure rather than crash or invent a 1:1 value.
 */
export type FxConversionResult =
  | { ok: true; value: MoneyMinor }
  | { ok: false; reason: FxUnconvertibleReason };

/** The single currency-conversion port (EUR pivot, dated-or-spot, no 1:1 fallback). */
export interface MoneyConverter {
  /**
   * Convert `amount` (whose `currency` is the source) to `to` at `asOf`. Same-currency
   * is identity and needs no rate; otherwise both legs resolve through the EUR pivot,
   * and a missing rate on EITHER leg yields `{ ok: false, reason: "missing-rate" }`.
   */
  convert(amount: MoneyMinor, to: CurrencyCode, asOf: string): FxConversionResult;
}

/**
 * Build an {@link FxRateSnapshot} from raw dated observations per currency. Points
 * need not be sorted; lookups day-walk on-or-before `asOf` up to the carry-forward
 * window, mirroring the historical backfill's `rateOnOrBefore`. Non-positive or
 * malformed observations are dropped so a bad point can never produce a bogus rate.
 */
export function createFxRateSnapshot(
  pointsByCurrency: Readonly<Record<string, ReadonlyArray<FxRatePoint>>>,
): FxRateSnapshot {
  const byCurrency = new Map<string, ReadonlyMap<string, number>>();
  for (const [currency, points] of Object.entries(pointsByCurrency)) {
    const rates = new Map<string, number>();
    for (const point of points) {
      if (Number.isFinite(point.eurPerUnit) && point.eurPerUnit > 0) {
        rates.set(point.dateKey, point.eurPerUnit);
      }
    }
    byCurrency.set(currency, rates);
  }

  return {
    eurPerUnit(currency, asOf) {
      if (currency === BASE_CURRENCY) return 1;
      const rates = byCurrency.get(currency);
      if (!rates || rates.size === 0) return null;

      const asOfMs = Date.parse(`${asOf.slice(0, 10)}T00:00:00.000Z`);
      if (!Number.isFinite(asOfMs)) return null;

      for (let daysBack = 0; daysBack <= FX_CARRY_FORWARD_DAYS; daysBack += 1) {
        const key = new Date(asOfMs - daysBack * MS_PER_DAY).toISOString().slice(0, 10);
        const rate = rates.get(key);
        if (rate !== undefined) return rate;
      }
      return null;
    },
  };
}

/**
 * The FX context an aggregation carries so it can convert non-base holdings: the
 * {@link MoneyConverter} plus the `asOf` the figures are computed at (spot for a
 * present-time total). Optional at every call site — absent, non-base holdings are
 * excluded honestly rather than mis-summed.
 */
export interface FxAggregation {
  converter: MoneyConverter;
  asOf: string;
}

/** A holding left OUT of an aggregate because its currency could not be converted. */
export interface FxExcludedHolding {
  holdingId: string;
  name: string;
  /** The holding's value in its OWN (non-base) currency — what could not be counted. */
  original: MoneyMinor;
  reason: FxUnconvertibleReason;
}

/**
 * Resolve a holding's value into `baseCurrency`, or report why it cannot be counted.
 * A base-currency value passes through untouched (no rate needed). A non-base value
 * is converted; with NO converter, or when the rate is missing, it is reported for
 * exclusion — NEVER summed as if it were base (the pre-#1065 silent mis-sum) and
 * NEVER thrown. This is the single chokepoint every aggregate routes each holding
 * through, so net worth and the portfolio projection exclude exactly the same set
 * and their reconciliation invariant holds.
 */
export function resolveToBaseCurrency(
  value: MoneyMinor,
  baseCurrency: CurrencyCode,
  fx: FxAggregation | undefined,
): FxConversionResult {
  if (value.currency === baseCurrency) return { ok: true, value };
  if (!fx) return { ok: false, reason: "missing-rate" };
  return fx.converter.convert(value, baseCurrency, fx.asOf);
}

/** Assemble the pure {@link MoneyConverter} over a snapshot of observations. */
export function createMoneyConverter(rates: FxRateSnapshot): MoneyConverter {
  return {
    convert(amount, to, asOf) {
      if (amount.currency === to) {
        return { ok: true, value: amount };
      }

      const eurPerFrom = rates.eurPerUnit(amount.currency, asOf);
      const eurPerTo = rates.eurPerUnit(to, asOf);
      if (eurPerFrom === null || eurPerTo === null) {
        return { ok: false, reason: "missing-rate" };
      }

      // EUR pivot: (amount in EUR) / (EUR per unit of target) = amount in target.
      const converted = Math.round((amount.amountMinor * eurPerFrom) / eurPerTo);
      return { ok: true, value: money(converted, to) };
    },
  };
}
