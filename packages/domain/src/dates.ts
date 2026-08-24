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
 * A calendar day as the app reads it out loud: `2026-08-21` → `21/08/2026`.
 * Anything that is not a date key is returned verbatim — a label is never the
 * place to throw.
 */
export function formatDateKeyEs(dateKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : dateKey;
}
