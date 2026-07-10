import { createStableId } from "@web/intake";
import type { AddBalanceRebaselineInput, WorthlineStore } from "@worthline/db";
import type { AmortizationPlanInput } from "@worthline/domain";

import type {
  BalanceHistoryDebtContext,
  ComposedBalanceHistoryRebaseline,
} from "./import-balance-history";

/**
 * Read the debt curve context the balance-history preview/compose modules need.
 */
export async function readBalanceHistoryDebtContext(
  store: WorthlineStore,
  liabilityId: string,
  today: string,
): Promise<BalanceHistoryDebtContext> {
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
    today,
  };
}

/**
 * Persist a balance-history import (ADR 0056, #696) — a thin shell over the ONE
 * batched store seam (`importBalanceHistoryAndRipple`): N re-baselines with
 * `startsAtBaseline: false`, ONE ripple from the oldest checkpoint.
 */
export async function persistBalanceHistoryImport(
  store: WorthlineStore,
  liabilityId: string,
  composed: readonly ComposedBalanceHistoryRebaseline[],
  today: string,
): Promise<{ created: number; skipped: number }> {
  if (composed.length === 0) {
    return { created: 0, skipped: 0 };
  }

  const rebaselines: AddBalanceRebaselineInput[] = composed.map((row) => ({
    annualInterestRate: row.annualInterestRate,
    baselineDate: row.baselineDate,
    endDate: row.endDate,
    id: createStableId("rebaseline", `${liabilityId}_${row.baselineDate}`, 0),
    liabilityId,
    nextPaymentDate: row.nextPaymentDate,
    outstandingBalanceMinor: row.outstandingBalanceMinor,
    startsAtBaseline: false,
  }));

  const created = await store.importBalanceHistoryAndRipple({
    liabilityId,
    rebaselines,
    today,
  });

  return { created, skipped: 0 };
}
