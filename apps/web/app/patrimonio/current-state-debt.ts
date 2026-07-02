import type { DecimalString } from "@worthline/domain";
import {
  deriveCurrentStateAmortizationPlan,
  formatMoneyInput,
  parseDecimalStrict,
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
 */

export type CurrentStateInputMode = "rate" | "payment";

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
}

export interface CurrentStateDebtDerived {
  outstandingBalanceMinor: number;
  /** Remaining cuotas from the next payment through the end date, inclusive. */
  months: number;
  annualInterestRate: DecimalString;
  monthlyPaymentMinor: number;
}

export type CurrentStateDebtResult =
  | ({ ok: true } & CurrentStateDebtDerived)
  | { ok: false; error: string };

function isInputModeValid(mode: CurrentStateInputMode): boolean {
  return mode === "rate" || mode === "payment";
}

/** Es-ES decimal → the `DecimalString` an annual rate of X % is stored as. */
function percentToDecimalString(pct: number): DecimalString {
  const decimal = pct / 100;
  return (
    Number.isInteger(decimal) ? String(decimal) : decimal.toString()
  ) as DecimalString;
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

  const months = remainingMonthlyPayments({
    endDate: raw.endDate,
    nextPaymentDate: raw.nextPaymentDate,
  });
  if (months <= 0) {
    return { ok: false, error: "La fecha de fin tiene que ser posterior a hoy." };
  }

  if (raw.inputMode === "rate") {
    const pct = parseDecimalStrict(raw.annualRatePercent);
    if (pct === null || pct < 0) {
      return { ok: false, error: "Introduce un tipo anual igual o mayor que 0 %." };
    }

    try {
      const derivation = deriveCurrentStateAmortizationPlan({
        annualInterestRate: percentToDecimalString(pct),
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
