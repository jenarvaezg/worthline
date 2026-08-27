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
 * `positionHeldAt` is the ONE test both grids share, so they can never disagree
 * about which months exist.
 *
 * Pure: no clock (the caller passes `today`), no reads, no writes.
 */

import type { InvestmentOperation } from "./investment-types";
import { monthlyDateKeys } from "./monthly-calendar";
import { earliestOperationDate, positionHeldAt } from "./positions";

export interface MonthlyFloorInput {
  /** Every investment's operation ledger, keyed by asset id (any order). */
  operationsByAsset: ReadonlyMap<string, readonly InvestmentOperation[]>;
  /** "Today" as YYYY-MM-DD — the EXCLUSIVE upper bound (today is the daily capture's). */
  today: string;
}

/**
 * The `YYYY-MM-01` dates the historical backfill must guarantee: every month from
 * the first past operation up to (but not including) `today` in which at least one
 * investment held units. Sorted ascending.
 */
export function monthlyFloorDateKeys(input: MonthlyFloorInput): string[] {
  const ledgers = [...input.operationsByAsset.values()].filter((ops) => ops.length > 0);
  if (ledgers.length === 0) return [];

  // The range opens at the earliest PAST operation: a ledger that only reaches
  // into the future is not history yet (ADR 0012), and opens no range at all.
  let firstOperationDate: string | undefined;
  for (const operations of ledgers) {
    const earliest = earliestOperationDate(
      operations.filter((operation) => operation.executedAt.slice(0, 10) < input.today),
    );
    if (earliest === undefined) continue;
    if (firstOperationDate === undefined || earliest < firstOperationDate) {
      firstOperationDate = earliest;
    }
  }
  if (firstOperationDate === undefined) return [];

  // `monthlyDateKeys` runs THROUGH its bound; today belongs to the daily capture,
  // so the last month-start it yields is dropped when it IS today.
  return monthlyDateKeys(firstOperationDate, input.today)
    .filter((dateKey) => dateKey < input.today)
    .filter((dateKey) =>
      ledgers.some((operations) => positionHeldAt(operations, dateKey) !== undefined),
    );
}
