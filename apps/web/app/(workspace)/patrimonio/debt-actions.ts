"use server";

import { formAction } from "@web/form-action";
import {
  createStableId,
  errorRedirectUrl,
  parseAmortizationPlanStrict,
  parseDebtModelStrict,
  parseEarlyRepaymentStrict,
  parseInterestRateRevisionStrict,
  preserveFields,
  successRedirectUrl,
} from "@web/intake";
import { debtAccrualAtDate, effectiveAmortizationPlan } from "@worthline/domain";
import { baseUrl, findLiability, requireDebtModel } from "./action-helpers";
import { readAmortizableDebtCurveContext } from "./amortizable-debt-curve-context";
import {
  CURRENT_STATE_DEBT_FIELD_NAMES,
  deriveCurrentStateDebt,
} from "./current-state-debt";
import {
  BALANCE_HISTORY_MESSAGES,
  parseBalanceHistoryRows,
  planBalanceHistoryImport,
} from "./import-balance-history";
import {
  persistBalanceHistoryImport,
  readBalanceHistoryDebtContext,
} from "./persist-balance-history-import";
import { persistCurrentStateAmortization } from "./persist-current-state-debt";
import {
  deriveRecalibrationRebaseline,
  looksLikeSettlementAmount,
  RECALIBRATE_DEBT_FIELD_NAMES,
  validateRecalibrateDebt,
} from "./recalibrate-debt";

/**
 * Debt-model editing (PRD #109, slice 10): debt model, amortization plan, revisions
 * and balance anchors. Domain guard (R9) rides `requireDebtModel`; the seam then
 * ripples historical snapshots (#118 acceptance lives here).
 */

export async function setDebtModelAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    datedFact: false,
    missingId: "Identificador de deuda no encontrado.",
    parse: ({ formData }) => {
      const parsed = parseDebtModelStrict(formData);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(baseUrl(formData), {
            formId: "debtModel",
            message: parsed.error,
          }),
        };
      }
      return { ok: true, value: parsed.model };
    },
    run: async (store, { id, parsed: model }) => {
      const liability = await findLiability(store, id);
      if (!liability) {
        return { ok: false, error: "No se encontró la deuda." };
      }
      await store.liabilities.setDebtModel(id, model);
      return { ok: true };
    },
    onError: ({ error }) =>
      errorRedirectUrl(baseUrl(formData), { formId: "debtModel", message: error }),
    onSuccess: () => successRedirectUrl(baseUrl(formData), "debt_model_saved"),
  })(formData, ..._testArgs);
}

/**
 * "Alta por estado actual" on the advanced edit surface (ADR 0056, PRD #670 S2,
 * #677) — a liability's FIRST amortization plan, declared from what the user
 * owes today rather than the original conditions (ADR 0019's origin-declared
 * form stays untouched, offered alongside). Re-validates with the same pure
 * module the live honesty check renders (`current-state-debt.ts`), then
 * persists the derived plan row + the `startsAtBaseline` re-baseline together
 * (`persistCurrentStateAmortization`) — the #676 review's requirement that a
 * current-state debt never exists without a plan row for future revisions/
 * early repayments to hang off.
 */
export async function saveCurrentStateAmortizationAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const currentStateErrorUrl = (formData: FormData, message: string) =>
    errorRedirectUrl(baseUrl(formData), {
      formId: "currentStateDebt",
      message,
      values: preserveFields(formData, [...CURRENT_STATE_DEBT_FIELD_NAMES]),
    });

  return formAction<{
    derived: ReturnType<typeof deriveCurrentStateDebt> & { ok: true };
    endDate: string;
    inputMode: "payment" | "rate";
    nextPaymentDate: string;
    originalSigningDate: string;
  }>({
    datedFact: false,
    missingId: "Identificador de deuda no encontrado.",
    parse: ({ formData, id, today }) => {
      const inputMode = formData.get("csInputMode") === "payment" ? "payment" : "rate";
      const endDate = String(formData.get("csEndDate") ?? "").trim();
      const nextPaymentDate = String(formData.get("csNextPaymentDate") ?? "").trim();
      const originalSigningDate = String(
        formData.get("csOriginalSigningDate") ?? "",
      ).trim();

      const derived = deriveCurrentStateDebt({
        annualRatePercent: String(formData.get("csAnnualRate") ?? ""),
        baselineDate: today,
        endDate,
        inputMode,
        monthlyPayment: String(formData.get("csMonthlyPayment") ?? ""),
        nextPaymentDate,
        originalSigningDate,
        outstandingBalance: String(formData.get("csOutstandingBalance") ?? ""),
      });

      if (!derived.ok) {
        return {
          ok: false,
          redirect: currentStateErrorUrl(formData, derived.error),
        };
      }
      return {
        ok: true,
        value: { derived, endDate, inputMode, nextPaymentDate, originalSigningDate },
      };
    },
    run: async (store, { id, today, parsed }) => {
      const guard = await requireDebtModel(store, id, "amortizable");
      if (!guard.ok) {
        return guard;
      }

      const existing = await store.liabilities.readAmortizationPlan(id);
      if (existing) {
        return { ok: false, error: "Esta deuda ya tiene un plan de amortización." };
      }

      await persistCurrentStateAmortization(
        store,
        id,
        parsed.derived,
        {
          baselineDate: today,
          endDate: parsed.endDate,
          inputMode: parsed.inputMode,
          nextPaymentDate: parsed.nextPaymentDate,
          originalSigningDate: parsed.originalSigningDate || null,
        },
        Date.now(),
        today,
      );
      return { ok: true };
    },
    onError: ({ formData, error }) => currentStateErrorUrl(formData, error),
    onSuccess: () => successRedirectUrl(baseUrl(formData), "current_state_debt_saved"),
  })(formData, ..._testArgs);
}

/**
 * "Recalibrar con saldo real" on the advanced edit surface (ADR 0056, PRD #670
 * S3, #678) — the drift repair for an EXISTING amortizable debt. Declares a
 * fresh balance re-baseline at the given date (the SAME dated-fact kind S1/S2
 * use, `startsAtBaseline: false` here — it corrects a running curve, it does
 * not redefine the debt's origin) and rides `addBalanceRebaselineAndRipple`
 * for the forward-only ripple + audit trail (ADR 0012). Rate, end date and
 * next-cuota date are NOT re-entered: `effectiveAmortizationPlan` resolves
 * whichever plan or prior re-baseline currently governs the declared date, and
 * `deriveRecalibrationRebaseline` folds in any rate revisions on/before it.
 */
export async function recalibrateDebtBalanceAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    missingId: "Identificador de deuda no encontrado.",
    parse: ({ formData, id, today }) => {
      const validated = validateRecalibrateDebt({
        balanceDate: String(formData.get("rbBalanceDate") ?? "").trim(),
        outstandingBalance: String(formData.get("rbOutstandingBalance") ?? ""),
        today,
      });
      if (!validated.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(baseUrl(formData), {
            formId: "recalibrateDebt",
            message: validated.error,
            values: preserveFields(formData, [...RECALIBRATE_DEBT_FIELD_NAMES]),
          }),
        };
      }
      return { ok: true, value: validated };
    },
    run: async (store, { id, today, parsed }) => {
      const guard = await requireDebtModel(store, id, "amortizable");
      if (!guard.ok) {
        return guard;
      }

      // Gate on the effective CURVE, not the plan row (#678 review): an imported
      // current-state debt can be rebaselined with no plan row at all (S1's
      // `startsAtBaseline` fact alone governs the curve) — that debt still has a
      // valid schedule to recalibrate, so requiring a plan row would falsely
      // reject it. Revisions hang off `planId`, so they only exist with a plan.
      const curve = await readAmortizableDebtCurveContext(store, id);

      const effective = effectiveAmortizationPlan({
        balanceRebaselines: curve.balanceRebaselines,
        ...(curve.plan
          ? {
              plan: {
                annualInterestRate: curve.plan.annualInterestRate,
                disbursementDate: curve.plan.disbursementDate,
                firstPaymentDate: curve.plan.firstPaymentDate,
                initialCapitalMinor: curve.plan.initialCapitalMinor,
                termMonths: curve.plan.termMonths,
              },
            }
          : {}),
        targetDate: parsed.balanceDate,
      });

      const derived = deriveRecalibrationRebaseline({
        balanceDate: parsed.balanceDate,
        effective,
        revisions: curve.revisions,
      });

      if (!derived.ok) {
        return derived;
      }

      // Read the curve as it stands BEFORE the write: is the declared figure the
      // bank's settlement amount (principal + accrued interest) rather than the
      // principal this form persists? (#1292) Evaluated at the DECLARED date, the
      // one the user was comparing against. A warning, never a rejection — the
      // write goes through either way.
      const accrual = debtAccrualAtDate({
        balanceRebaselines: curve.balanceRebaselines,
        currentBalanceMinor: curve.currentBalanceMinor,
        debtModel: "amortizable",
        earlyRepayments: curve.earlyRepayments,
        revisions: curve.revisions.map((revision) => ({
          newAnnualInterestRate: revision.newAnnualInterestRate,
          revisionDate: revision.revisionDate,
        })),
        targetDate: parsed.balanceDate,
        ...(curve.plan ? { plan: curve.plan } : {}),
      });
      const settlementSuspected =
        accrual !== null &&
        looksLikeSettlementAmount({
          accruedInterestMinor: accrual.accruedInterestMinor,
          declaredMinor: parsed.outstandingBalanceMinor,
          principalMinor: accrual.principalMinor,
        });

      await store.command.addBalanceRebaseline(
        {
          annualInterestRate: derived.annualInterestRate,
          baselineDate: parsed.balanceDate,
          endDate: derived.endDate,
          id: createStableId("rebaseline", id, Date.now()),
          liabilityId: id,
          nextPaymentDate: derived.nextPaymentDate,
          outstandingBalanceMinor: parsed.outstandingBalanceMinor,
          startsAtBaseline: false,
        },
        { today },
      );

      return { ok: true as const, value: { settlementSuspected } };
    },
    onError: ({ error, formData }) =>
      errorRedirectUrl(baseUrl(formData), {
        formId: "recalibrateDebt",
        message: error,
        values: preserveFields(formData, [...RECALIBRATE_DEBT_FIELD_NAMES]),
      }),
    // #1292's two ok-keys survive the #1318 swap: which message the band shows
    // is the point of that change, and it is orthogonal to how the page is
    // named. The trailing `#id` anchor does not survive — it pointed at the
    // internal id, and on the ficha it never matched an element anyway.
    onSuccess: ({ value }) =>
      successRedirectUrl(
        baseUrl(formData),
        value?.settlementSuspected ? "debt_recalibrated_settlement" : "debt_recalibrated",
      ),
  })(formData, ..._testArgs);
}

/**
 * Import a balance-history series as a chain of re-baselines (ADR 0056, #696).
 * Consumed by #764 S5 — no UI of its own. Rows arrive as JSON in `rows`;
 * preview/validation runs in the pure module, confirm rides
 * `executeImportBalanceHistoryCommand` for ONE atomic ripple from the oldest checkpoint.
 */
export async function importBalanceHistoryAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    missingId: "Identificador de deuda no encontrado.",
    parse: ({ formData }) => {
      let rawRows: unknown;
      try {
        rawRows = JSON.parse(String(formData.get("rows") ?? "[]"));
      } catch {
        return {
          ok: false,
          redirect: errorRedirectUrl(baseUrl(formData), {
            message: BALANCE_HISTORY_MESSAGES.invalidSeries,
          }),
        };
      }
      const parsedRows = parseBalanceHistoryRows(rawRows);
      if (!parsedRows.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(baseUrl(formData), { message: parsedRows.error }),
        };
      }
      return { ok: true, value: parsedRows.rows };
    },
    run: async (store, { id, today, parsed }) => {
      const guard = await requireDebtModel(store, id, "amortizable");
      if (!guard.ok) return guard;

      const ctx = await readBalanceHistoryDebtContext(store, id, today);
      const plan = planBalanceHistoryImport(parsed, ctx);
      const skipped = plan.previews.filter((row) => row.status === "skipped").length;

      if (plan.composed.length === 0) {
        if (skipped > 0 && skipped === plan.previews.length) {
          return { created: 0, ok: true as const, skipped };
        }
        return { error: "No hay saldos válidos que importar.", ok: false as const };
      }

      const created = await persistBalanceHistoryImport(store, id, plan.composed, today);
      return { created, ok: true as const, skipped };
    },
    onError: ({ error }) => errorRedirectUrl(baseUrl(formData), { message: error }),
    onSuccess: () => successRedirectUrl(baseUrl(formData), "balance_history_imported"),
  })(formData, ..._testArgs);
}

export async function saveAmortizationPlanAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    datedFact: false,
    missingId: "Identificador de deuda no encontrado.",
    parse: ({ formData, id, today }) => {
      const parsed = parseAmortizationPlanStrict(formData, id, Date.now(), today);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(baseUrl(formData), {
            formId: "plan",
            message: parsed.error,
            values: preserveFields(formData, [
              "initialCapital",
              "annualInterestRate",
              "termMonths",
              "disbursementDate",
              "firstPaymentDate",
            ]),
          }),
        };
      }
      return { ok: true, value: parsed.command };
    },
    run: async (store, { id, today, parsed }) => {
      const guard = await requireDebtModel(store, id, "amortizable");
      if (!guard.ok) {
        return guard;
      }

      // Persist + ripple ride the amortizable-debt seam directly (#970, #1114).
      const existing = await store.liabilities.readAmortizationPlan(id);
      if (existing) {
        await store.command.updateAmortizationPlan(
          existing.id,
          {
            annualInterestRate: parsed.annualInterestRate,
            disbursementDate: parsed.disbursementDate,
            firstPaymentDate: parsed.firstPaymentDate,
            initialCapitalMinor: parsed.initialCapitalMinor,
            termMonths: parsed.termMonths,
          },
          { liabilityId: id, today },
        );
      } else {
        await store.command.createAmortizationPlan(parsed, { today });
      }
      return { ok: true };
    },
    onError: ({ error }) =>
      errorRedirectUrl(baseUrl(formData), { formId: "plan", message: error }),
    onSuccess: () => successRedirectUrl(baseUrl(formData), "plan_saved"),
  })(formData, ..._testArgs);
}

export async function deleteAmortizationPlanAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    datedFact: false,
    extraIds: ["planId"],
    missingId: "Identificador del plan no encontrado.",
    run: async (store, { id, today }) => {
      const guard = await requireDebtModel(store, id, "amortizable");
      if (!guard.ok) {
        return guard;
      }
      // Delete + ripple ride the debt seam (ADR 0020): it captures the plan's
      // disbursement date BEFORE deleting (the floor for the planless ripple,
      // ADR 0019 #188), then recalculates every snapshot ≥ that floor against the
      // now-planless curve, atomically. The liability is resolved from `id`.
      const changes = await store.command.deleteAmortizationPlan({
        liabilityId: id,
        today,
      });
      if (changes === 0) {
        return {
          ok: false,
          error: "No se encontró el plan — puede que ya se haya eliminado.",
        };
      }
      return { ok: true };
    },
    onError: ({ error }) => errorRedirectUrl(baseUrl(formData), { message: error }),
    onSuccess: () => successRedirectUrl(baseUrl(formData), "plan_deleted"),
  })(formData, ..._testArgs);
}

export async function addInterestRateRevisionAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    extraIds: ["planId"],
    missingId: "Identificador del plan no encontrado.",
    parse: ({ formData, id, extra, today }) => {
      const parsed = parseInterestRateRevisionStrict(
        formData,
        extra.planId!,
        Date.now(),
        today,
      );
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(baseUrl(formData), {
            formId: "revision",
            message: parsed.error,
            values: preserveFields(formData, ["revisionDate", "newAnnualInterestRate"]),
          }),
        };
      }
      return { ok: true, value: parsed.command };
    },
    run: async (store, { id, today, parsed }) => {
      const guard = await requireDebtModel(store, id, "amortizable");
      if (!guard.ok) {
        return guard;
      }
      await store.command.addInterestRateRevision(parsed, { liabilityId: id, today });
      return { ok: true };
    },
    onError: ({ error }) =>
      errorRedirectUrl(baseUrl(formData), { formId: "revision", message: error }),
    onSuccess: () => successRedirectUrl(baseUrl(formData), "revision_added"),
  })(formData, ..._testArgs);
}

export async function updateInterestRateRevisionAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    extraIds: ["planId", "revisionId"],
    missingId: "Identificador de la revisión no encontrado.",
    parse: ({ formData, id, extra, today }) => {
      const parsed = parseInterestRateRevisionStrict(
        formData,
        extra.planId!,
        Date.now(),
        today,
      );
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(baseUrl(formData), {
            formId: `revision-${extra.revisionId}`,
            message: parsed.error,
            values: preserveFields(formData, ["revisionDate", "newAnnualInterestRate"]),
          }),
        };
      }
      return { ok: true, value: parsed.command };
    },
    run: async (store, { id, extra, today, parsed }) => {
      const guard = await requireDebtModel(store, id, "amortizable");
      if (!guard.ok) {
        return guard;
      }
      const changes = await store.command.updateInterestRateRevision(
        extra.revisionId!,
        {
          newAnnualInterestRate: parsed.newAnnualInterestRate,
          revisionDate: parsed.revisionDate,
        },
        { today },
      );
      if (changes === 0) {
        return {
          ok: false,
          error: "No se encontró la revisión — puede que ya se haya eliminado.",
        };
      }
      return { ok: true };
    },
    onError: ({ id, extra, error }) =>
      errorRedirectUrl(baseUrl(formData), {
        formId: `revision-${extra.revisionId}`,
        message: error,
      }),
    onSuccess: () => successRedirectUrl(baseUrl(formData), "revision_saved"),
  })(formData, ..._testArgs);
}

export async function deleteInterestRateRevisionAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    datedFact: false,
    extraIds: ["revisionId", "planId"],
    missingId: "Identificador de la revisión no encontrado.",
    run: async (store, { id, extra, today }) => {
      const guard = await requireDebtModel(store, id, "amortizable");
      if (!guard.ok) {
        return guard;
      }
      const changes = await store.command.deleteInterestRateRevision(extra.revisionId!, {
        today,
      });
      if (changes === 0) {
        return {
          ok: false,
          error: "No se encontró la revisión — puede que ya se haya eliminado.",
        };
      }
      return { ok: true };
    },
    onError: ({ error }) => errorRedirectUrl(baseUrl(formData), { message: error }),
    onSuccess: () => successRedirectUrl(baseUrl(formData), "revision_deleted"),
  })(formData, ..._testArgs);
}

export async function addEarlyRepaymentAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    extraIds: ["planId"],
    missingId: "Identificador del plan no encontrado.",
    parse: ({ formData, id, extra, today }) => {
      const parsed = parseEarlyRepaymentStrict(
        formData,
        extra.planId!,
        Date.now(),
        today,
      );
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(baseUrl(formData), {
            formId: "repayment",
            message: parsed.error,
            values: preserveFields(formData, ["repaymentDate", "amount", "mode"]),
          }),
        };
      }
      return { ok: true, value: parsed.command };
    },
    run: async (store, { id, today, parsed }) => {
      const guard = await requireDebtModel(store, id, "amortizable");
      if (!guard.ok) {
        return guard;
      }
      await store.command.addEarlyRepayment(parsed, { liabilityId: id, today });
      return { ok: true };
    },
    onError: ({ error }) =>
      errorRedirectUrl(baseUrl(formData), { formId: "repayment", message: error }),
    onSuccess: () => successRedirectUrl(baseUrl(formData), "repayment_added"),
  })(formData, ..._testArgs);
}

export async function updateEarlyRepaymentAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    extraIds: ["planId", "repaymentId"],
    missingId: "Identificador de la amortización no encontrado.",
    parse: ({ formData, id, extra, today }) => {
      const parsed = parseEarlyRepaymentStrict(
        formData,
        extra.planId!,
        Date.now(),
        today,
      );
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(baseUrl(formData), {
            formId: `repayment-${extra.repaymentId}`,
            message: parsed.error,
            values: preserveFields(formData, ["repaymentDate", "amount", "mode"]),
          }),
        };
      }
      return { ok: true, value: parsed.command };
    },
    run: async (store, { id, extra, today, parsed }) => {
      const guard = await requireDebtModel(store, id, "amortizable");
      if (!guard.ok) {
        return guard;
      }
      const changes = await store.command.updateEarlyRepayment(
        extra.repaymentId!,
        {
          amountMinor: parsed.amountMinor,
          mode: parsed.mode,
          repaymentDate: parsed.repaymentDate,
        },
        { today },
      );
      if (changes === 0) {
        return {
          ok: false,
          error: "No se encontró la amortización — puede que ya se haya eliminado.",
        };
      }
      return { ok: true };
    },
    onError: ({ id, extra, error }) =>
      errorRedirectUrl(baseUrl(formData), {
        formId: `repayment-${extra.repaymentId}`,
        message: error,
      }),
    onSuccess: () => successRedirectUrl(baseUrl(formData), "repayment_saved"),
  })(formData, ..._testArgs);
}

export async function deleteEarlyRepaymentAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    datedFact: false,
    extraIds: ["repaymentId", "planId"],
    missingId: "Identificador de la amortización no encontrado.",
    run: async (store, { id, extra, today }) => {
      const guard = await requireDebtModel(store, id, "amortizable");
      if (!guard.ok) {
        return guard;
      }
      const changes = await store.command.deleteEarlyRepayment(extra.repaymentId!, {
        today,
      });
      if (changes === 0) {
        return {
          ok: false,
          error: "No se encontró la amortización — puede que ya se haya eliminado.",
        };
      }
      return { ok: true };
    },
    onError: ({ error }) => errorRedirectUrl(baseUrl(formData), { message: error }),
    onSuccess: () => successRedirectUrl(baseUrl(formData), "repayment_deleted"),
  })(formData, ..._testArgs);
}
