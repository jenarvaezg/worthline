/**
 * How the debt ficha's surfaces say a rate, a cuota and a model (PRD #109, #1848).
 *
 * Shared by the header (`debt-family`) and the forms the old `DebtModelSection` was
 * split into, so a cuota reads the same in «Cuota vigente» and in «Cuotas».
 */

import type { DebtModel, EarlyRepaymentMode } from "@worthline/domain";
import { maskMoneyString } from "@worthline/domain";

/** Render a stored decimal rate ("0.025") back as the percent the user typed ("2.5"). */
export function rateToPercent(rate: string): string {
  const pct = Number(rate) * 100;

  return String(Math.round(pct * 1_000_000) / 1_000_000);
}

/**
 * Cents-precise es-ES euro display for a cuota. `formatMoneyMinor` drops the cents
 * (it is for whole-euro totals); a cuota is exact to the cent (ADR 0019), so the
 * stub-interest figure and the cuotas are shown with two decimals.
 */
export function formatEurCents(amountMinor: number): string {
  return new Intl.NumberFormat("es-ES", {
    currency: "EUR",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(amountMinor / 100);
}

/** {@link formatEurCents}, masked in privacy mode. */
export function formatEurCentsPrivacy(amountMinor: number, privacyMode: boolean): string {
  const formatted = formatEurCents(amountMinor);
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
