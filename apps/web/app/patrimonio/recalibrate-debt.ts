import type { DecimalString, EffectiveAmortizationPlan } from "@worthline/domain";
import { addMonths, parseDecimalToMinorStrict } from "@worthline/domain";

import { parseIsoDateField } from "@web/intake-primitives";

/**
 * Pure "recalibrar con saldo real" derivation (ADR 0056, PRD #670 S3, #678).
 *
 * The drift repair for an EXISTING amortizable debt: the user declares the real
 * outstanding balance at a date, and the schedule re-derives forward from a fresh
 * balance re-baseline — the SAME dated-fact kind create-time uses (S1/S2), but
 * with `startsAtBaseline: false` here: it corrects an already-running curve, it
 * does not redefine the debt's own unmodelled-past origin.
 *
 * Unlike "alta por estado actual" (S1/S2's `current-state-debt.ts`), the debt
 * already has a plan/curve, so rate, end date and next-cuota date are NOT
 * re-entered — this form only asks for the two facts that changed: the real
 * balance and the date it applies. The rest composes forward from whichever
 * plan or prior re-baseline currently governs the chosen date
 * (`effectiveAmortizationPlan`, resolved by the caller from store reads),
 * folding in any interest-rate revisions on/before it. `addBalanceRebaselineAndRipple`
 * remains the sole persistence + ripple authority (ADR 0012); this module never
 * touches the store.
 */

export const RECALIBRATE_DEBT_FIELD_NAMES = [
  "rbOutstandingBalance",
  "rbBalanceDate",
] as const;

export interface RecalibrateDebtRawInput {
  /** Saldo real, es-ES money string (e.g. "118.000,00"). */
  outstandingBalance: string;
  /** Fecha del saldo — the new re-baseline date, YYYY-MM-DD, never future. */
  balanceDate: string;
  today: string;
}

export type RecalibrateDebtResult =
  | { ok: true; outstandingBalanceMinor: number; balanceDate: string }
  | { ok: false; error: string };

/** Validate the two user-typed fields — the only ones this form asks for. */
export function validateRecalibrateDebt(
  raw: RecalibrateDebtRawInput,
): RecalibrateDebtResult {
  const outstandingBalanceMinor = parseDecimalToMinorStrict(raw.outstandingBalance);
  if (outstandingBalanceMinor === null || outstandingBalanceMinor <= 0) {
    return { error: "Introduce un saldo real mayor que 0 €.", ok: false };
  }

  const date = parseIsoDateField(raw.balanceDate, {
    futureMessage: "La fecha del saldo no puede ser futura.",
    invalidMessage: "La fecha del saldo no es válida.",
    rejectFuture: true,
    today: raw.today,
  });
  if (!date.ok) {
    return { error: date.error, ok: false };
  }

  return { balanceDate: date.date, ok: true, outstandingBalanceMinor };
}

export interface RecalibrationRevision {
  revisionDate: string;
  newAnnualInterestRate: DecimalString;
}

export interface DerivedRecalibrationRebaseline {
  annualInterestRate: DecimalString;
  endDate: string;
  nextPaymentDate: string;
}

export type DeriveRecalibrationResult =
  | ({ ok: true } & DerivedRecalibrationRebaseline)
  | { ok: false; error: string };

const MAX_CUOTA_SEARCH_MONTHS = 1_200;

/**
 * The active annual rate at `balanceDate`: the latest revision on/before it
 * (and on/after the effective plan's own start) wins, else the base rate —
 * mirrors the precedence the amortization engine applies internally when
 * simulating a schedule with revisions.
 */
function activeAnnualRate(
  baseRate: DecimalString,
  effectiveFrom: string,
  revisions: readonly RecalibrationRevision[],
  balanceDate: string,
): DecimalString {
  let rate = baseRate;
  for (const revision of [...revisions].sort((a, b) =>
    a.revisionDate.localeCompare(b.revisionDate),
  )) {
    if (revision.revisionDate >= effectiveFrom && revision.revisionDate <= balanceDate) {
      rate = revision.newAnnualInterestRate;
    }
  }
  return rate;
}

/**
 * The smallest cuota date on `anchorDate`'s day-of-month cadence that falls
 * STRICTLY AFTER `balanceDate` — the "próxima fecha de cuota" the new
 * re-baseline anchors on, without asking the user to re-confirm it. Strict,
 * not on-or-after: `amortizationPlanFromBalanceRebaseline` treats the
 * re-baseline's `nextPaymentDate` as its schedule's first-payment date, and
 * `amortizableBalanceAtDate` reads a query landing exactly ON that date as
 * "the cuota already happened" — a re-baseline dated the SAME day as its own
 * next cuota would then read back short of the balance just declared.
 */
function nextCuotaAfter(anchorDate: string, balanceDate: string): string {
  let months = 0;
  let candidate = anchorDate;
  while (candidate <= balanceDate) {
    months += 1;
    if (months > MAX_CUOTA_SEARCH_MONTHS) {
      throw new Error("No se encontró una próxima cuota razonable.");
    }
    candidate = addMonths(anchorDate, months);
  }
  return candidate;
}

/**
 * Compose the re-baseline's derived fields (rate, end date, next cuota) from
 * whichever plan or prior re-baseline currently governs `balanceDate`. The
 * caller resolves `effective` with the domain's `effectiveAmortizationPlan`
 * (fed by store reads) and passes the result straight through — this function
 * stays I/O-free and independently testable.
 */
export function deriveRecalibrationRebaseline(input: {
  effective: EffectiveAmortizationPlan | { startsAfterTarget: true } | null;
  revisions: readonly RecalibrationRevision[];
  balanceDate: string;
}): DeriveRecalibrationResult {
  if (input.effective === null) {
    return {
      error: "Esta deuda no tiene un plan de amortización que recalibrar.",
      ok: false,
    };
  }
  if ("startsAfterTarget" in input.effective) {
    return {
      error: "La fecha del saldo no puede ser anterior al inicio de esta deuda.",
      ok: false,
    };
  }

  const { plan, effectiveFrom } = input.effective;

  // Symmetric guard for an origin-declared plan (#678 review): the
  // startsAfterTarget branch above only fires for a current-state debt's own
  // `startsAtBaseline` fact. A plan has no such fact, so without this check a
  // balance date before its disbursement would silently pass and ripple the
  // ENTIRE modelled history forward from a pre-origin date — ADR 0056 never
  // rewrites what came before.
  if (input.balanceDate < effectiveFrom) {
    return {
      error: "La fecha del saldo no puede ser anterior al inicio de esta deuda.",
      ok: false,
    };
  }

  return {
    annualInterestRate: activeAnnualRate(
      plan.annualInterestRate,
      effectiveFrom,
      input.revisions,
      input.balanceDate,
    ),
    endDate: addMonths(plan.firstPaymentDate, plan.termMonths - 1),
    nextPaymentDate: nextCuotaAfter(plan.firstPaymentDate, input.balanceDate),
    ok: true,
  };
}
