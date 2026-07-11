/**
 * Monthly allocation view over a contribution plan (ADR 0041, PRD #553 S3).
 *
 * "Where does my capital go this month" — a derived, read-only projection of
 * the plan's occurrences for one calendar month, in money terms. Forecast only:
 * it never enters net worth or snapshots. When reconciliation truth (S2)
 * exists it is contrasted per destination, but the headline is the forward split.
 */

import type {
  ContributionOccurrenceReconciliation,
  ContributionPlan,
} from "./contribution-plan";
import {
  contributionOccurrenceMoneyMinor,
  projectContributionReconciliation,
} from "./contribution-plan";
import { addUnits } from "./decimal";
import type { InvestmentOperation } from "./investment-types";

export interface MonthlyAllocationDestination {
  holdingId: string;
  /** Plan occurrences landing in the month for this destination. */
  occurrenceCount: number;
  /**
   * Planned money for the month (money amounts plus units × current price).
   * Null when any units occurrence lacks a price — never guessed.
   */
  plannedMinor: number | null;
  /** Sum of units-mode planned amounts, for honest display when unpriced. */
  plannedUnits: string | null;
  /** Real money confirmed against this month's occurrences via S2. */
  executedMinor: number;
  /** Occurrences already closed (fulfilled or skipped). */
  closedCount: number;
}

export interface MonthlyContributionAllocation {
  /** Calendar month in YYYY-MM. */
  monthKey: string;
  /** Sorted by planned money descending; unpriced destinations last. */
  destinations: MonthlyAllocationDestination[];
  /** Sum of priceable planned money — unpriced destinations are excluded, not guessed. */
  totalPlannedMinor: number;
  totalExecutedMinor: number;
  unpricedHoldingIds: string[];
  occurrenceCount: number;
}

const MONTH_KEY = /^\d{4}-\d{2}$/;

function monthBounds(monthKey: string): { fromDate: string; toDate: string } {
  const [year, month] = monthKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year ?? 1970, month ?? 1, 0)).getUTCDate();
  return {
    fromDate: `${monthKey}-01`,
    toDate: `${monthKey}-${String(lastDay).padStart(2, "0")}`,
  };
}

/**
 * Derive the month's capital split across destination holdings. Read-only over
 * S1's expansion and S2's reconciliation projection — no math duplicated here.
 */
export function computeMonthlyContributionAllocation(input: {
  plan: ContributionPlan;
  monthKey: string;
  today: string;
  unitPriceMajorByHoldingId?: Record<string, string>;
  reconciliations?: ContributionOccurrenceReconciliation[];
  operations?: InvestmentOperation[];
}): MonthlyContributionAllocation {
  if (!MONTH_KEY.test(input.monthKey)) {
    throw new Error(`Month key must be in YYYY-MM format, got "${input.monthKey}".`);
  }
  const { fromDate, toDate } = monthBounds(input.monthKey);
  const projection = projectContributionReconciliation({
    plan: input.plan,
    fromDate,
    toDate,
    today: input.today,
    reconciliations: input.reconciliations ?? [],
    operations: input.operations ?? [],
  });

  const byHolding = new Map<string, MonthlyAllocationDestination>();
  const projected = [...projection.pending, ...projection.closed];
  for (const item of projected) {
    const { occurrence } = item;
    const row = byHolding.get(occurrence.destinationHoldingId) ?? {
      holdingId: occurrence.destinationHoldingId,
      occurrenceCount: 0,
      plannedMinor: 0,
      plannedUnits: null,
      executedMinor: 0,
      closedCount: 0,
    };

    const occurrenceMinor = contributionOccurrenceMoneyMinor(
      occurrence,
      input.unitPriceMajorByHoldingId,
    );
    const plannedMinor =
      row.plannedMinor === null || occurrenceMinor === null
        ? null
        : row.plannedMinor + occurrenceMinor;
    const plannedUnits =
      occurrence.amount.mode === "units"
        ? addUnits(row.plannedUnits ?? "0", occurrence.amount.value)
        : row.plannedUnits;
    const executedMinor =
      item.summary.mode === "money"
        ? item.summary.executedMinor
        : item.summary.actualCashMinor;

    byHolding.set(occurrence.destinationHoldingId, {
      holdingId: occurrence.destinationHoldingId,
      occurrenceCount: row.occurrenceCount + 1,
      plannedMinor,
      plannedUnits,
      executedMinor: row.executedMinor + executedMinor,
      closedCount:
        row.closedCount +
        (item.state === "fulfilled" || item.state === "skipped" ? 1 : 0),
    });
  }

  const destinations = [...byHolding.values()].sort((a, b) => {
    if (a.plannedMinor === null && b.plannedMinor === null) {
      return a.holdingId.localeCompare(b.holdingId);
    }
    if (a.plannedMinor === null) return 1;
    if (b.plannedMinor === null) return -1;
    return b.plannedMinor - a.plannedMinor || a.holdingId.localeCompare(b.holdingId);
  });

  return {
    monthKey: input.monthKey,
    destinations,
    totalPlannedMinor: destinations.reduce((s, d) => s + (d.plannedMinor ?? 0), 0),
    totalExecutedMinor: destinations.reduce((s, d) => s + d.executedMinor, 0),
    unpricedHoldingIds: destinations
      .filter((d) => d.plannedMinor === null)
      .map((d) => d.holdingId)
      .sort(),
    occurrenceCount: projected.length,
  };
}
