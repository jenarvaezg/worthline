import type { WorthlineStore } from "@worthline/db";

import { createStableId } from "@web/intake";

import type {
  CurrentStateDebtDerived,
  CurrentStateInputMode,
} from "./current-state-debt";

/**
 * Persist a "alta por estado actual" declaration (ADR 0056, PRD #670 S2, #677).
 *
 * Shared by the wizard's debt drawer (`createHoldingAction`) and the advanced
 * edit surface's create action (`saveCurrentStateAmortizationAction`) — the ONE
 * place that composes the two dated-fact seams the #676 review requires
 * together: a derived amortization **plan row** (so a future rate revision or
 * early repayment has a `plan_id` to hang off) plus the `startsAtBaseline`
 * balance re-baseline fact (which governs the curve from the baseline forward,
 * per `effectiveAmortizationPlan`). A current-state debt is never persisted
 * with one but not the other. The liability's stored `currentBalanceMinor` is
 * also synced to the declared balance, so today's net worth (and housing-equity
 * netting) reflects it immediately, not the value the liability was created with.
 */
export async function persistCurrentStateAmortization(
  store: WorthlineStore,
  liabilityId: string,
  derived: CurrentStateDebtDerived,
  raw: {
    inputMode: CurrentStateInputMode;
    baselineDate: string;
    endDate: string;
    nextPaymentDate: string;
    originalSigningDate?: string | null;
  },
  seed: number,
  today: string,
): Promise<void> {
  await store.createAmortizationPlanAndRipple(
    {
      annualInterestRate: derived.annualInterestRate,
      disbursementDate: raw.baselineDate,
      firstPaymentDate: raw.nextPaymentDate,
      id: createStableId("plan", liabilityId, seed),
      initialCapitalMinor: derived.outstandingBalanceMinor,
      liabilityId,
      originalSigningDate: raw.originalSigningDate ?? null,
      termMonths: derived.months,
    },
    { today },
  );

  const rebaselineBase = {
    baselineDate: raw.baselineDate,
    endDate: raw.endDate,
    id: createStableId("rebaseline", liabilityId, seed + 1),
    liabilityId,
    nextPaymentDate: raw.nextPaymentDate,
    outstandingBalanceMinor: derived.outstandingBalanceMinor,
    startsAtBaseline: true as const,
  };
  await store.addBalanceRebaselineAndRipple(
    raw.inputMode === "rate"
      ? { ...rebaselineBase, annualInterestRate: derived.annualInterestRate }
      : { ...rebaselineBase, monthlyPaymentMinor: derived.monthlyPaymentMinor },
    { today },
  );

  await store.liabilities.updateLiabilityBalance(
    liabilityId,
    derived.outstandingBalanceMinor,
  );
}
