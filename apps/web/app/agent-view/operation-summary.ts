import type { InvestmentOperation } from "@worthline/domain";
import { addUnits, multiplyToMinor } from "@worthline/domain";

import type { AgentViewMoney, AgentViewOperationSummary } from "./contract";

/**
 * Fold an investment holding's operations into compact totals (PRD #328). Raw
 * ledger amounts — not scope-weighted — since operations are facts about the
 * holding, not a member's slice. Returns undefined when there are no operations.
 * Shared by the compact context (#335) and holding detail (#337) so the folded
 * summary cannot drift between them.
 */
export function summarizeOperations(
  operations: InvestmentOperation[],
  currency: string,
): AgentViewOperationSummary | undefined {
  if (operations.length === 0) {
    return undefined;
  }

  const ordered = [...operations].sort((a, b) =>
    a.executedAt === b.executedAt
      ? a.id.localeCompare(b.id)
      : a.executedAt.localeCompare(b.executedAt),
  );
  const first = ordered[0];
  const last = ordered[ordered.length - 1];

  if (!first || !last) {
    return undefined;
  }

  let unitsBought = "0";
  let unitsSold = "0";
  let grossBuyMinor = 0;
  let grossSellMinor = 0;
  let feesMinor = 0;

  for (const operation of operations) {
    feesMinor += operation.feesMinor;
    const amountMinor = multiplyToMinor(operation.units, operation.pricePerUnit);
    if (operation.kind === "buy") {
      unitsBought = addUnits(unitsBought, operation.units);
      grossBuyMinor += amountMinor;
    } else {
      unitsSold = addUnits(unitsSold, operation.units);
      grossSellMinor += amountMinor;
    }
  }

  return {
    feesTotal: moneyOf(feesMinor, currency),
    // Date keys only — `executedAt` may carry a time, but the operation rows in
    // get_operations expose `YYYY-MM-DD`, so the summary must match (no time drift).
    firstOperationDate: dateKey(first),
    grossBuyAmount: moneyOf(grossBuyMinor, currency),
    grossSellAmount: moneyOf(grossSellMinor, currency),
    latestOperationDate: dateKey(last),
    operationCount: operations.length,
    unitsBought,
    unitsSold,
  };
}

function dateKey(operation: InvestmentOperation): string {
  return operation.executedAt.slice(0, 10);
}

function moneyOf(amountMinor: number, currency: string): AgentViewMoney {
  return { amountMinor, currency };
}
