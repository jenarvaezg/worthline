/**
 * Per-goal FIRE date delay (PRD #507 S4, ADR 0042).
 *
 * Answers: "how many months does THIS goal delay my FIRE date?"
 *
 * Approach: project twice on the BASE scenario, through the single projection
 * door (`projectFireFromContext`, #1122) —
 *   WITHOUT: startingEligible = eligibleGross − otherReservations
 *   WITH:    startingEligible = eligibleGross − otherReservations − thisGoalReservation
 * Interpolate the fractional year of the threshold crossing in each run, then
 * return `round((fracYearWith − fracYearWithout) * 12)`.
 *
 * The horizon decision uses `fireReservationHorizon` — the SAME function used
 * by `totalGoalReservationMinor` and `countsTowardFire`. The in-horizon
 * reservation is passed in from the caller (already computed by the
 * `goalReservationMap` in `prepareObjetivosState`) so this helper never
 * re-derives reservation math independently.
 *
 * This is the 4th consumer of the reservation path (see also: prepareDashboardState,
 * prepareObjetivosState, MCP tools). ADR 0042 documents the model.
 *
 * Round-to-0 rule: if the goal reserves but the rounded delta is 0 months, we
 * return `{ kind: "delays", months: 0 }`. The UI layer is responsible for showing
 * "menos de 1 mes" in that case (months === 0 && kind === "delays").
 */

import type { ContributionPlan } from "./contribution-plan";
import { resolveMonthlySavingsCapacityForFire } from "./contribution-plan";
import type { FireContext } from "./fire";
import { fireReservationHorizon, projectFireFromContext } from "./fire";
import { DEFAULT_MAX_YEARS, fractionalFireYear } from "./fire-projection";
import type { Goal } from "./goals";

export type GoalFireDelay = { kind: "delays"; months: number } | { kind: "no_effect" };

export interface GoalFireDelayInput {
  /**
   * The resolved FIRE context (#1026): carries the config, the gross-eligible
   * total (before goal reservation) and the single resolved rate. This helper
   * uses `context.realReturnUsed` — the same rate as coast, projection and
   * fireLevels — with no loose rate to forget and no fallback.
   */
  context: FireContext;
  goal: Goal;
  /** In-horizon reservation of ALL OTHER goals (minor units), already filtered
   *  by the same `fireReservationHorizon` rule as `countsTowardFire`. */
  otherReservationsMinor: number;
  /**
   * This goal's in-horizon reservation in minor units — pass the value from
   * `goalReservationMap.get(goal.id)` in `prepareObjetivosState` so the helper
   * subtracts exactly what FIRE subtracts, not a separately derived amount.
   */
  thisGoalReservationMinor: number;
  /** ISO YYYY-MM-DD. */
  now: string;
  /** Scope contribution plan for derived monthly savings (ADR 0041). */
  contributionPlan?: ContributionPlan | null;
  unitPriceMajorByHoldingId?: Record<string, string>;
}

export function goalFireDelay(input: GoalFireDelayInput): GoalFireDelay {
  const { context, goal, otherReservationsMinor, thisGoalReservationMinor, now } = input;
  const { config, eligibleGrossMinor, fireNumberMinor } = context;

  // ── Unified horizon: same source of truth as countsTowardFire / totalGoalReservationMinor
  const horizon = fireReservationHorizon(config, now);

  // no_effect: no horizon (no currentAge) → can't determine reservation window
  if (horizon === undefined) {
    return { kind: "no_effect" };
  }

  // no_effect: past deadline → reservation already released
  if (goal.deadline < now) {
    return { kind: "no_effect" };
  }

  // no_effect: deadline ≥ horizon → goal is out-of-horizon, not reserved
  if (goal.deadline >= horizon) {
    return { kind: "no_effect" };
  }

  // no_effect: zero in-horizon reservation → no capital impact on FIRE
  if (thisGoalReservationMinor <= 0) {
    return { kind: "no_effect" };
  }

  // ── Project twice on the base scenario ───────────────────────────────────
  const monthlyContribution = resolveMonthlySavingsCapacityForFire(
    input.contributionPlan,
    config,
    now,
    input.unitPriceMajorByHoldingId,
  ).capacityMinor;

  // WITHOUT this goal: gross − other reservations
  const startingWithout = Math.max(0, eligibleGrossMinor - otherReservationsMinor);
  // WITH this goal: gross − other reservations − this goal's in-horizon reservation
  const startingWith = Math.max(0, startingWithout - thisGoalReservationMinor);

  // #1026/#1122: rate, FIRE number and age all ride in the context and the
  // projection runs through the single door, so this delta stays coherent with
  // coast + the main projection chart by construction.
  const baseWithout = projectFireFromContext(context, {
    monthlyContributionMinor: monthlyContribution,
    startingEligibleMinor: startingWithout,
  }).scenarios.find((s) => s.label === "base")!;

  const baseWith = projectFireFromContext(context, {
    monthlyContributionMinor: monthlyContribution,
    startingEligibleMinor: startingWith,
  }).scenarios.find((s) => s.label === "base")!;

  // ── Interpolate fractional fire years ────────────────────────────────────
  const fracWithout = fractionalFireYear(
    baseWithout.trajectory,
    fireNumberMinor,
    baseWithout.yearsToFire,
  );
  const fracWith = fractionalFireYear(
    baseWith.trajectory,
    fireNumberMinor,
    baseWith.yearsToFire,
  );

  // Both never reach FIRE → can't compute a meaningful delta.
  if (fracWithout === null && fracWith === null) {
    return { kind: "no_effect" };
  }

  // ponytail: caps the never-reaches case at DEFAULT_MAX_YEARS; upgrade to a
  // per-scope horizon ceiling if surfacing a misleading max-years delay matters.
  const resolvedFracWithout = fracWithout ?? DEFAULT_MAX_YEARS;
  const resolvedFracWith = fracWith ?? DEFAULT_MAX_YEARS;

  const months = Math.round((resolvedFracWith - resolvedFracWithout) * 12);

  // Clamp to 0 — rounding can produce -0 in degenerate cases.
  return { kind: "delays", months: Math.max(0, months) };
}
