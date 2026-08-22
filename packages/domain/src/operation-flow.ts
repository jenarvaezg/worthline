import { multiplyToMinor } from "./decimal";
import type { InvestmentOperation } from "./investment-types";

/**
 * The signed money one operation moved, and the one place the sign of a ledger kind
 * is spelled out.
 *
 * Three folds used to spell this arithmetic themselves — the IRR's cashflows, the
 * delta breakdown's net operations, and the measured savings — with the sell/buy
 * expressions copied verbatim and negated in one of them. The traspaso is what made
 * that untenable: each of the three wants a DIFFERENT answer for it, and three
 * hand-written switches would drift the moment a fifth kind appears.
 */

/**
 * What a fold does with the halves of a traspaso (#1393). Never defaulted: the two
 * answers are both right, for different questions, so a caller that has not chosen
 * has not thought about it.
 *
 * - `flow`: the traspaso is money leaving one holding and arriving at another, on
 *   that date at that date's market value. The right reading whenever the figure is
 *   about ONE holding's capital — the IRR of a position, the attribution of a
 *   holding's value change. The pair cancels itself over any scope holding both.
 * - `zero`: the traspaso is invisible. The right reading whenever the figure is
 *   about money that came from OUTSIDE the portfolio — savings, contributions — for
 *   which a traspaso is a non-event however it is dated.
 */
export type TransferFlowPolicy = "flow" | "zero";

/**
 * A position the user is **declaring**, not money they put in that day
 * (#1490, #1567).
 *
 * `source: "opening"` is the mark both alta doors stamp on «sé cuánto tengo hoy»:
 * the units were already theirs, and the date is the day they typed it. Counting
 * that row as a contribution — savings, cupo — invents a flow nobody made. Two
 * folds ask this question (`netInvestedMinor`, `computeContributionAllowanceUsage`);
 * one predicate, so a third cannot "fix" one and miss the other.
 */
export function isDeclaredOpening(
  operation: Pick<InvestmentOperation, "source">,
): boolean {
  return operation.source === "opening";
}

/**
 * Positive = money the holder put IN (a buy, and — under `flow` — the incoming half
 * of a traspaso). Negative = money that came back OUT (a sell, and the outgoing
 * half). Fees are capitalized on the way in and netted off on the way out, exactly
 * as they always were.
 */
export function signedInvestedMinor(
  operation: InvestmentOperation,
  transferPolicy: TransferFlowPolicy,
): number {
  const grossMinor = multiplyToMinor(operation.units, operation.pricePerUnit);

  switch (operation.kind) {
    case "buy":
      return grossMinor + operation.feesMinor;
    case "sell":
      return -(grossMinor - operation.feesMinor);
    case "transfer_in":
      return transferPolicy === "zero" ? 0 : grossMinor + operation.feesMinor;
    case "transfer_out":
      return transferPolicy === "zero" ? 0 : -(grossMinor - operation.feesMinor);
    default:
      return unhandledOperationKind(operation.kind);
  }
}

/**
 * The exhaustiveness backstop of every fold over `OperationKind`: a fifth kind stops
 * compiling here until each fold says what it does with it — the whole reason the
 * traspaso got its own kinds instead of a flag on `sell` (#1393, ADR 0082).
 */
export function unhandledOperationKind(kind: never): never {
  throw new Error(`Unhandled operation kind: ${String(kind)}`);
}
