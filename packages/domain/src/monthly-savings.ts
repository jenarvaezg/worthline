import { multiplyToMinor } from "./decimal";
import type { InvestmentOperation } from "./investment-types";

/**
 * A suggested monthly savings capacity derived from real investment operations
 * (PRD #421, #425). It is a *default* the user can override in the FIRE config —
 * never a hard figure — so it is deliberately simple: net new money invested,
 * averaged over the calendar months the operations span.
 */
export interface MonthlySavingsSuggestion {
  /** Suggested monthly savings in minor units. Never negative — see `basis`. */
  amountMinor: number;
  /** Calendar months spanned by the operations used (≥ 1; 0 when there are none). */
  monthsCovered: number;
  /** `operations` when derived from history; `insufficient_data` when there is none. */
  basis: "operations" | "insufficient_data";
}

/** Months since year 0, so a difference is a calendar-month count. */
function monthIndex(isoDate: string): number {
  const [year, month] = isoDate.split("-");
  return Number(year) * 12 + (Number(month) - 1);
}

/**
 * Suggest a monthly savings capacity from a holding's (or the workspace's)
 * investment operations.
 *
 * Savings = money you directed into investments: a `buy` is cost out of pocket
 * (units × price + fees), a `sell` is money pulled back out (units × price −
 * fees). The net across the whole history, divided by the number of calendar
 * months it spans, is the average you actually saved per month. A net-negative
 * history (you withdrew more than you invested) floors at 0 — you are
 * dis-saving, and a negative *capacity* would be nonsense.
 *
 * Currency-agnostic by design: it sums minor amounts as given, so the caller is
 * responsible for passing operations in (or already converted to) one currency.
 * Worthline investment operations are overwhelmingly single-currency, and the
 * result is a soft, user-overridable default — not a reconciled figure.
 */
export function suggestMonthlySavingsCapacity(
  operations: InvestmentOperation[],
): MonthlySavingsSuggestion {
  if (operations.length === 0) {
    return { amountMinor: 0, monthsCovered: 0, basis: "insufficient_data" };
  }

  let netMinor = 0;
  let firstMonth = Infinity;
  let lastMonth = -Infinity;

  for (const operation of operations) {
    const grossMinor = multiplyToMinor(operation.units, operation.pricePerUnit);
    const signedMinor =
      operation.kind === "buy"
        ? grossMinor + operation.feesMinor
        : -(grossMinor - operation.feesMinor);
    netMinor += signedMinor;

    const month = monthIndex(operation.executedAt);
    firstMonth = Math.min(firstMonth, month);
    lastMonth = Math.max(lastMonth, month);
  }

  const monthsCovered = lastMonth - firstMonth + 1;
  const amountMinor = Math.max(0, Math.round(netMinor / monthsCovered));

  return { amountMinor, monthsCovered, basis: "operations" };
}
