/**
 * Shared calendar-day arithmetic for the valuation engines.
 *
 * One source of truth for the UTC-midnight day count every interpolating engine
 * (amortization, housing, debt-balance) rides, so the displayed opening-period
 * length matches the days interest/value is computed from (ADR 0019).
 */

export const MS_PER_DAY = 86_400_000;

declare const dateKeyBrand: unique symbol;
declare const instantBrand: unique symbol;

export type DateKey = string & { readonly [dateKeyBrand]: true };
export type Instant = string & { readonly [instantBrand]: true };

export function asDateKey(value: string): DateKey {
  return value as DateKey;
}

export function asInstant(value: string): Instant {
  return value as Instant;
}

/** Whole days from `from` to `to` (UTC midnights), signed. */
export function daysBetween(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((toMs - fromMs) / MS_PER_DAY);
}

/**
 * Days the month `monthIndex` (0-based, the `Date` convention) of `year` has —
 * 28/29 for February included. `Date.UTC(year, monthIndex + 1, 0)` is the last
 * millisecond of the month before the next one, i.e. its own last day.
 *
 * The month-length answer for the whole package: the schedule engines all clamp a
 * recurring day-of-month to it, and three of them used to spell it themselves
 * (#1693), one with a 1-based month.
 */
export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * `count` whole months after `date` (UTC), keeping the day-of-month and CLAMPING
 * it to the destination month's length: 2020-01-31 + 1 → 2020-02-29, never the
 * "2020-02-31" that `Date` silently rolls to March 2nd.
 *
 * There are two spellings of «un mes después» in the package, one per date
 * representation, and they are NOT interchangeable:
 *
 * - **`Date` in, `Date` out — this one.** The cadence steppers of the recurring
 *   schedules (contribution-plan, payouts) walk occurrences as `Date`s, comparing
 *   and adding days on the same object; a string round-trip per step would be
 *   noise. Measure the k-th occurrence from the ORIGINAL start, never by adding a
 *   month to the previous result: only then does a schedule anchored on the 31st
 *   recover the 31st after clamping to 28 (a clamp compounded month by month
 *   walks the anchor down and never back).
 * - **`YYYY-MM-DD` in, same out — `addMonths` in `amortization.ts`.** Canonical
 *   for a date KEY, which is what a payment boundary, a stored fact and an ADR
 *   0019 plan speak; it is pure string arithmetic and stays exact without ever
 *   building a `Date`. Anything holding date keys uses that one.
 *
 * Both clamp the same way, so a boundary derived through either lands on the same
 * calendar day — but they are kept apart on purpose (#1693): converting a key to a
 * `Date` just to add a month invites the timezone drift neither of them has.
 */
export function addMonthsToDate(date: Date, count: number): Date {
  const day = date.getUTCDate();
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
  next.setUTCDate(Math.min(day, daysInMonth(next.getUTCFullYear(), next.getUTCMonth())));
  return next;
}

/** Whether a string has the `YYYY-MM-DD` shape a date key must have. */
export function isDateKeyShaped(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Whether a string is a real calendar day: the `YYYY-MM-DD` shape AND a day that
 * exists. The shape check alone accepts `2026-02-30`, which `Date` silently
 * rolls forward to March 1st — so anything that later orders or subtracts on the
 * stored key would be working with a day nobody meant.
 */
export function isRealCalendarDay(value: string): boolean {
  if (!isDateKeyShaped(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * A calendar day as the app reads it out loud: `2026-08-21` → `21/08/2026`.
 * Anything that is not a date key is returned verbatim — a label is never the
 * place to throw.
 */
export function formatDateKeyEs(dateKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : dateKey;
}
