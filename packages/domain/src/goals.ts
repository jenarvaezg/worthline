/**
 * Intermediate financial goals (PRD #421, #424): a target the user wants to fund
 * by a deadline (car, education, home down-payment), backed by one or more
 * assigned holdings. Pure types + the reservation/funded-ratio math; goals do
 * not affect FIRE eligibility until the #426 slice wires them in.
 */

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
