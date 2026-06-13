import type { CurrencyCode } from "./money";
import type { DecimalString } from "./decimal";

import {
  addUnits,
  averageUnitCost,
  compareUnits,
  multiplyToMinor,
  proportionMinor,
  subtractUnits,
} from "./decimal";
import type { DomainResult, DomainViolation } from "./domain-result";
import type {
  CreateInvestmentOperationInput,
  InvestmentOperation,
  PositionSummary,
} from "./investment-types";
import { assertMinorInteger, money, subtractMoney } from "./money";

/** Operations whose executedAt date falls on or before the target date. */
export function operationsUpTo(
  operations: readonly InvestmentOperation[] | undefined,
  targetDate: string,
): InvestmentOperation[] {
  if (!operations) return [];
  return operations.filter(
    (operation) => operation.executedAt.slice(0, 10) <= targetDate,
  );
}

/** The unit price of the latest operation on or before the date. */
export function latestOperationPrice(
  operations: readonly InvestmentOperation[],
): DecimalString | undefined {
  let latest: InvestmentOperation | undefined;
  for (const operation of operations) {
    if (
      !latest ||
      operation.executedAt > latest.executedAt ||
      (operation.executedAt === latest.executedAt && operation.id > latest.id)
    ) {
      latest = operation;
    }
  }
  return latest?.pricePerUnit;
}

/**
 * Validate and normalize a single investment operation. Units must be positive,
 * price non-negative, fees a non-negative integer minor amount. Throws on
 * violation so invalid operations never reach the ledger.
 *
 * Programmer-error paths still throw; only the three bound violations become data.
 * Prefer `createInvestmentOperationSafe` for user-facing call sites.
 */
export function createInvestmentOperation(
  input: CreateInvestmentOperationInput,
): InvestmentOperation {
  if (compareUnits(input.units, "0") <= 0) {
    throw new Error("Operation units must be positive.");
  }

  if (compareUnits(input.pricePerUnit, "0") < 0) {
    throw new Error("Operation price must not be negative.");
  }

  const feesMinor = input.feesMinor ?? 0;
  assertMinorInteger(feesMinor);

  if (feesMinor < 0) {
    throw new Error("Operation fees must not be negative.");
  }

  return {
    assetId: input.assetId,
    currency: input.currency,
    executedAt: input.executedAt,
    feesMinor,
    id: input.id,
    kind: input.kind,
    pricePerUnit: input.pricePerUnit,
    units: input.units,
  };
}

/**
 * Safe variant of `createInvestmentOperation`: returns a `DomainResult` instead
 * of throwing when operation bound rules are violated.
 * The three rule violations (units not positive, price negative, fees negative)
 * become data with stable machine-readable codes. Programmer errors (non-integer
 * fees) still throw.
 */
export function createInvestmentOperationSafe(
  input: CreateInvestmentOperationInput,
): DomainResult<InvestmentOperation> {
  if (compareUnits(input.units, "0") <= 0) {
    return {
      ok: false,
      violations: [
        { code: "operation_units_not_positive" } satisfies Extract<
          DomainViolation,
          { code: "operation_units_not_positive" }
        >,
      ],
    };
  }

  if (compareUnits(input.pricePerUnit, "0") < 0) {
    return {
      ok: false,
      violations: [
        { code: "operation_price_negative" } satisfies Extract<
          DomainViolation,
          { code: "operation_price_negative" }
        >,
      ],
    };
  }

  const feesMinor = input.feesMinor ?? 0;
  assertMinorInteger(feesMinor);

  if (feesMinor < 0) {
    return {
      ok: false,
      violations: [
        { code: "operation_fees_negative" } satisfies Extract<
          DomainViolation,
          { code: "operation_fees_negative" }
        >,
      ],
    };
  }

  return {
    ok: true,
    value: {
      assetId: input.assetId,
      currency: input.currency,
      executedAt: input.executedAt,
      feesMinor,
      id: input.id,
      kind: input.kind,
      pricePerUnit: input.pricePerUnit,
      units: input.units,
    },
  };
}

/**
 * The position-math module. Folds an investment asset's buy/sell ledger into its
 * current units, cost basis, and weighted-average cost using a moving average
 * (tax-agnostic: no FIFO/LIFO). All money crosses the Money seam and all unit/price
 * arithmetic crosses the decimal seam, so this module stays pure and testable.
 */

export interface DerivePositionOptions {
  assetId: string;
  currency: CurrencyCode;
  currentPricePerUnit?: DecimalString;
}

export function derivePosition(
  operations: InvestmentOperation[],
  options: DerivePositionOptions,
): PositionSummary {
  let units: DecimalString = "0";
  let costMinor = 0;
  const warnings: string[] = [];

  const ordered = [...operations].sort((left, right) =>
    left.executedAt === right.executedAt
      ? left.id.localeCompare(right.id)
      : left.executedAt.localeCompare(right.executedAt),
  );

  for (const operation of ordered) {
    if (operation.kind === "buy") {
      costMinor +=
        multiplyToMinor(operation.units, operation.pricePerUnit) + operation.feesMinor;
      units = addUnits(units, operation.units);
    } else {
      // Sell: remove units and a proportional slice of cost basis at the running
      // weighted average. The sale price affects realized P/L (out of scope here),
      // not the cost basis of the remaining units, so it is not read.
      let sellUnits = operation.units;

      if (compareUnits(sellUnits, units) > 0) {
        // Overrideable warning, not a failure: clamp to what's actually held so the
        // position never goes negative.
        warnings.push(
          `La venta de ${sellUnits} unidades supera las ${units} disponibles; se ajusta al máximo.`,
        );
        sellUnits = units;
      }

      costMinor -= proportionMinor(costMinor, sellUnits, units);
      units = subtractUnits(units, sellUnits);
    }
  }

  const summary: PositionSummary = {
    assetId: options.assetId,
    averageUnitCost: averageUnitCost(costMinor, units),
    costBasis: money(costMinor, options.currency),
    currency: options.currency,
    currentUnits: units,
    warnings,
  };

  if (options.currentPricePerUnit === undefined) {
    return summary;
  }

  const marketValue = money(
    multiplyToMinor(units, options.currentPricePerUnit),
    options.currency,
  );

  return {
    ...summary,
    currentPricePerUnit: options.currentPricePerUnit,
    marketValue,
    unrealizedPnl: subtractMoney(marketValue, summary.costBasis),
  };
}
