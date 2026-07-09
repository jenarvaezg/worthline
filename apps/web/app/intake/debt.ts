import { parseIsoDateField, parsePercentToDecimal } from "@web/intake-primitives";
import type {
  AddBalanceAnchorInput,
  AddEarlyRepaymentInput,
  AddInterestRateRevisionInput,
  CreateAmortizationPlanInput,
} from "@worthline/db";
import type {
  CreateLiabilityInput,
  DebtModel,
  Member,
  ValuationCadence,
} from "@worthline/domain";
import { parseDecimalStrict } from "@worthline/domain";
import {
  createStableId,
  parseMoneyMinorField,
  parseOwnership,
  type StrictParseResult,
} from "./shared";

/**
 * Debt / liability intake parsers (#241 stage 2). Turns the «añadir deuda» and
 * mortgage-model forms (plan, rate revision, balance anchor, early repayment)
 * into validated domain command objects. Pure and framework-agnostic.
 */

export function parseLiabilityCommand(
  formData: FormData,
  members: Member[],
  seed: number,
): CreateLiabilityInput {
  const name = String(formData.get("name") ?? "").trim() || "Deuda";
  const associatedAssetId = String(formData.get("associatedAssetId") ?? "");

  return {
    balanceMinor: parseMoneyMinorField(formData, "balance") ?? 0,
    currency: "EUR",
    id: createStableId("debt", name, seed),
    name,
    ownership: parseOwnership(formData, members),
    type: formData.get("type") === "debt" ? "debt" : "mortgage",
    ...(associatedAssetId ? { associatedAssetId } : {}),
  };
}

/** Result of parsing the debt-model selector: ok with the model (or null = clear). */
export type DebtModelResult =
  | { ok: true; model: DebtModel | null }
  | { ok: false; error: string };

/**
 * Strict debt-model parser (PRD #109, slice 10). The «modelo de deuda» selector
 * posts one of the three known models, or an empty value to clear it (null = no
 * model). Anything else is rejected. The caller redirects on error.
 */
export function parseDebtModelStrict(formData: FormData): DebtModelResult {
  const raw = String(formData.get("debtModel") ?? "").trim();

  if (!raw) {
    return { ok: true, model: null };
  }

  if (raw === "amortizable" || raw === "revolving" || raw === "informal") {
    return { ok: true, model: raw };
  }

  return { ok: false, error: "El modelo de deuda no es válido." };
}

/** Result of parsing the valuation-cadence selector (ADR 0031). */
export type ValuationCadenceResult =
  | { ok: true; cadence: ValuationCadence }
  | { ok: false; error: string };

/**
 * Strict valuation-cadence parser (ADR 0031, #393). The «cadencia de valoración»
 * advanced selector posts one of the two known cadences. Anything else (including
 * an empty value) is rejected — the control always submits an explicit choice and
 * the stored default is `step`. The caller redirects on error.
 */
export function parseValuationCadenceStrict(formData: FormData): ValuationCadenceResult {
  const raw = String(formData.get("cadence") ?? "").trim();

  if (raw === "step" || raw === "interpolated") {
    return { ok: true, cadence: raw };
  }

  return { ok: false, error: "La cadencia de valoración no es válida." };
}

/**
 * Strict amortization-plan parser (PRD #109, slice 10; two dates ADR 0019, #189).
 * Builds a CreateAmortizationPlanInput from the plan form. Validates server-side:
 * a positive initial capital (EUR → minor), a non-negative annual interest rate
 * (% → decimal string), a positive whole-month term, a present, ISO, non-future
 * disbursement date (a future disbursement would generate no history), and a
 * present, ISO first-payment date on or after the disbursement. The caller
 * redirects on error.
 */
export function parseAmortizationPlanStrict(
  formData: FormData,
  liabilityId: string,
  seed: number,
  today: string,
): StrictParseResult<CreateAmortizationPlanInput> {
  const initialCapitalMinor = parseMoneyMinorField(formData, "initialCapital");

  if (initialCapitalMinor === null || initialCapitalMinor <= 0) {
    return { ok: false, error: "El capital inicial debe ser un número positivo." };
  }

  const rate = parsePercentToDecimal(String(formData.get("annualInterestRate") ?? ""));

  if (rate === null) {
    return { ok: false, error: "El tipo de interés anual no es válido." };
  }

  const termMonths = parseDecimalStrict(String(formData.get("termMonths") ?? ""));

  if (termMonths === null || !Number.isInteger(termMonths) || termMonths <= 0) {
    return {
      ok: false,
      error: "El plazo debe ser un número entero de meses mayor que cero.",
    };
  }

  const disbursementDate = String(formData.get("disbursementDate") ?? "").trim();

  if (!disbursementDate) {
    return { ok: false, error: "La fecha de firma es obligatoria." };
  }

  const disbursement = parseIsoDateField(disbursementDate, {
    invalidMessage: "La fecha de firma no es válida.",
    rejectFuture: true,
    today,
    futureMessage: "La fecha de firma no puede ser futura.",
  });

  if (!disbursement.ok) {
    return { ok: false, error: disbursement.error };
  }

  const firstPaymentDate = String(formData.get("firstPaymentDate") ?? "").trim();

  if (!firstPaymentDate) {
    return { ok: false, error: "La fecha del primer pago es obligatoria." };
  }

  const firstPayment = parseIsoDateField(firstPaymentDate, {
    invalidMessage: "La fecha del primer pago no es válida.",
    rejectFuture: false,
  });

  if (!firstPayment.ok) {
    return { ok: false, error: firstPayment.error };
  }

  if (firstPaymentDate < disbursementDate) {
    return {
      ok: false,
      error: "El primer pago no puede ser anterior a la fecha de firma.",
    };
  }

  // Two-date model (ADR 0019, #189): the form captures both dates explicitly.
  // The disbursement is when the debt exists at its initial capital; the
  // first-payment day-of-month anchors the schedule. The suggestion that
  // pre-fills the first payment is a client-side default the user may override,
  // so it is never re-derived here — whatever the form submits is the model.
  return {
    ok: true,
    command: {
      annualInterestRate: rate,
      disbursementDate,
      firstPaymentDate,
      id: createStableId("plan", liabilityId, seed),
      initialCapitalMinor,
      liabilityId,
      termMonths,
    },
  };
}

/**
 * Strict interest-rate-revision parser (PRD #109, slice 10). Builds an
 * AddInterestRateRevisionInput from the revision form: a present, ISO,
 * non-future date and a non-negative annual rate (% → decimal string). The
 * caller redirects on error.
 */
export function parseInterestRateRevisionStrict(
  formData: FormData,
  planId: string,
  seed: number,
  today: string,
): StrictParseResult<AddInterestRateRevisionInput> {
  const revisionDate = String(formData.get("revisionDate") ?? "").trim();

  if (!revisionDate) {
    return { ok: false, error: "La fecha de la revisión es obligatoria." };
  }

  const validated = parseIsoDateField(revisionDate, {
    invalidMessage: "La fecha de la revisión no es válida.",
    rejectFuture: true,
    today,
    futureMessage: "La fecha no puede ser futura.",
  });

  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }

  const rate = parsePercentToDecimal(String(formData.get("newAnnualInterestRate") ?? ""));

  if (rate === null) {
    return { ok: false, error: "El nuevo tipo de interés no es válido." };
  }

  return {
    ok: true,
    command: {
      id: createStableId("rev", planId, seed),
      newAnnualInterestRate: rate,
      planId,
      revisionDate,
    },
  };
}

/**
 * Strict balance-anchor parser (PRD #109, slice 10). Builds an
 * AddBalanceAnchorInput for a revolving/informal debt: a present, ISO,
 * non-future date and a positive total balance (EUR → minor, interest already
 * included — there is no separate flag, slice #117 decision). The caller
 * redirects on error.
 */
export function parseBalanceAnchorStrict(
  formData: FormData,
  liabilityId: string,
  seed: number,
  today: string,
): StrictParseResult<AddBalanceAnchorInput> {
  const anchorDate = String(formData.get("anchorDate") ?? "").trim();

  if (!anchorDate) {
    return { ok: false, error: "La fecha del saldo es obligatoria." };
  }

  const validated = parseIsoDateField(anchorDate, {
    invalidMessage: "La fecha del saldo no es válida.",
    rejectFuture: true,
    today,
    futureMessage: "La fecha no puede ser futura.",
  });

  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }

  const balanceMinor = parseMoneyMinorField(formData, "balance");

  if (balanceMinor === null || balanceMinor <= 0) {
    return { ok: false, error: "El saldo debe ser un número positivo." };
  }

  return {
    ok: true,
    command: {
      anchorDate,
      balanceMinor,
      id: createStableId("banchor", liabilityId, seed),
      liabilityId,
    },
  };
}

/**
 * Strict early-repayment parser (PRD #146, slice S4). Builds an
 * AddEarlyRepaymentInput: a present, ISO, non-future date, a positive amount
 * (EUR → minor), and a mode — reduce-payment keeps the term and lowers the
 * cuota, reduce-term keeps the cuota and shortens the term. The caller redirects
 * on error.
 */
export function parseEarlyRepaymentStrict(
  formData: FormData,
  planId: string,
  seed: number,
  today: string,
): StrictParseResult<AddEarlyRepaymentInput> {
  const repaymentDate = String(formData.get("repaymentDate") ?? "").trim();

  if (!repaymentDate) {
    return { ok: false, error: "La fecha de la amortización es obligatoria." };
  }

  const validated = parseIsoDateField(repaymentDate, {
    invalidMessage: "La fecha de la amortización no es válida.",
    rejectFuture: true,
    today,
    futureMessage: "La fecha no puede ser futura.",
  });

  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }

  const amountMinor = parseMoneyMinorField(formData, "amount");

  if (amountMinor === null || amountMinor <= 0) {
    return { ok: false, error: "El importe debe ser un número positivo." };
  }

  const mode = String(formData.get("mode") ?? "").trim();

  if (mode !== "reduce-payment" && mode !== "reduce-term") {
    return { ok: false, error: "El tipo de amortización no es válido." };
  }

  return {
    ok: true,
    command: {
      amountMinor,
      id: createStableId("erp", planId, seed),
      mode,
      planId,
      repaymentDate,
    },
  };
}
