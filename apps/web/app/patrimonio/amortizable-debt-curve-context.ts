import type { WorthlineStore } from "@worthline/db";
import type { AmortizationPlanInput } from "@worthline/domain";

import type { RecalibrationRevision } from "./recalibrate-debt";

/**
 * Shared store reads for amortizable debt curve operations (#678, #696).
 * Centralises the plan/rebaseline/revision fetch + plan-field mapping that
 * recalibrate and balance-history import both need.
 */
export interface AmortizableDebtCurveReads {
  plan?: AmortizationPlanInput;
  balanceRebaselines: Awaited<
    ReturnType<WorthlineStore["liabilities"]["readBalanceRebaselines"]>
  >;
  revisions: readonly RecalibrationRevision[];
  currentBalanceMinor: number;
}

export async function readAmortizableDebtCurveContext(
  store: WorthlineStore,
  liabilityId: string,
): Promise<AmortizableDebtCurveReads> {
  const [plan, rebaselines, liabilities] = await Promise.all([
    store.liabilities.readAmortizationPlan(liabilityId),
    store.liabilities.readBalanceRebaselines(liabilityId),
    store.liabilities.readLiabilities(),
  ]);
  const liability = liabilities.find((row) => row.id === liabilityId);
  const revisions = plan
    ? await store.liabilities.readInterestRateRevisions(plan.id)
    : [];

  const planInput: AmortizationPlanInput | undefined = plan
    ? {
        annualInterestRate: plan.annualInterestRate,
        disbursementDate: plan.disbursementDate,
        firstPaymentDate: plan.firstPaymentDate,
        initialCapitalMinor: plan.initialCapitalMinor,
        termMonths: plan.termMonths,
      }
    : undefined;

  return {
    balanceRebaselines: rebaselines,
    currentBalanceMinor: liability?.currentBalance.amountMinor ?? 0,
    ...(planInput ? { plan: planInput } : {}),
    revisions,
  };
}
