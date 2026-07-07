/**
 * Intermediate financial goals (PRD #421, #424): a target the user wants to fund
 * by a deadline (car, education, home down-payment), backed by one or more
 * assigned holdings. Pure types + the reservation/funded-ratio math; goals do
 * not affect FIRE eligibility until the #426 slice wires them in.
 */

import { allocateScopedHolding } from "./scope-allocation";
import type { ManualAsset } from "./workspace-types";

/** How urgently a goal should be funded when capital is scarce. */
export type GoalPriority = "high" | "medium" | "low";

export interface Goal {
  id: string;
  name: string;
  /** What the goal aims to set aside, in minor units. */
  targetAmountMinor: number;
  /** ISO date (YYYY-MM-DD) by which it should be funded. */
  deadline: string;
  priority: GoalPriority;
  /** The scope (household / member / group id) the goal belongs to. */
  scopeId: string;
  /** Holdings (asset ids) assigned to this goal. */
  assetIds: string[];
}

/**
 * Capital a goal reserves: `min(target, value of assigned holdings)`, never
 * negative. Capping at the target avoids carving a surplus out of the goal;
 * capping at the assigned value keeps it consistent with what the holdings hold.
 */
export function goalReservedMinor(
  targetAmountMinor: number,
  assignedValueMinor: number,
): number {
  return Math.max(0, Math.min(targetAmountMinor, assignedValueMinor));
}

/**
 * Scope-weighted value of the holdings a goal has assigned, in minor units: the
 * sum of each assigned asset's value allocated to the scope's members. A missing
 * asset id (trashed/removed holding) contributes nothing. Shared by the goals
 * MCP read and the settings UI — and by the #426 FIRE-reservation slice — so the
 * "what a goal reserves against" rule lives in exactly one place.
 */
export function assignedHoldingsValueMinor(
  assetIds: string[],
  assetById: Map<string, ManualAsset>,
  scopeMemberIds: Set<string>,
  shouldCountAsset: (asset: ManualAsset) => boolean = () => true,
): number {
  let total = 0;
  for (const assetId of assetIds) {
    const asset = assetById.get(assetId);
    if (!asset || !shouldCountAsset(asset)) {
      continue;
    }
    total += allocateScopedHolding(asset.currentValue.amountMinor, {
      ownership: asset.ownership,
      scopeMemberIds,
    }).ownedMinor;
  }
  return total;
}

/** One goal's inputs to the FIRE reservation sum (PRD #421, #426). */
export interface GoalReservationInput {
  targetAmountMinor: number;
  /** ISO date (YYYY-MM-DD). */
  deadline: string;
  /** Scope-weighted value of the goal's assigned holdings (`assignedHoldingsValueMinor`). */
  assignedValueMinor: number;
}

/**
 * Total capital reserved against FIRE eligibility (PRD #421, #426): the sum of
 * each goal's reservation (`min(target, assigned value)`) for the goals whose
 * deadline is still in the future and falls before the FIRE horizon.
 *
 * A deadline on or after `now` is required — a past deadline releases its
 * reservation (the money is spent or freed). `fireDate` is the horizon (the
 * projected/target FIRE date, ISO); a goal due after it does not reduce
 * pre-FIRE eligibility. `undefined` means no horizon (FIRE not reached / no
 * target age) — every still-future goal reserves. ISO dates compare
 * lexicographically, so string comparison is correct.
 */
export function totalGoalReservationMinor(
  goals: GoalReservationInput[],
  now: string,
  fireDate: string | undefined,
): number {
  return goals
    .filter(
      (goal) =>
        goal.deadline >= now && (fireDate === undefined || goal.deadline < fireDate),
    )
    .reduce(
      (sum, goal) =>
        sum + goalReservedMinor(goal.targetAmountMinor, goal.assignedValueMinor),
      0,
    );
}

/**
 * How funded a goal is, in basis points (0..10 000). It is the reserved capital
 * over the target, so it never exceeds 100 %. Zero for a non-positive target —
 * a guard against divide-by-zero, never a real configuration.
 */
export function goalFundedRatioBps(
  targetAmountMinor: number,
  assignedValueMinor: number,
): number {
  if (targetAmountMinor <= 0) {
    return 0;
  }

  return Math.round(
    (goalReservedMinor(targetAmountMinor, assignedValueMinor) * 10_000) /
      targetAmountMinor,
  );
}
