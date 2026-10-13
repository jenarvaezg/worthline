/**
 * How the debt ficha's surfaces say a cuota and a model (PRD #109, #1848). A rate is
 * the repo's percent voice: `formatDecimalAsPercentField` in a field,
 * `formatDeclaredRatePercent` on display.
 *
 * Shared by the header (`debt-family`) and the forms the old `DebtModelSection` was
 * split into, so a cuota reads the same in «Cuota vigente» and in «Cuotas».
 */

import type { DebtModel, EarlyRepaymentMode, MoneyMinor } from "@worthline/domain";
import { formatMoneyMinorExact, maskMoneyString } from "@worthline/domain";

/**
 * A cuota in the debt's own currency, to the cent, masked in privacy mode.
 * `formatMoneyMinor` drops the cents (it is for whole totals); a cuota is exact to
 * the cent (ADR 0019), so the stub-interest figure and the cuotas are shown with two
 * decimals (`formatMoneyMinorExact`).
 */
export function formatCuotaPrivacy(value: MoneyMinor, privacyMode: boolean): string {
  const formatted = formatMoneyMinorExact(value);
  return privacyMode ? maskMoneyString(formatted) : formatted;
}

export const DEBT_MODEL_LABELS: Record<DebtModel, string> = {
  amortizable: "Amortizable (préstamo francés)",
  informal: "Informal",
  revolving: "Revolving",
};

export const EARLY_REPAYMENT_MODE_LABELS: Record<EarlyRepaymentMode, string> = {
  "reduce-payment": "Reducir cuota",
  "reduce-term": "Reducir plazo",
};
