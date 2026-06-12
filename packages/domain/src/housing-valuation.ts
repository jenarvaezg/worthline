import Big from "big.js";

import type { DecimalString } from "./decimal";

/**
 * Pure housing valuation curve (PRD #108, slice 4). No I/O — given the
 * valuation anchors of one real-estate asset, an optional annual appreciation
 * rate, the asset's current value, "today", and a target date, it computes the
 * asset's value on that date.
 *
 * Anchors come in two flavours, distinguished by `adjustsPriorCurve`:
 *  - market appraisal (`true`): `valueMinor` is the TOTAL value, the truth at
 *    its date. It anchors a base curve, net of the improvements before it.
 *  - improvement (`false`): `valueMinor` is an INCREMENT (a reform/upgrade)
 *    layered on top of the base curve from its date onward.
 *
 * Interpolation between appraisals and compound extrapolation beyond them are
 * always computed BY DAYS (against the actual calendar, so leap years are
 * honoured), never by whole years.
 */

export interface HousingValuationAnchor {
  /** YYYY-MM-DD the value applies on. */
  valuationDate: string;
  /**
   * Integer minor units. TOTAL value when `adjustsPriorCurve` is true (a market
   * appraisal), INCREMENT when false (an improvement / reform).
   */
  valueMinor: number;
  /** True for a market appraisal (total truth), false for an improvement. */
  adjustsPriorCurve: boolean;
}

export interface ValueHousingAtDateInput {
  /** Every valuation anchor for the asset (any order). */
  anchors: readonly HousingValuationAnchor[];
  /** Decimal string annual rate, e.g. "0.03". Omitted/undefined means no drift. */
  annualAppreciationRate?: DecimalString | null;
  /** The asset's current stored value in integer minor units (the value "today"). */
  currentValueMinor: number;
  /** "Today" as YYYY-MM-DD — a parameter for purity/testability, never Date.now(). */
  today: string;
  /** The date to value the asset on, YYYY-MM-DD. */
  targetDate: string;
}

/**
 * One point on the market curve. `baseMinor` is the appraisal value net of the
 * improvements before it (interpolation/back-extrapolation runs on this, so the
 * improvements are not double-counted when layered back at query time);
 * `totalMinor` is the raw appraisal value (forward extrapolation compounds this
 * whole, since the appraisal is the total truth at its date).
 */
interface BasePoint {
  dateKey: string;
  baseMinor: Big;
  totalMinor: Big;
}

const MS_PER_DAY = 86_400_000;

/** Whole days from `from` to `to` (UTC midnights), signed. */
function daysBetween(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((toMs - fromMs) / MS_PER_DAY);
}

/** Days in the calendar year that `dateKey` falls in (365 or 366). */
function daysInYearOf(dateKey: string): number {
  const year = Number(dateKey.slice(0, 4));
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return isLeap ? 366 : 365;
}

/**
 * Compound a value by the rate from `anchorDateKey` to `targetDateKey`:
 * value × (1 + rate)^(days / daysInYear). The span is measured in whole days and
 * divided by the length of the calendar year the EARLIER endpoint of the span
 * falls in, so a span sitting inside (or starting in) a leap year is normalised
 * over 366 days. `days` is signed — negative extrapolates into the past.
 */
function compound(
  value: Big,
  rate: Big,
  anchorDateKey: string,
  targetDateKey: string,
): Big {
  const days = daysBetween(anchorDateKey, targetDateKey);
  const earlier = anchorDateKey < targetDateKey ? anchorDateKey : targetDateKey;
  const yearFraction = days / daysInYearOf(earlier);
  const factor = new Big(Math.pow(rate.plus(1).toNumber(), yearFraction));
  return value.times(factor);
}

/** Sum of improvement increments whose date satisfies the predicate, in minor units. */
function sumImprovements(
  anchors: readonly HousingValuationAnchor[],
  keep: (dateKey: string) => boolean,
): Big {
  let total = new Big(0);
  for (const anchor of anchors) {
    if (!anchor.adjustsPriorCurve && keep(anchor.valuationDate)) {
      total = total.plus(anchor.valueMinor);
    }
  }
  return total;
}

/**
 * Build the base (market) curve points, sorted ascending by date. Each market
 * appraisal's base is its total value minus the improvements strictly before it
 * (those are layered back on at query time). When there are no market
 * appraisals, the current value acts as an implicit appraisal "today" (its base
 * is the current value minus ALL improvements).
 */
function buildBaseCurve(
  anchors: readonly HousingValuationAnchor[],
  currentValueMinor: number,
  today: string,
): BasePoint[] {
  const appraisals = anchors
    .filter((anchor) => anchor.adjustsPriorCurve)
    .sort((a, b) => (a.valuationDate < b.valuationDate ? -1 : 1));

  if (appraisals.length === 0) {
    const total = new Big(currentValueMinor);
    const base = total.minus(sumImprovements(anchors, () => true));
    return [{ baseMinor: base, dateKey: today, totalMinor: total }];
  }

  return appraisals.map((appraisal) => {
    const total = new Big(appraisal.valueMinor);
    return {
      baseMinor: total.minus(
        sumImprovements(anchors, (dateKey) => dateKey < appraisal.valuationDate),
      ),
      dateKey: appraisal.valuationDate,
      totalMinor: total,
    };
  });
}

/** Round a Big minor-unit value to a whole integer minor unit, half up. */
function toMinorInt(value: Big): number {
  return Number(value.round(0, Big.roundHalfUp).toString());
}

/**
 * Value the housing asset on `targetDate`. See the module doc for the curve
 * model. The result is integer minor units, rounded half up to the cent.
 */
export function valueHousingAtDate(input: ValueHousingAtDateInput): number {
  const { anchors, currentValueMinor, targetDate, today } = input;
  const rate =
    input.annualAppreciationRate != null && input.annualAppreciationRate !== ""
      ? new Big(input.annualAppreciationRate)
      : null;

  const curve = buildBaseCurve(anchors, currentValueMinor, today);
  const first = curve[0]!;
  const last = curve[curve.length - 1]!;

  if (targetDate < first.dateKey) {
    // Before the first appraisal: compound the first base backward (the base
    // curve, so improvements dated ≤ target are layered back on flat).
    const base = rate
      ? compound(first.baseMinor, rate, first.dateKey, targetDate)
      : first.baseMinor;
    const improvements = sumImprovements(anchors, (dateKey) => dateKey <= targetDate);
    return toMinorInt(base.plus(improvements));
  }

  if (targetDate > last.dateKey) {
    // After the last appraisal: the appraisal is the total truth, so its whole
    // total compounds forward and ONLY improvements strictly after it are added.
    const total = rate
      ? compound(last.totalMinor, rate, last.dateKey, targetDate)
      : last.totalMinor;
    const improvements = sumImprovements(
      anchors,
      (dateKey) => dateKey > last.dateKey && dateKey <= targetDate,
    );
    return toMinorInt(total.plus(improvements));
  }

  // On or between appraisals: linear interpolation on the base curve by days,
  // plus every improvement dated on or before the target. On an appraisal date
  // exactly, the interpolated base equals that appraisal's base, so base +
  // improvements-before reconstitutes the appraisal's total truth.
  let lower = first;
  let upper = last;
  for (let i = 0; i < curve.length - 1; i += 1) {
    const a = curve[i]!;
    const b = curve[i + 1]!;
    if (targetDate >= a.dateKey && targetDate <= b.dateKey) {
      lower = a;
      upper = b;
      break;
    }
  }
  const span = daysBetween(lower.dateKey, upper.dateKey);
  const offset = daysBetween(lower.dateKey, targetDate);
  const fraction = span === 0 ? new Big(0) : new Big(offset).div(span);
  const base = lower.baseMinor.plus(upper.baseMinor.minus(lower.baseMinor).times(fraction));
  const improvements = sumImprovements(anchors, (dateKey) => dateKey <= targetDate);
  return toMinorInt(base.plus(improvements));
}
