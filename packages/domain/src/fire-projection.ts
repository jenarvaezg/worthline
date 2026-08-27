/**
 * FIRE projection engine (PRD #421, #427): a pure compound-growth model that
 * answers "when do I reach FIRE?" under optimistic, base and pessimistic
 * scenarios. Deterministic and DB-free — easy to unit-test and fast to call.
 *
 * El escalar es **un cubo** del stepper compartido (`stepFireGrowth`, #1597): el
 * capital crece por el retorno real del escenario y la aportación anual
 * (12 × capacidad mensual) entra a final de año. El modo plan y la familia son ese
 * mismo paso con otros insumos, así que ya no hay dos bucles que mantener a la par.
 * Se avanza año a año en vez de resolver en cerrado porque la trayectoria ES lo que
 * pinta el gráfico, y así un retorno real cero o negativo no divide por cero.
 */

import type { FireGrowthRun, FireTrajectoryPoint } from "./fire-stepper";
import { AGGREGATE_BUCKET_ID, runFireGrowth } from "./fire-stepper";

/** Returns shifted from the base by ±1.5 % (PRD #421). Shared with the plan engine. */
export const RETURN_SHIFT = 0.015;
export const DEFAULT_MAX_YEARS = 60;

export type { FireTrajectoryPoint } from "./fire-stepper";

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

export interface FireProjectionFamilyInput extends FireProjectionInput {
  /** Keep growing until this target (Fat) even after crossing `fireNumberMinor`. */
  horizonTargetMinor: number;
}

export interface FireProjectionFamily {
  /** Trajectory sliced to the regular FIRE number — the chart payload. */
  chart: FireProjection;
  /** Trajectory tall enough to cross the horizon target — the level rail. */
  rail: FireProjection;
}

/**
 * One growth loop per scenario, two views (#1537): the chart stops at the
 * regular FIRE number (byte-identical to `projectFire`), while the rail keeps
 * going until Fat so Lean/Regular/Fat interpolate on the same path.
 */
export function projectFireFamily(
  input: FireProjectionFamilyInput,
): FireProjectionFamily {
  const pairs = (
    [
      ["optimistic", input.expectedRealReturn + RETURN_SHIFT],
      ["base", input.expectedRealReturn],
      ["pessimistic", input.expectedRealReturn - RETURN_SHIFT],
    ] as const
  ).map(([label, annualReturn]) => projectScenarioPair(label, annualReturn, input));

  return {
    chart: {
      fireNumberMinor: input.fireNumberMinor,
      scenarios: pairs.map((pair) => pair.chart),
    },
    rail: {
      fireNumberMinor: input.horizonTargetMinor,
      scenarios: pairs.map((pair) => pair.rail),
    },
  };
}

/** Scalar FIRE projection: the family chart sliced to the regular FIRE number. */
export function projectFire(input: FireProjectionInput): FireProjection {
  return projectFireFamily({
    ...input,
    horizonTargetMinor: input.fireNumberMinor,
  }).chart;
}

/**
 * El escalar como un cubo del stepper (#1597), con las dos dianas de la familia
 * cronometradas sobre la MISMA corrida: el gráfico se corta en el número FIRE y el
 * rail sigue hasta el horizonte, pero la trayectoria es una sola.
 */
function projectScenarioPair(
  label: FireScenarioLabel,
  annualReturn: number,
  input: FireProjectionFamilyInput,
): { chart: FireScenario; rail: FireScenario } {
  const maxYears = input.maxYears ?? DEFAULT_MAX_YEARS;
  const annualContribution = new Map([
    [AGGREGATE_BUCKET_ID, input.monthlyContributionMinor * 12],
  ]);

  const run = runFireGrowth({
    annualRateFor: () => annualReturn,
    contributionsForYear: () => annualContribution,
    maxYears,
    startingBucketsMinor: new Map([[AGGREGATE_BUCKET_ID, input.startingEligibleMinor]]),
    targetsMinor: { fire: input.fireNumberMinor, horizon: input.horizonTargetMinor },
  });

  const scenario = (target: "fire" | "horizon") =>
    scenarioFromRun({
      annualReturn,
      label,
      maxYears,
      run,
      target,
      ...(input.currentAge === undefined ? {} : { currentAge: input.currentAge }),
    });

  return { chart: scenario("fire"), rail: scenario("horizon") };
}

/**
 * Una diana de una corrida del stepper, leída como escenario. Compartida por el
 * escalar/familia y por el motor de plan (#1597): el recorte de la trayectoria, el
 * aportado acumulado y la edad de llegada se calculan una vez, así que dos modos no
 * pueden discrepar sobre qué significa «llegar».
 */
export function scenarioFromRun<TargetKey extends string>(input: {
  label: FireScenarioLabel;
  annualReturn: number;
  run: FireGrowthRun<TargetKey>;
  /** Cuál de las dianas de la corrida lee este escenario. */
  target: TargetKey;
  maxYears: number;
  currentAge?: number;
}): FireScenario {
  const { annualReturn, label, maxYears, run } = input;
  const yearsToTarget = run.yearsToTarget[input.target];
  const sliced =
    yearsToTarget === 0
      ? run.trajectory.slice(0, 1)
      : yearsToTarget === null
        ? run.trajectory
        : run.trajectory.slice(0, yearsToTarget + 1);
  const reachedYear = yearsToTarget ?? maxYears;

  return {
    ageAtFire:
      yearsToTarget !== null && input.currentAge !== undefined
        ? input.currentAge + yearsToTarget
        : null,
    annualReturn,
    finalEligibleMinor: sliced.at(-1)!.eligibleMinor,
    label,
    totalContributedMinor:
      run.contributedThroughYearMinor[reachedYear] ??
      run.contributedThroughYearMinor.at(-1)!,
    trajectory: sliced,
    yearsToFire: yearsToTarget,
  };
}

/** First whole year the (rounded) trajectory is at or above `target`; null if never. */
export function yearsUntilTarget(
  trajectory: readonly { year: number; eligibleMinor: number }[],
  target: number,
): number | null {
  for (const point of trajectory) {
    if (point.eligibleMinor >= target) {
      return point.year;
    }
  }
  return null;
}
