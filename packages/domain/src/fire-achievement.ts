import type { SavingsCoherence } from "./savings-coherence";

/**
 * The FIRE achievement badge (#1449) — the one place that decides whether
 * "FIRE alcanzado" / "Coast FIRE alcanzado" may appear, and whether it appears
 * as a claim or as a caveat.
 *
 * It exists because the badge is a *claim about the future* made from a snapshot
 * of the present: percent funded and coast both project forward on a savings
 * figure the user typed. When the ledger measures a negative habit, the real
 * trajectory goes the other way — a flat rented out for 1.000 €/month does not
 * bring someone who dis-saves 100 €/month closer to FIRE. The badge is not
 * removed (the capital really is there, on paper) but it must say so instead of
 * congratulating: it is shown attenuated with its reason, which is the honest
 * option of the two the ticket weighed.
 *
 * Both screens that draw the badge (home glance, /objetivos hero) read this, so
 * the veto cannot be enforced in one and forgotten in the other.
 */
export type FireAchievementLevel = "fire" | "coast";

export interface FireAchievement {
  /** The badge to draw, or null when there is nothing to celebrate yet. */
  level: FireAchievementLevel | null;
  /** True when the badge must be drawn attenuated, with its reason (#1449). */
  vetoed: boolean;
  /** The measured monthly savings behind the veto (minor, signed); null when not vetoed. */
  measuredMonthlySavingsMinor: number | null;
  /** Months of ledger the veto's measurement covers; null when not vetoed. */
  measuredMonths: number | null;
}

export interface FireAchievementInput {
  /** `FireResult.percentFunded` — 100 or over is FIRE. */
  percentFunded: number;
  isAlreadyAtCoastFire?: boolean;
  /** The scope's declared-vs-measured savings reading; absent = nothing to veto with. */
  coherence?: SavingsCoherence | undefined;
}

export function fireAchievement(input: FireAchievementInput): FireAchievement {
  const level: FireAchievementLevel | null =
    input.percentFunded >= 100 ? "fire" : input.isAlreadyAtCoastFire ? "coast" : null;

  const vetoed = level !== null && input.coherence?.vetoesAchievement === true;

  return {
    level,
    measuredMonthlySavingsMinor: vetoed ? (input.coherence?.measuredMinor ?? null) : null,
    measuredMonths: vetoed ? (input.coherence?.measured.monthsCovered ?? null) : null,
    vetoed,
  };
}
