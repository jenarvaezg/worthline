import { readAmortizableDebtCurveContext } from "@web/patrimonio/amortizable-debt-curve-context";
import type { WorthlineStore } from "@worthline/db";
import {
  type AmortizationScheduleImportPlan,
  type AmortizationScheduleReading,
  buildAmortizationScheduleImportPlan,
  type EarlyRepaymentMode,
} from "@worthline/domain";

/**
 * Server-side half of the amortization-schedule import (#1406): which debts can
 * receive a cuadro, and what loading one onto a given debt would do.
 *
 * The verification runs against the SAME curve context the debt page draws —
 * plan, re-baselines, the revisions and lumps already stored — because a preview
 * that measures against an idealized curve would promise a figure the app is
 * never going to show (the lesson of #1422).
 */

/** A debt a cuadro can be loaded onto: amortizable, with a plan to write over. */
export interface ScheduleImportTarget {
  liabilityId: string;
  planId: string;
  name: string;
  /** The plan's own rate, before any revision — what the document will correct. */
  annualInterestRate: string;
  disbursementDate: string;
  revisionCount: number;
  earlyRepaymentCount: number;
  rebaselineCount: number;
}

/**
 * The debts «Cuadro de amortización» can target. A debt with no amortization plan
 * is not offered: the reader writes revisions and lumps over a plan that already
 * exists and never creates one (the constraint the #1406 decision hands down), so
 * an unplanned debt has to be given its conditions first.
 */
export async function readScheduleImportTargets(
  store: WorthlineStore,
): Promise<ScheduleImportTarget[]> {
  const liabilities = await store.liabilities.readLiabilities();
  const targets: ScheduleImportTarget[] = [];

  for (const liability of liabilities) {
    const plan = await store.liabilities.readAmortizationPlan(liability.id);
    if (!plan) continue;
    const [revisions, earlyRepayments, rebaselines] = await Promise.all([
      store.liabilities.readInterestRateRevisions(plan.id),
      store.liabilities.readEarlyRepayments(plan.id),
      store.liabilities.readBalanceRebaselines(liability.id),
    ]);
    targets.push({
      annualInterestRate: plan.annualInterestRate,
      disbursementDate: plan.disbursementDate,
      earlyRepaymentCount: earlyRepayments.length,
      liabilityId: liability.id,
      name: liability.name,
      planId: plan.id,
      rebaselineCount: rebaselines.length,
      revisionCount: revisions.length,
    });
  }

  return targets;
}

export type ScheduleImportPreview =
  | { ok: false; message: string }
  | {
      ok: true;
      planId: string;
      liabilityId: string;
      liabilityName: string;
      sheetName: string;
      value: AmortizationScheduleImportPlan;
    };

/**
 * What loading `reading` onto `liabilityId` would do, resolved against the store.
 * Reads only — nothing is written until confirm re-derives this same plan.
 */
export async function buildScheduleImportPreview(
  store: WorthlineStore,
  input: {
    liabilityId: string;
    reading: AmortizationScheduleReading;
    earlyRepaymentMode: EarlyRepaymentMode;
  },
): Promise<ScheduleImportPreview> {
  const liabilities = await store.liabilities.readLiabilities();
  const liability = liabilities.find((row) => row.id === input.liabilityId);
  if (!liability) {
    return { message: "Esa deuda ya no está en tu patrimonio.", ok: false };
  }

  const storedPlan = await store.liabilities.readAmortizationPlan(input.liabilityId);
  if (!storedPlan) {
    return {
      message: `«${liability.name}» no tiene cuadro de condiciones todavía. Dale de alta capital, plazo, tipo y fechas en su ficha (/patrimonio/${input.liabilityId}/editar) y vuelve: este lector escribe revisiones y amortizaciones sobre un plan que ya existe, nunca lo crea.`,
      ok: false,
    };
  }

  const context = await readAmortizableDebtCurveContext(store, input.liabilityId);
  if (!context.plan) {
    return { message: "Esa deuda ya no tiene cuadro de condiciones.", ok: false };
  }

  const cadence = await store.liabilities.readValuationCadence(input.liabilityId);

  return {
    liabilityId: input.liabilityId,
    liabilityName: liability.name,
    ok: true,
    planId: storedPlan.id,
    sheetName: input.reading.sheetName,
    value: buildAmortizationScheduleImportPlan(input.reading, {
      balanceRebaselines: context.balanceRebaselines,
      cadence,
      currentBalanceMinor: context.currentBalanceMinor,
      earlyRepaymentMode: input.earlyRepaymentMode,
      existingEarlyRepayments: context.earlyRepayments,
      existingRevisions: context.revisions.map((revision) => ({
        newAnnualInterestRate: revision.newAnnualInterestRate,
        revisionDate: revision.revisionDate,
      })),
      plan: context.plan,
    }),
  };
}
