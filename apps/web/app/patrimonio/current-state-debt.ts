import { parsePercentToDecimal } from "@web/intake-primitives";
import type { AmortizationPlanInput, DecimalString } from "@worthline/domain";
import {
  deriveCurrentStateAmortizationPlan,
  formatMoneyInput,
  parseDecimalToMinorStrict,
  remainingMonthlyPayments,
} from "@worthline/domain";

/**
 * Pure "alta por estado actual" derivation (ADR 0056, PRD #670 S2, #677).
 *
 * The shared seam between the live honesty-check client island and the server
 * action's validation — ONE source of truth for "is this current-state debt
 * declaration valid, and what does it derive to", so the preview a user sees
 * before saving is exactly what gets persisted. No I/O; the domain engine
 * (`deriveCurrentStateAmortizationPlan`) is the sole authority on the math —
 * this module only parses es-ES form strings into its inputs and translates its
 * failure modes into Spanish, user-facing messages (interaction-patterns §7).
 * It also owns the optional original-signing-date validation, so both the
 * wizard and the advanced edit surface reject a malformed/future date BEFORE
 * anything is persisted, instead of each call site re-deriving the check.
 */

export type CurrentStateInputMode = "rate" | "payment";

/**
 * The `name` attribute of every current-state debt field, as posted by
 * `CurrentStateDebtFields` — the ONE list both server actions preserve on a
 * validation-error redisplay (`preserveFields`) and the wizard's field
 * allowlist (`SIMPLE_FIELD_KEYS`), so all three never drift from what that
 * component actually renders.
 */
export const CURRENT_STATE_DEBT_FIELD_NAMES = [
  "csOutstandingBalance",
  "csEndDate",
  "csNextPaymentDate",
  "csInputMode",
  "csAnnualRate",
  "csMonthlyPayment",
  "csOriginalSigningDate",
] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Raw (unparsed) es-ES form strings for the current-state debt fields. */
export interface CurrentStateDebtRawInput {
  /** Saldo pendiente hoy, es-ES money string (e.g. "118.000,00"). */
  outstandingBalance: string;
  /** "Hoy" — the re-baseline date, YYYY-MM-DD. */
  baselineDate: string;
  /** Fecha de fin, YYYY-MM-DD. */
  endDate: string;
  /** Próxima fecha de cuota, YYYY-MM-DD. */
  nextPaymentDate: string;
  /** Which field the bank gave the user: the rate, or the payment. */
  inputMode: CurrentStateInputMode;
  /** Tipo anual actual, es-ES percent string (e.g. "2,35"), read when inputMode is "rate". */
  annualRatePercent: string;
  /** Cuota mensual actual, es-ES money string, read when inputMode is "payment". */
  monthlyPayment: string;
  /** Optional descriptive metadata, YYYY-MM-DD; never fed into the derivation. */
  originalSigningDate?: string;
}

export interface CurrentStateDebtDerived {
  outstandingBalanceMinor: number;
  /** Remaining cuotas from the next payment through the end date, inclusive. */
  months: number;
  annualInterestRate: DecimalString;
  monthlyPaymentMinor: number;
  /** The exact plan the S1 engine derived — persist this, never re-assembled by hand. */
  plan: AmortizationPlanInput;
}

export type CurrentStateDebtResult =
  | ({ ok: true } & CurrentStateDebtDerived)
  | { ok: false; error: string };

function isInputModeValid(mode: CurrentStateInputMode): boolean {
  return mode === "rate" || mode === "payment";
}

/**
 * Derive a current-state amortization declaration, or a Spanish error. Both the
 * live honesty check and the save action call this with the same raw input.
 */
export function deriveCurrentStateDebt(
  raw: CurrentStateDebtRawInput,
): CurrentStateDebtResult {
  if (!isInputModeValid(raw.inputMode)) {
    return { ok: false, error: "Elige si tienes el tipo anual o la cuota mensual." };
  }

  const outstandingBalanceMinor = parseDecimalToMinorStrict(raw.outstandingBalance);
  if (outstandingBalanceMinor === null || outstandingBalanceMinor <= 0) {
    return { ok: false, error: "Introduce un saldo pendiente mayor que 0 €." };
  }

  if (!ISO_DATE.test(raw.endDate)) {
    return { ok: false, error: "La fecha de fin no es válida." };
  }
  if (!ISO_DATE.test(raw.nextPaymentDate)) {
    return { ok: false, error: "La fecha de la próxima cuota no es válida." };
  }
  if (raw.nextPaymentDate < raw.baselineDate) {
    return { ok: false, error: "La próxima cuota no puede ser anterior a hoy." };
  }
  if (raw.endDate < raw.nextPaymentDate) {
    return {
      ok: false,
      error: "La fecha de fin no puede ser anterior a la próxima cuota.",
    };
  }

  const signingDate = raw.originalSigningDate?.trim();
  if (signingDate) {
    if (!ISO_DATE.test(signingDate)) {
      return { ok: false, error: "La fecha de firma original no es válida." };
    }
    if (signingDate > raw.baselineDate) {
      return { ok: false, error: "La fecha de firma original no puede ser futura." };
    }
  }

  const months = remainingMonthlyPayments({
    endDate: raw.endDate,
    nextPaymentDate: raw.nextPaymentDate,
  });
  if (months <= 0) {
    return { ok: false, error: "La fecha de fin tiene que ser posterior a hoy." };
  }

  if (raw.inputMode === "rate") {
    const rate = parsePercentToDecimal(raw.annualRatePercent);
    if (rate === null) {
      return { ok: false, error: "Introduce un tipo anual igual o mayor que 0 %." };
    }

    try {
      const derivation = deriveCurrentStateAmortizationPlan({
        annualInterestRate: rate,
        baselineDate: raw.baselineDate,
        endDate: raw.endDate,
        nextPaymentDate: raw.nextPaymentDate,
        outstandingBalanceMinor,
      });
      return {
        annualInterestRate: derivation.annualInterestRate,
        monthlyPaymentMinor: derivation.monthlyPaymentMinor,
        months,
        ok: true,
        outstandingBalanceMinor,
        plan: derivation.plan,
      };
    } catch {
      return {
        ok: false,
        error: "Esos datos no permiten calcular la cuota. Revisa el tipo anual.",
      };
    }
  }

  const monthlyPaymentMinor = parseDecimalToMinorStrict(raw.monthlyPayment);
  if (monthlyPaymentMinor === null || monthlyPaymentMinor <= 0) {
    return { ok: false, error: "Introduce una cuota mensual mayor que 0 €." };
  }

  try {
    const derivation = deriveCurrentStateAmortizationPlan({
      baselineDate: raw.baselineDate,
      endDate: raw.endDate,
      monthlyPaymentMinor,
      nextPaymentDate: raw.nextPaymentDate,
      outstandingBalanceMinor,
    });
    return {
      annualInterestRate: derivation.annualInterestRate,
      monthlyPaymentMinor: derivation.monthlyPaymentMinor,
      months,
      ok: true,
      outstandingBalanceMinor,
      plan: derivation.plan,
    };
  } catch {
    // The domain solver is the sole authority on the feasibility boundary; this
    // only supplies a Spanish, user-friendly hint of the minimum cuota.
    const minimumPaymentMinor = Math.ceil(outstandingBalanceMinor / months);
    return {
      error: `Esa cuota no llega a amortizar el saldo antes de la fecha de fin. Mínimo: ${formatMoneyInput(minimumPaymentMinor)} €/mes.`,
      ok: false,
    };
  }
}
