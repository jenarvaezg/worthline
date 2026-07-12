import { createStableId } from "@web/intake";
import { executeCreateCurrentStateDebtCommand, type WorthlineStore } from "@worthline/db";

import type {
  CurrentStateDebtDerived,
  CurrentStateInputMode,
} from "./current-state-debt";

/**
 * Persist a "alta por estado actual" declaration (ADR 0056, PRD #670 S2, #677).
 *
 * Shared by the wizard's debt drawer (`createHoldingAction`) and the advanced
 * edit surface's create action (`saveCurrentStateAmortizationAction`) — a thin
 * shell over the ONE atomic store seam (`createCurrentStateDebtAndRipple`, the
 * #676 review's requirement that a current-state debt never lands with a plan
 * row but no re-baseline, or the reverse: both dated facts, the balance sync,
 * and the ripple commit or roll back together).
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
  const rebaselineBase = {
    baselineDate: raw.baselineDate,
    endDate: raw.endDate,
    id: createStableId("rebaseline", liabilityId, seed + 1),
    liabilityId,
    nextPaymentDate: raw.nextPaymentDate,
    outstandingBalanceMinor: derived.outstandingBalanceMinor,
    startsAtBaseline: true as const,
  };

  const result = await executeCreateCurrentStateDebtCommand(store, {
    plan: {
      ...derived.plan,
      id: createStableId("plan", liabilityId, seed),
      liabilityId,
      originalSigningDate: raw.originalSigningDate ?? null,
    },
    rebaseline:
      raw.inputMode === "rate"
        ? { ...rebaselineBase, annualInterestRate: derived.annualInterestRate }
        : { ...rebaselineBase, monthlyPaymentMinor: derived.monthlyPaymentMinor },
    today,
  });
  if (!result.ok) {
    throw new Error(result.error);
  }
}
