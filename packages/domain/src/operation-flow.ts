import { multiplyToMinor } from "./decimal";
import type { InvestmentOperation, OperationKind } from "./investment-types";

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
 * The importe of one apunte, as the operations ledger prints it (#1827): the money
 * the operation moved, unsigned, in minor units of the operation's own currency.
 *
 * - What came IN — a buy, and the incoming half of a traspaso — cost units × price
 *   PLUS its fees, which are capitalized into it (the traspaso's commission lives on
 *   the `transfer_in`, #1393).
 * - What went OUT — a sell — brought back units × price LESS its fees, netted off the
 *   proceeds. The outgoing half of a traspaso is units × price: it carries no fees,
 *   because the pair's commission has exactly one home, the `transfer_in` (ADR 0082).
 *
 * The product goes through big.js and rounds half up to the céntimo; never a `Number`
 * multiplication in a view. The direction is the kind's to say, so the figure is a
 * magnitude — except for a sell whose fees exceed what it brought in, which comes out
 * negative because that is what it was: a sale that cost money.
 *
 * {@link signedInvestedMinor} is this figure with its sign, so the ledger's row and
 * the IRR's cashflow for the same apunte cannot disagree.
 */
export function operationAmountMinor(
  operation: Pick<InvestmentOperation, "feesMinor" | "kind" | "pricePerUnit" | "units">,
): number {
  return operationAmountFromGrossMinor({
    feesMinor: operation.feesMinor,
    grossMinor: multiplyToMinor(operation.units, operation.pricePerUnit),
    kind: operation.kind,
  });
}

/**
 * Which way a kind's fees move its importe, and the one table that says it (#1836):
 * capitalized (+1) on what came IN, netted off (−1) on what went OUT. Both
 * directions of the importe ↔ gross conversion read it, so the assistant's
 * operation lane and the ledger cannot apply different rules to the same sale.
 */
function feeSign(kind: OperationKind): 1 | -1 {
  switch (kind) {
    case "buy":
    case "transfer_in":
      return 1;
    case "sell":
    case "transfer_out":
      return -1;
    default:
      return unhandledOperationKind(kind);
  }
}

/**
 * The importe of an operation from its gross (units × price, in minor units): the
 * gross PLUS the fees on the way in, LESS the fees on the way out. The arithmetic
 * of {@link operationAmountMinor}, for a caller that already holds the gross.
 */
export function operationAmountFromGrossMinor(input: {
  kind: OperationKind;
  grossMinor: number;
  feesMinor: number;
}): number {
  return input.grossMinor + feeSign(input.kind) * input.feesMinor;
}

/**
 * The inverse (#1836): the gross (units × price) an operation of this importe and
 * these fees moved. A sale that brought 995 € back with 5 € of fees sold 1.000 € at
 * market; a buy that cost 1.005 € with the same fees bought 1.000 €. Whoever derives
 * a price or a number of units from a declared importe goes through here, never
 * through its own `importe − comisión`.
 */
export function operationGrossFromAmountMinor(input: {
  kind: OperationKind;
  amountMinor: number;
  feesMinor: number;
}): number {
  return input.amountMinor - feeSign(input.kind) * input.feesMinor;
}

/**
 * Which way each kind moves the holder's money — in (+1) or back out (−1) — and
 * whether it is a half of a traspaso, which the `zero` policy leaves out. A fifth
 * kind stops compiling here until it says both (`satisfies`).
 */
const INVESTED_FLOW = {
  buy: { sign: 1, transfer: false },
  sell: { sign: -1, transfer: false },
  transfer_in: { sign: 1, transfer: true },
  transfer_out: { sign: -1, transfer: true },
} as const satisfies Record<OperationKind, { sign: 1 | -1; transfer: boolean }>;

/**
 * Positive = money the holder put IN (a buy, and — under `flow` — the incoming half
 * of a traspaso). Negative = money that came back OUT (a sell, and the outgoing
 * half). Fees are capitalized on the way in and netted off on the way out, exactly
 * as they always were: the magnitude is {@link operationAmountMinor}, the sign is
 * the kind's ({@link INVESTED_FLOW}).
 */
export function signedInvestedMinor(
  operation: InvestmentOperation,
  transferPolicy: TransferFlowPolicy,
): number {
  const flow = INVESTED_FLOW[operation.kind];
  if (flow.transfer && transferPolicy === "zero") return 0;
  return flow.sign * operationAmountMinor(operation);
}

/**
 * The exhaustiveness backstop of every fold over `OperationKind`: a fifth kind stops
 * compiling here until each fold says what it does with it — the whole reason the
 * traspaso got its own kinds instead of a flag on `sell` (#1393, ADR 0082).
 */
export function unhandledOperationKind(kind: never): never {
  throw new Error(`Unhandled operation kind: ${String(kind)}`);
}
