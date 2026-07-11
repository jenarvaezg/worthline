/**
 * Historical-price backfill PLAN (#380, ADR 0033) — the preview core.
 *
 * Folds an investment's operation ledger, the historical prices a source
 * returned, the dates it already has snapshots on, and "today" into the monthly
 * points the backfill would write and the months it cannot price (gaps). One
 * point per month-start (the 1st) from the first-operation month through today,
 * but ONLY for a month the position actually existed (units > 0 ≤ that date,
 * folded via `derivePosition`). A priced month becomes a `create`/`update` point
 * valued at `units × price`, taking the month's FIRST available price within a
 * one-week window after the 1st (exchange sources only quote trading days — see
 * `monthStartPrice`); a month with a position but NO price becomes a GAP — never
 * a fabricated point. A month before the first operation, or after the
 * position was fully sold, is skipped entirely (neither point nor gap).
 *
 * INTENTIONAL RESTATEMENT (ADR 0033): an `update` point is emitted for EVERY
 * position-bearing month the source can price — including a month whose existing
 * row already carried a genuine captured price — and the apply's `overrideUnitPrice`
 * wins over that captured price. The backfill is the explicit single writer of
 * historical unit_price, so it restates the whole monthly series from the chosen
 * source rather than only the cost-basis gaps. Impact is bounded (for the asset's
 * own provider the source matches the captured price), but it is a conscious wider
 * blast radius than "only cost months"; see ADR 0033 Consequences.
 *
 * Pure: writes nothing, reads no clock — the caller passes `today` and the price
 * map. The db apply seam (M4) consumes `points` to freeze unit prices; the web
 * preview (M5) reports the counts, the source, and the gaps before any write.
 */

import type { DecimalString } from "./decimal";
import { compareUnits, multiplyToMinor } from "./decimal";
import type { InvestmentOperation } from "./investment-types";
import { derivePosition, operationsUpTo } from "./positions";

/** Whether a planned point creates a new snapshot or updates an existing one. */
export type PriceBackfillAction = "create" | "update";

/** One planned monthly backfill point — a frozen, priced row for a date. */
export interface PriceBackfillPoint {
  /** The YYYY-MM-DD month-start the point lands on. */
  dateKey: string;
  /** Units held on that date (folded from the ledger ≤ date). */
  units: DecimalString;
  /** The historical unit price the source returned for that date. */
  unitPriceDecimal: DecimalString;
  /** units × unit price, in integer minor units. */
  valueMinor: number;
  /** Create a new snapshot, or update the existing one at this date. */
  action: PriceBackfillAction;
}

export interface PlanPriceBackfillInput {
  /** Every operation for the investment (any order). */
  operations: readonly InvestmentOperation[];
  /** The YYYY-MM-DD dates the asset already has snapshots on (any scope). */
  existingSnapshotDates: ReadonlySet<string>;
  /** Historical unit prices the source returned, keyed by YYYY-MM-DD. */
  pricesByDate: ReadonlyMap<string, DecimalString>;
  /** The source label that produced `pricesByDate` (audit metadata). */
  source: string;
  /** "Today" as YYYY-MM-DD — the inclusive upper bound of the monthly range. */
  today: string;
}

/** The backfill plan: the points to write, the months it cannot price, the source. */
export interface PriceBackfillPlan {
  points: PriceBackfillPoint[];
  /** Month-start dates with a position but no available price — never invented. */
  gaps: string[];
  /** The source that produced the prices (carried through for the UI/metadata). */
  source: string;
}

/** The YYYY-MM-01 of the month containing `dateKey`. */
function monthStart(dateKey: string): string {
  return `${dateKey.slice(0, 7)}-01`;
}

/** The first day of the month after `monthStartKey` (a YYYY-MM-01). */
function nextMonthStart(monthStartKey: string): string {
  const year = Number(monthStartKey.slice(0, 4));
  const month = Number(monthStartKey.slice(5, 7)); // 1-based
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
}

/** Every month-start (the 1st) from the first-op month through today, inclusive. */
function monthlyDateKeys(firstOperationDate: string, today: string): string[] {
  const dates: string[] = [];
  let cursor = monthStart(firstOperationDate);
  while (cursor <= today) {
    dates.push(cursor);
    cursor = nextMonthStart(cursor);
  }
  return dates;
}

const MS_PER_DAY = 86_400_000;

/**
 * How many days into a month the plan searches for that month's first available
 * price. Exchange-quoted sources (Yahoo) only price TRADING days — the 1st is
 * often a weekend or holiday (January 1st always is), so an exact-day-1 lookup
 * would report a gap for a month the source prices perfectly well. A week covers
 * any weekend + holiday run without reaching into mid-month prices.
 */
const MONTH_START_PRICE_WINDOW_DAYS = 7;

/**
 * The month's first available price on or after its 1st, within the window,
 * never past `today` and never crossing into the next month. The point still
 * lands on the month-start dateKey — this is the month's opening close, not an
 * invented day-1 price; a month with no price inside the window stays a gap.
 */
function monthStartPrice(
  pricesByDate: ReadonlyMap<string, DecimalString>,
  monthStartKey: string,
  today: string,
): DecimalString | undefined {
  const startMs = Date.parse(`${monthStartKey}T00:00:00.000Z`);
  if (!Number.isFinite(startMs)) return undefined;

  for (let offset = 0; offset < MONTH_START_PRICE_WINDOW_DAYS; offset += 1) {
    const dateKey = new Date(startMs + offset * MS_PER_DAY).toISOString().slice(0, 10);
    if (dateKey.slice(0, 7) !== monthStartKey.slice(0, 7)) break;
    if (dateKey > today) break;

    const price = pricesByDate.get(dateKey);
    if (price !== undefined) return price;
  }
  return undefined;
}

export function planPriceBackfill(input: PlanPriceBackfillInput): PriceBackfillPlan {
  const points: PriceBackfillPoint[] = [];
  const gaps: string[] = [];

  if (input.operations.length === 0) {
    return { gaps, points, source: input.source };
  }

  const firstOperationDate = input.operations
    .map((op) => op.executedAt.slice(0, 10))
    .reduce((min, date) => (date < min ? date : min));

  const assetId = input.operations[0]!.assetId;
  const currency = input.operations[0]!.currency;

  for (const dateKey of monthlyDateKeys(firstOperationDate, input.today)) {
    // Fold the ledger to this date; skip a month with no position (before the
    // first op, or fully sold by then) — it is neither a point nor a gap.
    const opsUpTo = operationsUpTo(input.operations, dateKey);
    if (opsUpTo.length === 0) continue;

    const position = derivePosition(opsUpTo, { assetId, currency });
    if (compareUnits(position.currentUnits, "0") === 0) continue;

    const unitPriceDecimal = monthStartPrice(input.pricesByDate, dateKey, input.today);
    if (unitPriceDecimal === undefined) {
      // A position existed but the source had no price → a gap, never invented.
      gaps.push(dateKey);
      continue;
    }

    points.push({
      action: input.existingSnapshotDates.has(dateKey) ? "update" : "create",
      dateKey,
      unitPriceDecimal,
      units: position.currentUnits,
      valueMinor: multiplyToMinor(position.currentUnits, unitPriceDecimal),
    });
  }

  return { gaps, points, source: input.source };
}
