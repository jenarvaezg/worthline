import { createStableId } from "@web/intake";
import { type AddBalanceRebaselineInput, type WorthlineStore } from "@worthline/db";

import { readAmortizableDebtCurveContext } from "./amortizable-debt-curve-context";
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
  const [reads, cadence] = await Promise.all([
    readAmortizableDebtCurveContext(store, liabilityId),
    store.liabilities.readValuationCadence(liabilityId),
  ]);
  return {
    balanceRebaselines: reads.balanceRebaselines,
    cadence,
    currentBalanceMinor: reads.currentBalanceMinor,
    // #1422: las amortizaciones anticipadas y la cadencia viajaban leídas pero se
    // caían aquí, y la curva de la importación quedaba por encima de la real.
    earlyRepayments: reads.earlyRepayments,
    ...(reads.plan ? { plan: reads.plan } : {}),
    revisions: reads.revisions,
    today,
  };
}

/**
 * Persist a balance-history import (ADR 0056, #696, architecture review #969) —
 * delegates to the balance-history command: N re-baselines with
 * `startsAtBaseline: false`, ONE ripple from the oldest checkpoint.
 */
export async function persistBalanceHistoryImport(
  store: WorthlineStore,
  liabilityId: string,
  composed: readonly ComposedBalanceHistoryRebaseline[],
  today: string,
): Promise<number> {
  if (composed.length === 0) {
    return 0;
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

  const outcome = await store.command.importBalanceHistory({
    liabilityId,
    rebaselines,
    today,
    trigger: "csv",
  });
  return outcome.created;
}
