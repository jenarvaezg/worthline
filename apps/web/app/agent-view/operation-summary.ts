import type { InvestmentOperation } from "@worthline/domain";
import {
  addUnits,
  compareInvestmentOperations,
  multiplyToMinor,
} from "@worthline/domain";

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

  const ordered = [...operations].sort(compareInvestmentOperations);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];

  if (!first || !last) {
    return undefined;
  }

  let unitsBought = "0";
  let unitsSold = "0";
  let grossBuyMinor = 0;
  let grossSellMinor = 0;
  let unitsTransferredIn = "0";
  let unitsTransferredOut = "0";
  let grossTransferInMinor = 0;
  let grossTransferOutMinor = 0;
  let transferCount = 0;
  let feesMinor = 0;

  for (const operation of operations) {
    feesMinor += operation.feesMinor;
    const amountMinor = multiplyToMinor(operation.units, operation.pricePerUnit);

    // A traspaso is counted apart from the buys and sells (#1393): it moved capital
    // between products, so reporting it as a purchase or a sale would tell a reader
    // that money was invested or cashed in when neither happened.
    switch (operation.kind) {
      case "buy": {
        unitsBought = addUnits(unitsBought, operation.units);
        grossBuyMinor += amountMinor;
        break;
      }
      case "sell": {
        unitsSold = addUnits(unitsSold, operation.units);
        grossSellMinor += amountMinor;
        break;
      }
      case "transfer_in": {
        unitsTransferredIn = addUnits(unitsTransferredIn, operation.units);
        grossTransferInMinor += amountMinor;
        transferCount += 1;
        break;
      }
      case "transfer_out": {
        unitsTransferredOut = addUnits(unitsTransferredOut, operation.units);
        grossTransferOutMinor += amountMinor;
        transferCount += 1;
        break;
      }
      default: {
        const unhandled: never = operation.kind;
        throw new Error(`Unhandled operation kind: ${String(unhandled)}`);
      }
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
    ...(transferCount === 0
      ? {}
      : {
          transfers: {
            grossInAmount: moneyOf(grossTransferInMinor, currency),
            grossOutAmount: moneyOf(grossTransferOutMinor, currency),
            unitsIn: unitsTransferredIn,
            unitsOut: unitsTransferredOut,
          },
        }),
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
