import { createStableId } from "@web/intake";
import type { CreateDebtHoldingCommand, WorthlineStore } from "@worthline/db";

import type {
  CurrentStateDebtDerived,
  CurrentStateInputMode,
} from "./current-state-debt";

/** How the raw form states the dates a current-state declaration is anchored on. */
interface CurrentStateDates {
  inputMode: CurrentStateInputMode;
  baselineDate: string;
  endDate: string;
  nextPaymentDate: string;
  originalSigningDate?: string | null;
}

/**
 * The two dated facts an "alta por estado actual" declaration is made of (ADR
 * 0056, PRD #670 S2, #677): the derived amortization plan and the
 * `startsAtBaseline` re-baseline that pins the balance at the baseline date.
 *
 * Pure — it mints ids off `seed` and shapes the rows, and writes nothing. That is
 * what lets the alta (#1599) hand them to the debt-alta seam, where they commit
 * inside the SAME transaction as the liability row, while the advanced edit
 * surface — which declares them over a liability that already exists — passes
 * them straight to `createCurrentStateDebt`.
 */
export function buildCurrentStateAmortization(
  liabilityId: string,
  derived: CurrentStateDebtDerived,
  raw: CurrentStateDates,
  seed: number,
): NonNullable<CreateDebtHoldingCommand["currentState"]> {
  const rebaselineBase = {
    baselineDate: raw.baselineDate,
    endDate: raw.endDate,
    id: createStableId("rebaseline", liabilityId, seed + 1),
    liabilityId,
    nextPaymentDate: raw.nextPaymentDate,
    outstandingBalanceMinor: derived.outstandingBalanceMinor,
    startsAtBaseline: true as const,
  };

  return {
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
  };
}

/**
 * Persist a "alta por estado actual" declaration over an EXISTING liability
 * (ADR 0056, PRD #670 S2, #677) — the advanced edit surface's create action.
 *
 * A thin shell over the ONE atomic store seam (`createCurrentStateDebt`, the
 * #676 review's requirement that a current-state debt never lands with a plan
 * row but no re-baseline, or the reverse: both dated facts, the balance sync,
 * and the ripple commit or roll back together).
 *
 * The wizard's debt drawer does NOT come through here: there the liability is
 * born in the same submission, so both halves ride the debt-alta seam instead
 * (`createDebtHolding`, #1599) and the declaration cannot outlive a failed alta.
 */
export async function persistCurrentStateAmortization(
  store: WorthlineStore,
  liabilityId: string,
  derived: CurrentStateDebtDerived,
  raw: CurrentStateDates,
  seed: number,
  today: string,
): Promise<void> {
  await store.command.createCurrentStateDebt({
    ...buildCurrentStateAmortization(liabilityId, derived, raw, seed),
    today,
  });
}
