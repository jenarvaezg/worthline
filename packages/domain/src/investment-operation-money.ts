import { multiplyToMinor } from "./decimal";
import type { InvestmentOperation } from "./investment-types";

/**
 * The money a **buy** took out of pocket: units × price **plus** fees, in minor
 * units of the operation's own currency.
 *
 * One definition, because two surfaces print it about the same purchase: the
 * contribution reconciliation's "executed" amount for an occurrence, and the
 * annual allowance counter's consumed total (#1427). Two spellings of the same
 * arithmetic is how a screen ends up disagreeing with itself over one buy.
 */
export function buyCashOutMinor(
  operation: Pick<InvestmentOperation, "units" | "pricePerUnit" | "feesMinor">,
): number {
  return multiplyToMinor(operation.units, operation.pricePerUnit) + operation.feesMinor;
}
