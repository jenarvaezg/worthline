import type { WorthlineStore } from "@worthline/db";
import type { AmortizationPlanInput, EarlyRepayment } from "@worthline/domain";

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
  /**
   * The plan's early repayments (#1292). Needed by anything that VALUES the curve
   * rather than only re-deriving its rate/end date — a lump moves the balance, so
   * omitting them would price the debt above where it actually stands.
   */
  earlyRepayments: readonly EarlyRepayment[];
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
  // Both hang off the plan id and are independent of each other — one wave.
  const [revisions, earlyRepayments] = plan
    ? await Promise.all([
        store.liabilities.readInterestRateRevisions(plan.id),
        store.liabilities.readEarlyRepayments(plan.id),
      ])
    : [[], []];

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
    earlyRepayments: earlyRepayments.map((repayment) => ({
      amountMinor: repayment.amountMinor,
      mode: repayment.mode,
      repaymentDate: repayment.repaymentDate,
    })),
    ...(planInput ? { plan: planInput } : {}),
    revisions,
  };
}
