import type { InvestmentOperation } from "./investment-types";
import { operationAmountMinor } from "./operation-flow";

/**
 * The money a **buy** took out of pocket: units × price **plus** fees, in minor
 * units of the operation's own currency.
 *
 * One definition, because three surfaces print it about the same purchase: the
 * contribution reconciliation's "executed" amount for an occurrence, the annual
 * allowance counter's consumed total (#1427), and the operations ledger's importe
 * (#1827). Two spellings of the same arithmetic is how a screen ends up disagreeing
 * with itself over one buy, so this is the ledger's {@link operationAmountMinor}
 * read as a buy.
 */
export function buyCashOutMinor(
  operation: Pick<InvestmentOperation, "units" | "pricePerUnit" | "feesMinor">,
): number {
  return operationAmountMinor({ ...operation, kind: "buy" });
}
