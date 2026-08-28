import { debtBalanceAtDate } from "@worthline/domain";
import { eq } from "drizzle-orm";
import { readCurveGovernedLiabilityIds } from "./curve-valued-holdings";
import type { AmortizationPlanRecord } from "./liability-amortization-plan-store";
import { readAmortizationPlan } from "./liability-amortization-plan-store";
import { readBalanceAnchors } from "./liability-balance-anchor-store";
import { readBalanceRebaselines } from "./liability-balance-rebaseline-store";
import { readEarlyRepayments } from "./liability-early-repayment-store";
import { readInterestRateRevisions } from "./liability-rate-revision-store";
import { liabilities } from "./schema";
import type { StoreContext } from "./store-context";

/**
 * The figure a debt shows on a date. This is the ONE place that reads across the
 * families — plan, revisions, early repayments, re-baselines, anchors — and hands
 * them to the pure domain curve; each family's own module never reads a sibling.
 * Reads compose, writes don't (#1604).
 */
export interface LiabilityBalanceReadStore {
  /**
   * Outstanding principal of an amortizable liability on `targetDate`
   * (YYYY-MM-DD): reads the plan + revisions + early repayments and delegates to
   * the pure domain curve. Throws if the liability has no amortization plan.
   */
  amortizableBalanceAtDate: (liabilityId: string, targetDate: string) => Promise<number>;
  /**
   * Outstanding balance of a liability on `targetDate` (YYYY-MM-DD) for any debt
   * model: reads the model + anchors (+ plan/revisions when amortizable) + the
   * current balance and delegates to the pure domain dispatcher. A null model or
   * missing data falls back to the current balance.
   */
  debtBalanceAtDate: (liabilityId: string, targetDate: string) => Promise<number>;
  /**
   * Ids of the liabilities whose figure comes from a modelled curve — a plan, a
   * re-baseline or a declared balance — so their stored balance is a dead field
   * (#1290 / #1334). The one way the app asks `storedBalanceGovernsDebtFigure`, in
   * one pass over the curve tables: the surface that lists EVERY debt (the «puesta
   * al día») decides who gets a balance input without a read per row, and the two
   * write actions refuse with the same answer.
   */
  readCurveGovernedLiabilityIds: () => Promise<Set<string>>;
}

export function createLiabilityBalanceReadStore(
  ctx: StoreContext,
): LiabilityBalanceReadStore {
  return {
    amortizableBalanceAtDate: (liabilityId, targetDate) =>
      amortizableBalanceAtDateFor(ctx, liabilityId, targetDate),
    debtBalanceAtDate: (liabilityId, targetDate) =>
      debtBalanceAtDateFor(ctx, liabilityId, targetDate),
    readCurveGovernedLiabilityIds: () => readCurveGovernedLiabilityIds(ctx.db),
  };
}

/**
 * The contracted schedule of a plan, in the shape the pure domain curve folds.
 * The store's record carries descriptive fields the curve never reads (ADR 0056);
 * this is the projection down to what it does.
 */
function scheduleOf(plan: AmortizationPlanRecord) {
  return {
    annualInterestRate: plan.annualInterestRate,
    disbursementDate: plan.disbursementDate,
    firstPaymentDate: plan.firstPaymentDate,
    initialCapitalMinor: plan.initialCapitalMinor,
    termMonths: plan.termMonths,
  };
}

/** The dated events that bend a plan's curve, in the shape the domain folds. */
async function readPlanEvents(ctx: StoreContext, planId: string) {
  const revisions = (await readInterestRateRevisions(ctx, planId)).map((revision) => ({
    newAnnualInterestRate: revision.newAnnualInterestRate,
    revisionDate: revision.revisionDate,
  }));
  const repayments = (await readEarlyRepayments(ctx, planId)).map((repayment) => ({
    amountMinor: repayment.amountMinor,
    mode: repayment.mode,
    repaymentDate: repayment.repaymentDate,
  }));
  return { repayments, revisions };
}

async function amortizableBalanceAtDateFor(
  ctx: StoreContext,
  liabilityId: string,
  targetDate: string,
): Promise<number> {
  const plan = await readAmortizationPlan(ctx, liabilityId);
  const rebaselines = await readBalanceRebaselines(ctx, liabilityId);
  if (!plan && rebaselines.length === 0) {
    throw new Error(`Liability "${liabilityId}" has no amortization plan.`);
  }

  const events = plan
    ? await readPlanEvents(ctx, plan.id)
    : { repayments: [], revisions: [] };

  return debtBalanceAtDate({
    balanceRebaselines: rebaselines,
    currentBalanceMinor: 0,
    debtModel: "amortizable",
    earlyRepayments: events.repayments,
    ...(plan ? { plan: scheduleOf(plan) } : {}),
    revisions: events.revisions,
    targetDate,
  });
}

async function debtBalanceAtDateFor(
  ctx: StoreContext,
  liabilityId: string,
  targetDate: string,
): Promise<number> {
  const row = await ctx.db
    .select({
      currentBalanceMinor: liabilities.currentBalanceMinor,
      debtModel: liabilities.debtModel,
      valuationCadence: liabilities.valuationCadence,
    })
    .from(liabilities)
    .where(eq(liabilities.id, liabilityId))
    .get();

  if (!row) {
    throw new Error(`Liability "${liabilityId}" not found.`);
  }

  const currentBalanceMinor = row.currentBalanceMinor;
  const debtModel = row.debtModel ?? null;
  // The stored cadence (ADR 0031, #393); null reads as `step` in the engine.
  const cadence = row.valuationCadence ?? null;

  if (debtModel === "amortizable") {
    const plan = await readAmortizationPlan(ctx, liabilityId);
    const rebaselines = await readBalanceRebaselines(ctx, liabilityId);
    if (!plan) {
      return debtBalanceAtDate({
        balanceRebaselines: rebaselines,
        currentBalanceMinor,
        debtModel,
        targetDate,
        ...(cadence != null ? { cadence } : {}),
      });
    }
    const events = await readPlanEvents(ctx, plan.id);
    return debtBalanceAtDate({
      balanceRebaselines: rebaselines,
      currentBalanceMinor,
      debtModel,
      earlyRepayments: events.repayments,
      plan: scheduleOf(plan),
      revisions: events.revisions,
      targetDate,
      ...(cadence != null ? { cadence } : {}),
    });
  }

  const anchors = (await readBalanceAnchors(ctx, liabilityId)).map((anchor) => ({
    anchorDate: anchor.anchorDate,
    balanceMinor: anchor.balanceMinor,
  }));

  return debtBalanceAtDate({
    anchors,
    currentBalanceMinor,
    debtModel,
    targetDate,
    ...(cadence != null ? { cadence } : {}),
  });
}
