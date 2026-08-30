import type { CostBasisGrade } from "./cost-basis-grade";
import { worseCostBasisGrade } from "./cost-basis-grade";
import { asInstant } from "./dates";
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
  OperationKind,
  PositionSummary,
  PositionWarning,
} from "./investment-types";
import type { CurrencyCode } from "./money";
import { assertMinorInteger, money, subtractMoney } from "./money";
import { mixedCurrencyWarning } from "./operation-currency";
import { unhandledOperationKind } from "./operation-flow";

/** Canonical ledger order: calendar date, optional UTC source instant, stable id. */
export function compareInvestmentOperations(
  left: InvestmentOperation,
  right: InvestmentOperation,
): number {
  const byDate = left.executedAt
    .slice(0, 10)
    .localeCompare(right.executedAt.slice(0, 10));
  if (byDate !== 0) return byDate;
  const byOccurredAt = (left.occurredAt ?? "").localeCompare(right.occurredAt ?? "");
  return byOccurredAt !== 0 ? byOccurredAt : left.id.localeCompare(right.id);
}

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
    if (!latest || compareInvestmentOperations(operation, latest) > 0) {
      latest = operation;
    }
  }
  return latest?.pricePerUnit;
}

/**
 * Validate and normalize a single investment operation. Units must be positive,
 * price non-negative, fees a non-negative integer minor amount, and the traspaso
 * columns consistent with the kind (see `assertTransferColumns`). Throws on
 * violation so invalid operations never reach the ledger.
 *
 * Programmer-error paths still throw; only the three bound violations become data.
 * Prefer `createInvestmentOperationSafe` for user-facing call sites.
 */
export function createInvestmentOperation(
  input: CreateInvestmentOperationInput,
): InvestmentOperation {
  if (
    input.occurredAt !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(input.occurredAt) ||
      !Number.isFinite(Date.parse(input.occurredAt)))
  ) {
    throw new Error("Operation occurredAt must be a UTC timestamp.");
  }
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

  assertTransferColumns(input);
  assertCostBasisGrade(input);

  return {
    assetId: input.assetId,
    ...(input.capture === undefined ? {} : { capture: input.capture }),
    ...(input.costBasisGrade === undefined
      ? {}
      : { costBasisGrade: input.costBasisGrade }),
    currency: input.currency,
    executedAt: input.executedAt,
    feesMinor,
    id: input.id,
    kind: input.kind,
    ...(input.occurredAt === undefined
      ? {}
      : { occurredAt: asInstant(input.occurredAt) }),
    pricePerUnit: input.pricePerUnit,
    source: input.source ?? "manual",
    ...(input.transferCostMinor === undefined
      ? {}
      : { transferCostMinor: input.transferCostMinor }),
    ...(input.transferId === undefined ? {} : { transferId: input.transferId }),
    units: input.units,
  };
}

/** Whether this kind is one half of a traspaso (#1393). */
export function isTransferKind(kind: OperationKind): boolean {
  return kind === "transfer_out" || kind === "transfer_in";
}

/**
 * The row-level rules of a traspaso half (#1393). These are programmer errors, not
 * user-facing violations: the columns are never typed into a form — the write gate
 * that mints the pair fills them — so a row that breaks them is a bug upstream, and
 * throwing is what keeps a half-formed pair out of the ledger.
 *
 * What is NOT checked here: that the OTHER half exists, and that the two agree on
 * units and date. That is a two-row invariant and it belongs to the atomic write
 * gate (S2, #1479); a single-operation constructor cannot see the pair.
 */
function assertTransferColumns(input: CreateInvestmentOperationInput): void {
  if (isTransferKind(input.kind) && input.transferId === undefined) {
    throw new Error("A transfer operation must carry its transferId.");
  }

  if (!isTransferKind(input.kind) && input.transferId !== undefined) {
    throw new Error("Only a transfer operation may carry a transferId.");
  }

  if (input.kind === "transfer_in" && input.transferCostMinor === undefined) {
    throw new Error("A transfer_in must carry the inherited transferCostMinor.");
  }

  if (input.kind !== "transfer_in" && input.transferCostMinor !== undefined) {
    throw new Error("Only a transfer_in may carry a transferCostMinor.");
  }

  if (input.transferCostMinor !== undefined) {
    assertMinorInteger(input.transferCostMinor);

    if (input.transferCostMinor < 0) {
      throw new Error("An inherited transferCostMinor must not be negative.");
    }
  }

  // A commission has exactly ONE place to live in a traspaso: capitalized into the
  // destination's cost, on the `transfer_in`. The outgoing half realizes no P/L, so
  // a fee there would have nowhere to go in the position fold while the cashflow
  // folds would still net it — the same money with two answers.
  if (input.kind === "transfer_out" && (input.feesMinor ?? 0) !== 0) {
    throw new Error(
      "A transfer_out carries no fees; charge the transfer commission to the transfer_in.",
    );
  }
}

/**
 * Who may state a cost grade (#1505): only the synthetic apertura, the one row
 * whose price is not its own fact. A programmer error, not a user-facing
 * violation — no form posts this column; the alta door fills it — so throwing is
 * what keeps a mislabelled row out of the ledger, exactly as for the traspaso
 * columns.
 *
 * A real buy or a statement order needs no grade: its price IS what was paid, and
 * marking it `declared_cost` would quietly downgrade an observed movement to a
 * declaration.
 */
function assertCostBasisGrade(input: CreateInvestmentOperationInput): void {
  if (input.costBasisGrade !== undefined && input.source !== "opening") {
    throw new Error("Only an opening operation may carry a costBasisGrade.");
  }
}

/**
 * Safe variant of `createInvestmentOperation`: returns a `DomainResult` instead
 * of throwing when operation bound rules are violated.
 * The three rule violations (units not positive, price negative, fees negative)
 * become data with stable machine-readable codes. Programmer errors still throw —
 * non-integer fees, and the traspaso column rules, which no form can produce.
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
    value: createInvestmentOperation(input),
  };
}

/**
 * The position-math module. Folds an investment asset's operation ledger into its
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
  let realizedMinor = 0;
  const warnings: PositionWarning[] = [];
  // How honest the cost accumulated so far is (#1505). It is folded ALONGSIDE
  // `costMinor` rather than scanned off the ledger, because a moving average has
  // no memory of which row a euro came from: once an un-declared cost enters the
  // pot every unit's average is tainted, and it stops being tainted only when the
  // pot itself empties — which is exactly what the units-to-zero reset below says.
  let costGrade: CostBasisGrade | undefined;

  // The invariant this fold rests on, checked instead of assumed (#1401): ONE
  // accumulator summed and labelled `options.currency` is only honest while every
  // operation is in that currency. Eight USD purchases summed as euros inflated a
  // cost basis by 17,7 % in total silence; the arithmetic below is unchanged, but it
  // no longer keeps quiet about it. It rides its OWN field rather than `warnings`,
  // whose single consumer reads any entry as an over-sell. Writes convert at capture
  // (`convertOperationToBaseCurrency`) so the state cannot be created any more —
  // this catches what an older path already wrote.
  const currencyWarning = mixedCurrencyWarning(operations, options.currency);

  const ordered = [...operations].sort(compareInvestmentOperations);

  for (const operation of ordered) {
    switch (operation.kind) {
      case "buy": {
        costMinor +=
          multiplyToMinor(operation.units, operation.pricePerUnit) + operation.feesMinor;
        costGrade = worseCostBasisGrade(costGrade, operation.costBasisGrade);
        units = addUnits(units, operation.units);
        break;
      }

      case "transfer_in": {
        // The incoming half of a traspaso (#1393). The cost basis is the one the
        // units carried over from the origin — NOT units × price, which would reset
        // the latent gain to zero and hand the destination a brand-new purchase it
        // never made. A row with no inherited cost is read as zero rather than
        // rejected: this fold's job is to read a ledger, and the gate that refuses
        // to WRITE such a row is `createInvestmentOperation`.
        //
        // Fees are capitalized exactly as on a buy, which is where a transfer
        // commission belongs: the outgoing half has no realized P/L to charge it
        // against.
        //
        // No cost grade is read here, because no `transfer_in` may carry one:
        // `assertCostBasisGrade` restricts the column to the synthetic apertura.
        // That is a SCOPE line, not an oversight — the alta por traspaso externo
        // (#1541) defaults its inherited cost to the importe that arrived when the
        // user does not declare one, which is the same «coste que nadie declaró»
        // by the sibling door, and marking it means going through the pair's own
        // atomic gate (#1479). See ADR 0097 for why #1505 stopped at the apertura.
        costMinor += (operation.transferCostMinor ?? 0) + operation.feesMinor;
        units = addUnits(units, operation.units);
        break;
      }

      case "sell":
      case "transfer_out": {
        // Both remove units and a proportional slice of cost basis at the running
        // weighted average, and neither moves the cost of what stays. They part ways
        // on P/L: a sell realizes it — proceeds (net of fees) minus the cost of the
        // units sold (#548) — and a traspaso realizes NOTHING (#1393). The capital
        // was not cashed in, it changed product; the gain travels with it as the
        // destination's inherited cost.
        const isTransfer = operation.kind === "transfer_out";
        let outgoingUnits = operation.units;

        if (compareUnits(outgoingUnits, units) > 0) {
          // Overrideable warning, not a failure: clamp to what's actually held so the
          // position never goes negative. Coded so the importer, ficha and hero can
          // tell an oversell from any future warning on this channel (#1443).
          warnings.push({
            code: isTransfer ? "OVER_TRANSFER" : "OVERSELL",
            message: isTransfer
              ? `El traspaso de ${outgoingUnits} unidades supera las ${units} disponibles; se ajusta al máximo.`
              : `La venta de ${outgoingUnits} unidades supera las ${units} disponibles; se ajusta al máximo.`,
          });
          outgoingUnits = units;
        }

        const costOfUnitsOut = proportionMinor(costMinor, outgoingUnits, units);

        if (!isTransfer) {
          const proceedsMinor =
            multiplyToMinor(outgoingUnits, operation.pricePerUnit) - operation.feesMinor;
          realizedMinor += proceedsMinor - costOfUnitsOut;
        }

        costMinor -= costOfUnitsOut;
        units = subtractUnits(units, outgoingUnits);
        if (compareUnits(units, "0") === 0) {
          // Nothing is held any more, so nothing is measured against the old cost:
          // the position that comes back from here is whatever is bought next. A
          // grade that survived this would mark a brand-new purchase «sin coste
          // real» forever.
          costGrade = undefined;
        }
        break;
      }

      default:
        // A fifth kind must say what it does to a position here before it compiles —
        // the whole reason a traspaso got its own kinds instead of a flag (#1393).
        return unhandledOperationKind(operation.kind);
    }
  }

  const summary: PositionSummary = {
    assetId: options.assetId,
    averageUnitCost: averageUnitCost(costMinor, units),
    costBasis: money(costMinor, options.currency),
    ...(costGrade === undefined ? {} : { costBasisGrade: costGrade }),
    ...(currencyWarning === null ? {} : { currencyWarning }),
    currency: options.currency,
    currentUnits: units,
    realizedPnl: money(realizedMinor, options.currency),
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

/**
 * Net units still held after folding a holding's buy/sell ledger — the units half
 * of {@link derivePosition}, for callers that only need "is anything still held?"
 * and have no currency in hand (#1348, the closed-position warning filter).
 */
export function netUnitsFromOperations(
  operations: readonly InvestmentOperation[],
): DecimalString {
  const [first] = operations;

  if (first === undefined) {
    return "0";
  }

  // Every operation of a holding shares its id and currency, so `first` names
  // both. Going through `derivePosition` (whose money output this caller
  // discards) keeps ONE ledger fold — and one over-sell clamp — instead of a
  // units-only copy that could drift from it.
  return derivePosition([...operations], {
    assetId: first.assetId,
    currency: first.currency,
  }).currentUnits;
}

/**
 * Net units held per holding, folded from a whole-ledger operations map (#1348).
 *
 * Holdings with no recorded operation are LEFT OUT: for the warnings engine an
 * absent entry means "open / unstarted", which is the right reading for a
 * freshly created investment — only a holding that has operations and nets to
 * ~0 is a closed position.
 */
export function netUnitsByAsset(
  operationsByAsset: ReadonlyMap<string, readonly InvestmentOperation[]>,
): Map<string, DecimalString> {
  const netUnits = new Map<string, DecimalString>();

  for (const [assetId, operations] of operationsByAsset) {
    if (operations.length === 0) {
      continue;
    }
    netUnits.set(assetId, netUnitsFromOperations(operations));
  }

  return netUnits;
}

/** True when the fold clamped a sell or a traspaso past what was held (#1443). */
export function hasOversellPositionWarning(
  warnings: readonly PositionWarning[],
): boolean {
  return warnings.some(
    (warning) => warning.code === "OVERSELL" || warning.code === "OVER_TRANSFER",
  );
}

/**
 * The position an investment held ON a date, or `undefined` when it held none —
 * either the ledger had not started yet or everything was sold by then.
 *
 * THE single test for "did this asset exist on that date". Both monthly grids ride
 * it — the price backfill's plan (ADR 0033) and the historical backfill's monthly
 * floor (#1444) — so the two can never disagree about which months exist. A
 * clamped oversell leaves non-zero units and still counts as held; zero does not.
 */
export function positionHeldAt(
  operations: readonly InvestmentOperation[],
  dateKey: string,
): PositionSummary | undefined {
  const opsUpTo = operationsUpTo(operations, dateKey);
  if (opsUpTo.length === 0) return undefined;

  const first = operations[0]!;
  const position = derivePosition(opsUpTo, {
    assetId: first.assetId,
    currency: first.currency,
  });
  return compareUnits(position.currentUnits, "0") === 0 ? undefined : position;
}

/** The earliest date the ledger touches (YYYY-MM-DD), or undefined when empty. */
export function earliestOperationDate(
  operations: readonly InvestmentOperation[],
): string | undefined {
  let earliest: string | undefined;
  for (const operation of operations) {
    const dateKey = operation.executedAt.slice(0, 10);
    if (earliest === undefined || dateKey < earliest) earliest = dateKey;
  }
  return earliest;
}
