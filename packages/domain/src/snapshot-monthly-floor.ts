/**
 * The monthly FLOOR of the pre-signup history (#1444).
 *
 * The historical gap-fill (ADR 0012) generates a snapshot per dated fact, so the
 * resolution of the curve measured how often the user OPERATED, not how much time
 * passed: a month with four trades got four points, a quiet month got none, and the
 * chart drew an 18-day straight line through it — next to a housing curve that is
 * monthly by construction (its amortization schedule). Two cadences in one graph.
 *
 * This is the floor that levels them: the 1st of every month the portfolio actually
 * held something, on the SAME grid as the price backfill (ADR 0033, `monthlyDateKeys`).
 * It is a UNION with the event dates, never a replacement — a month where the user
 * did operate keeps its density. It is NOT "backfill every date between events",
 * which ADR 0012 rejected and still rejects.
 *
 * A month before the first purchase, or after everything was sold, yields nothing:
 * the same `derivePosition` test the price plan applies, so the two grids can never
 * disagree about which months exist.
 *
 * Pure: no clock (the caller passes `today`), no reads, no writes.
 */

import { compareUnits } from "./decimal";
import type { InvestmentOperation } from "./investment-types";
import { monthlyDateKeys } from "./monthly-calendar";
import { derivePosition, operationsUpTo } from "./positions";

export interface MonthlyFloorInput {
  /** Every investment's operation ledger, keyed by asset id (any order). */
  operationsByAsset: ReadonlyMap<string, readonly InvestmentOperation[]>;
  /** "Today" as YYYY-MM-DD — the EXCLUSIVE upper bound (today is the daily capture's). */
  today: string;
}

/** Whether the ledger still holds units on `dateKey` (the price plan's test). */
function holdsUnitsAt(
  operations: readonly InvestmentOperation[],
  dateKey: string,
): boolean {
  const opsUpTo = operationsUpTo(operations, dateKey);
  if (opsUpTo.length === 0) return false;

  const first = operations[0]!;
  const position = derivePosition(opsUpTo, {
    assetId: first.assetId,
    currency: first.currency,
  });
  return compareUnits(position.currentUnits, "0") !== 0;
}

/**
 * The `YYYY-MM-01` dates the historical backfill must guarantee: every month from
 * the first past operation up to (but not including) `today` in which at least one
 * investment held units. Sorted ascending.
 */
export function monthlyFloorDateKeys(input: MonthlyFloorInput): string[] {
  const ledgers = [...input.operationsByAsset.values()].filter((ops) => ops.length > 0);
  if (ledgers.length === 0) return [];

  let firstOperationDate: string | undefined;
  for (const operations of ledgers) {
    for (const operation of operations) {
      const dateKey = operation.executedAt.slice(0, 10);
      if (dateKey >= input.today) continue; // the future is not history (ADR 0012)
      if (firstOperationDate === undefined || dateKey < firstOperationDate) {
        firstOperationDate = dateKey;
      }
    }
  }
  if (firstOperationDate === undefined) return [];

  const dates: string[] = [];
  for (const dateKey of monthlyDateKeys(firstOperationDate, input.today)) {
    if (dateKey >= input.today) continue;
    if (ledgers.some((operations) => holdsUnitsAt(operations, dateKey))) {
      dates.push(dateKey);
    }
  }
  return dates;
}
