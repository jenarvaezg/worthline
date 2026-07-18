/**
 * Holding-creation impact (#1105, PRD #1103 S2) — the pure "patrimonio neto antes
 * → después" arithmetic the alta card leads with. No store, no clock: it takes the
 * resolved {@link HoldingCreationPlan} and the scope net worth before, and returns
 * the signed contribution and the before/after/delta triple.
 *
 * The signed contribution mirrors how a household-scope net worth reads the
 * holding: asset families add their value, a debt subtracts its balance, and the
 * whole thing is weighted by the holding's total ownership share (a 75% holding
 * contributes 75% of its value to the household figure). An investment with no
 * declared opening contributes 0 — an empty container moves no figure.
 */

import type { HoldingCreationPlan } from "@worthline/db";

/** The raw (unweighted) signed value a plan carries, before ownership weighting. */
function rawSignedMinor(plan: HoldingCreationPlan): number {
  switch (plan.family) {
    case "stored":
    case "appreciating":
      return plan.currentValueMinor;
    case "investment":
      return plan.opening?.valueMinor ?? 0;
    case "debt":
      return -plan.balanceMinor;
  }
}

/**
 * The holding's signed contribution to the scope net worth, weighted by its total
 * ownership bps (positive for assets, negative for debt). Rounded to whole minor
 * units so the before/after stay integer money.
 */
export function signedNetWorthContributionMinor(plan: HoldingCreationPlan): number {
  const totalBps = plan.ownership.reduce((sum, share) => sum + share.shareBps, 0);
  return Math.round((rawSignedMinor(plan) * totalBps) / 10_000);
}

export interface HoldingCreationImpact {
  /**
   * The scope net worth before the alta, or `null` when the canonical read
   * failed/degraded. `null` is NOT the same as an empty workspace (a real 0 €):
   * an honest card must show "impacto no disponible" rather than fabricate a
   * 0 € figure it never read (ADR 0048).
   */
  beforeMinor: number | null;
  /** `beforeMinor + deltaMinor`, or `null` when `beforeMinor` is unknown. */
  afterMinor: number | null;
  /** Always known: the signed contribution derived from the plan alone. */
  deltaMinor: number;
}

/**
 * The before/after/delta the card renders. `afterMinor = beforeMinor + deltaMinor`
 * by construction, so the card never re-derives the arithmetic. When
 * `netWorthBeforeMinor` is `null` (a failed read) only the delta is known.
 */
export function holdingCreationImpact(
  netWorthBeforeMinor: number | null,
  plan: HoldingCreationPlan,
): HoldingCreationImpact {
  const deltaMinor = signedNetWorthContributionMinor(plan);
  return {
    afterMinor: netWorthBeforeMinor === null ? null : netWorthBeforeMinor + deltaMinor,
    beforeMinor: netWorthBeforeMinor,
    deltaMinor,
  };
}
