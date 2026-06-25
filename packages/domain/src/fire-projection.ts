/**
 * FIRE projection engine (PRD #421, #427): a pure compound-growth model that
 * answers "when do I reach FIRE?" under optimistic, base and pessimistic
 * scenarios. Deterministic and DB-free — easy to unit-test and fast to call.
 *
 * The model steps once per year: capital grows by the scenario's real return
 * and the annual contribution (12 × monthly capacity) is added at year end.
 * Stepping year-by-year (rather than a closed-form solve) is what produces the
 * year-by-year trajectory the dashboard renders, and it handles a zero or
 * negative real return without a divide-by-zero.
 */

/** Returns shifted from the base by ±1.5 % (PRD #421). */
const RETURN_SHIFT = 0.015;
export const DEFAULT_MAX_YEARS = 60;

export type FireScenarioLabel = "optimistic" | "base" | "pessimistic";

export interface FireProjectionInput {
  /**
   * Eligible assets today, in minor units, ALREADY net of any capital reserved
   * for goals (PRD #426). The engine projects whatever it is handed.
   */
  startingEligibleMinor: number;
  /** Monthly savings capacity in minor units (PRD #425); 0 means no contributions. */
  monthlyContributionMinor: number;
  /** Base annual real return (e.g. 0.05). Scenarios shift this by ±1.5 %. */
  expectedRealReturn: number;
  /** The FIRE target in minor units (`12 × monthlySpending / safeWithdrawalRate`). */
  fireNumberMinor: number;
  /** Reference age for `ageAtFire`; omitted → age fields are null. */
  currentAge?: number;
  /** Cap on the projection horizon in years (default 60). */
  maxYears?: number;
}

export interface FireTrajectoryPoint {
  year: number;
  eligibleMinor: number;
}

export interface FireScenario {
  label: FireScenarioLabel;
  annualReturn: number;
  /** Whole years until eligible assets first reach the FIRE number; null if never within the horizon. */
  yearsToFire: number | null;
  /** `currentAge + yearsToFire` when both are known; otherwise null. */
  ageAtFire: number | null;
  /** Eligible assets at the FIRE year (or at the horizon when never reached). */
  finalEligibleMinor: number;
  /** Contributions made up to that point. */
  totalContributedMinor: number;
  /** One point per year, year 0 (today) through the FIRE year or the horizon. */
  trajectory: FireTrajectoryPoint[];
}

export interface FireProjection {
  fireNumberMinor: number;
  /** Always `[optimistic, base, pessimistic]`. */
  scenarios: FireScenario[];
}

function projectScenario(
  label: FireScenarioLabel,
  annualReturn: number,
  input: FireProjectionInput,
): FireScenario {
  const maxYears = input.maxYears ?? DEFAULT_MAX_YEARS;
  const annualContributionMinor = input.monthlyContributionMinor * 12;
  const target = input.fireNumberMinor;

  const trajectory: FireTrajectoryPoint[] = [
    { year: 0, eligibleMinor: input.startingEligibleMinor },
  ];
  let capital = input.startingEligibleMinor;
  let yearsToFire: number | null = capital >= target ? 0 : null;

  // Only grow forward while still short of the target; an already-funded scope
  // has nothing to project, so its trajectory is just today.
  if (yearsToFire === null) {
    for (let year = 1; year <= maxYears; year += 1) {
      capital = capital * (1 + annualReturn) + annualContributionMinor;
      trajectory.push({ year, eligibleMinor: Math.round(capital) });

      if (capital >= target) {
        yearsToFire = year;
        break;
      }
    }
  }

  const reachedYear = yearsToFire ?? maxYears;
  const ageAtFire =
    yearsToFire !== null && input.currentAge !== undefined
      ? input.currentAge + yearsToFire
      : null;

  return {
    label,
    annualReturn,
    yearsToFire,
    ageAtFire,
    finalEligibleMinor: trajectory.at(-1)!.eligibleMinor,
    totalContributedMinor: annualContributionMinor * reachedYear,
    trajectory,
  };
}

/**
 * Linearly interpolates the fractional year at which `trajectory` crosses
 * `target`. Returns `null` when the trajectory never reaches the target.
 * Handles `yearsToFire === 0` (already FI) by returning 0.
 *
 * Shared by `goalFireDelay` and `fireLevels` — both consumers need coherent ETAs.
 */
export function fractionalFireYear(
  trajectory: { year: number; eligibleMinor: number }[],
  target: number,
  yearsToFire: number | null,
): number | null {
  if (yearsToFire === null) return null;
  if (yearsToFire === 0) return 0;

  for (let i = 1; i < trajectory.length; i++) {
    const prev = trajectory[i - 1]!;
    const curr = trajectory[i]!;
    if (curr.eligibleMinor >= target) {
      if (curr.eligibleMinor === prev.eligibleMinor) {
        return prev.year;
      }
      const fraction =
        (target - prev.eligibleMinor) / (curr.eligibleMinor - prev.eligibleMinor);
      return prev.year + fraction;
    }
  }

  // Unreachable when yearsToFire is non-null (the loop always returns first).
  return null;
}

export function projectFire(input: FireProjectionInput): FireProjection {
  return {
    fireNumberMinor: input.fireNumberMinor,
    scenarios: [
      projectScenario("optimistic", input.expectedRealReturn + RETURN_SHIFT, input),
      projectScenario("base", input.expectedRealReturn, input),
      projectScenario("pessimistic", input.expectedRealReturn - RETURN_SHIFT, input),
    ],
  };
}
