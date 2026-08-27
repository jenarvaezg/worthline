/**
 * The monthly date-key grid every historical backfill lands on (ADR 0033): the
 * 1st of each month, `YYYY-MM-01`. Extracted from `price-backfill-plan.ts` (#1444)
 * so the price backfill and the historical-snapshot gap-fill share ONE calendar
 * instead of each rolling its own month arithmetic — two grids that drifted apart
 * would put the housing curve and the investment curve on different cadences,
 * which is the very bug #1444 fixes.
 *
 * Pure string arithmetic on `YYYY-MM-DD` keys: no Date, no timezone, no clock.
 */

/** The YYYY-MM-01 of the month containing `dateKey`. */
export function monthStart(dateKey: string): string {
  return `${dateKey.slice(0, 7)}-01`;
}

/** The first day of the month after `monthStartKey` (a YYYY-MM-01). */
export function nextMonthStart(monthStartKey: string): string {
  const year = Number(monthStartKey.slice(0, 4));
  const month = Number(monthStartKey.slice(5, 7)); // 1-based
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
}

/**
 * Every month-start (the 1st) from the month containing `fromDate` through
 * `throughDate`, inclusive of a month-start that equals `throughDate`.
 */
export function monthlyDateKeys(fromDate: string, throughDate: string): string[] {
  const dates: string[] = [];
  let cursor = monthStart(fromDate);
  while (cursor <= throughDate) {
    dates.push(cursor);
    cursor = nextMonthStart(cursor);
  }
  return dates;
}
