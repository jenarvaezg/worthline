/**
 * FIRE what-if projection (PRD #553 S4, ADR 0041): extends `projectFire` with a
 * contribution plan's time-varying occurrence stream and a growth-assumption
 * toggle — flat (no appreciation) vs historical (per-holding return from #547,
 * falling back to an assumed rate).
 */

import {
  type ContributionOccurrence,
  type ContributionPlan,
  contributionOccurrenceMoneyMinor,
  expandContributionPlan,
} from "./contribution-plan";
import {
  DEFAULT_MAX_YEARS,
  type FireProjection,
  type FireScenario,
  type FireScenarioLabel,
  type FireTrajectoryPoint,
  projectFire,
} from "./fire-projection";

/** Returns shifted from the base by ±1.5 % (PRD #421) — same as `projectFire`. */
const RETURN_SHIFT = 0.015;

/**
 * Synthetic bucket for aggregate starting eligible when no per-holding split is
 * supplied. Namespaced to avoid colliding with real holding ids.
 */
const STARTING_BUCKET_ID = "@worthline/starting-eligible";

export type FireGrowthAssumption = "flat" | "historical";

export interface FirePlanProjectionInput {
  startingEligibleMinor: number;
  expectedRealReturn: number;
  fireNumberMinor: number;
  todayISO: string;
  plan: ContributionPlan;
  growthAssumption: FireGrowthAssumption;
  /** Fallback annual return when a holding lacks #547 history. */
  assumedAnnualReturn: number;
  /** Pre-resolved annual returns per holding id (TWR/IRR/CAGR from #547). */
  holdingAnnualReturnById?: Record<string, number>;
  /** Optional split of today's eligible assets across holdings. */
  startingEligibleByHoldingId?: Record<string, number>;
  unitPriceMajorByHoldingId?: Record<string, string>;
  currentAge?: number;
  maxYears?: number;
}

function parseISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

function addYears(iso: string, years: number): string {
  const date = parseISO(iso);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

function monthsBetween(fromISO: string, toISO: string): number {
  const from = parseISO(fromISO);
  const to = parseISO(toISO);
  return (
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth())
  );
}

/** 1-based projection year for an occurrence on or after `todayISO`. */
function projectionYearForDate(todayISO: string, plannedDate: string): number {
  if (plannedDate < todayISO) {
    return -1;
  }
  return Math.floor(monthsBetween(todayISO, plannedDate) / 12) + 1;
}

function bucketGrowthRate(holdingId: string, input: FirePlanProjectionInput): number {
  if (input.growthAssumption === "flat") {
    return 0;
  }
  if (holdingId === STARTING_BUCKET_ID) {
    return input.assumedAnnualReturn;
  }
  return input.holdingAnnualReturnById?.[holdingId] ?? input.assumedAnnualReturn;
}

function initialBuckets(input: FirePlanProjectionInput): Map<string, number> {
  const buckets = new Map<string, number>();
  const split = input.startingEligibleByHoldingId;
  if (split !== undefined && Object.keys(split).length > 0) {
    for (const [holdingId, amountMinor] of Object.entries(split)) {
      if (amountMinor > 0) {
        buckets.set(holdingId, amountMinor);
      }
    }
    return buckets;
  }
  if (input.startingEligibleMinor > 0) {
    buckets.set(STARTING_BUCKET_ID, input.startingEligibleMinor);
  }
  return buckets;
}

function contributionsByProjectionYear(
  occurrences: Array<ContributionOccurrence & { moneyMinor: number }>,
  todayISO: string,
  maxYears: number,
): Map<number, Map<string, number>> {
  const byYear = new Map<number, Map<string, number>>();
  for (const occurrence of occurrences) {
    const year = projectionYearForDate(todayISO, occurrence.plannedDate);
    if (year < 1 || year > maxYears) {
      continue;
    }
    const holdingBuckets = byYear.get(year) ?? new Map<string, number>();
    const current = holdingBuckets.get(occurrence.destinationHoldingId) ?? 0;
    holdingBuckets.set(occurrence.destinationHoldingId, current + occurrence.moneyMinor);
    byYear.set(year, holdingBuckets);
  }
  return byYear;
}

function expandOccurrencesWithMoney(
  plan: ContributionPlan,
  todayISO: string,
  maxYears: number,
  unitPriceMajorByHoldingId?: Record<string, string>,
): Array<ContributionOccurrence & { moneyMinor: number }> {
  const toDate = addYears(todayISO, maxYears);
  const occurrences = expandContributionPlan(plan, todayISO, toDate);
  const priced: Array<ContributionOccurrence & { moneyMinor: number }> = [];
  for (const occurrence of occurrences) {
    const moneyMinor = contributionOccurrenceMoneyMinor(
      occurrence,
      unitPriceMajorByHoldingId,
    );
    if (moneyMinor === null) {
      continue;
    }
    priced.push({ ...occurrence, moneyMinor });
  }
  return priced;
}

/**
 * Shared contribution-stream seam: expand a plan into priced money bucketed by
 * 1-based projection year and destination holding. Both this FIRE what-if and
 * the exposure-drift what-if (#560) grow per-holding buckets over the same
 * stream, so the expansion + year-bucketing lives here once. Unpriced units
 * occurrences (no destination price) are dropped, as in `projectFire*`.
 */
export function contributionMoneyByProjectionYear(
  plan: ContributionPlan,
  todayISO: string,
  maxYears: number,
  unitPriceMajorByHoldingId?: Record<string, string>,
): Map<number, Map<string, number>> {
  return contributionsByProjectionYear(
    expandOccurrencesWithMoney(plan, todayISO, maxYears, unitPriceMajorByHoldingId),
    todayISO,
    maxYears,
  );
}

function totalBucketMinor(buckets: Map<string, number>): number {
  let total = 0;
  for (const amount of buckets.values()) {
    total += amount;
  }
  return total;
}

function growBuckets(
  buckets: Map<string, number>,
  input: FirePlanProjectionInput,
  scenarioShift: number,
): void {
  const effectiveShift = input.growthAssumption === "flat" ? 0 : scenarioShift;
  for (const [holdingId, amount] of [...buckets.entries()]) {
    const rate = bucketGrowthRate(holdingId, input) + effectiveShift;
    buckets.set(holdingId, amount * (1 + rate));
  }
}

function addContributions(
  buckets: Map<string, number>,
  contributions: Map<string, number> | undefined,
): number {
  if (contributions === undefined) {
    return 0;
  }
  let added = 0;
  for (const [holdingId, amountMinor] of contributions.entries()) {
    buckets.set(holdingId, (buckets.get(holdingId) ?? 0) + amountMinor);
    added += amountMinor;
  }
  return added;
}

function projectPlanScenario(
  label: FireScenarioLabel,
  scenarioShift: number,
  input: FirePlanProjectionInput,
  contributionsByYear: Map<number, Map<string, number>>,
): FireScenario {
  const maxYears = input.maxYears ?? DEFAULT_MAX_YEARS;
  const target = input.fireNumberMinor;
  const buckets = initialBuckets(input);

  const trajectory: FireTrajectoryPoint[] = [
    { year: 0, eligibleMinor: Math.round(totalBucketMinor(buckets)) },
  ];
  let capital = totalBucketMinor(buckets);
  let yearsToFire: number | null = capital >= target ? 0 : null;
  let totalContributedMinor = 0;

  if (yearsToFire === null) {
    for (let year = 1; year <= maxYears; year += 1) {
      growBuckets(buckets, input, scenarioShift);
      totalContributedMinor += addContributions(buckets, contributionsByYear.get(year));
      capital = totalBucketMinor(buckets);
      trajectory.push({ year, eligibleMinor: Math.round(capital) });

      if (capital >= target) {
        yearsToFire = year;
        break;
      }
    }
  }

  const baseReturn = input.growthAssumption === "flat" ? 0 : input.expectedRealReturn;
  const reportedReturn =
    input.growthAssumption === "flat" ? 0 : baseReturn + scenarioShift;
  const ageAtFire =
    yearsToFire !== null && input.currentAge !== undefined
      ? input.currentAge + yearsToFire
      : null;

  return {
    label,
    annualReturn: reportedReturn,
    yearsToFire,
    ageAtFire,
    finalEligibleMinor: trajectory.at(-1)!.eligibleMinor,
    totalContributedMinor,
    trajectory,
  };
}

function projectPlanScenarios(
  input: FirePlanProjectionInput,
  contributionsByYear: Map<number, Map<string, number>>,
): FireScenario[] {
  if (input.growthAssumption === "flat") {
    const scenario = projectPlanScenario("base", 0, input, contributionsByYear);
    return [
      { ...scenario, label: "optimistic" },
      scenario,
      { ...scenario, label: "pessimistic" },
    ];
  }

  return [
    projectPlanScenario("optimistic", RETURN_SHIFT, input, contributionsByYear),
    projectPlanScenario("base", 0, input, contributionsByYear),
    projectPlanScenario("pessimistic", -RETURN_SHIFT, input, contributionsByYear),
  ];
}

function hasPerHoldingStartingSplit(input: FirePlanProjectionInput): boolean {
  const split = input.startingEligibleByHoldingId;
  return split !== undefined && Object.keys(split).length > 0;
}

/**
 * Projects FIRE under a contribution plan's time-varying stream and a
 * growth-assumption toggle. When the plan is a constant monthly equivalent and
 * historical growth resolves every bucket to `assumedAnnualReturn`, the base
 * scenario matches `projectFire`.
 */
export function projectFireWithContributionPlan(
  input: FirePlanProjectionInput,
): FireProjection {
  const maxYears = input.maxYears ?? DEFAULT_MAX_YEARS;

  if (input.plan.contributions.length === 0) {
    if (input.growthAssumption === "historical" && hasPerHoldingStartingSplit(input)) {
      return {
        fireNumberMinor: input.fireNumberMinor,
        scenarios: projectPlanScenarios(input, new Map()),
      };
    }

    return projectFire({
      startingEligibleMinor: input.startingEligibleMinor,
      monthlyContributionMinor: 0,
      expectedRealReturn:
        input.growthAssumption === "flat" ? 0 : input.expectedRealReturn,
      fireNumberMinor: input.fireNumberMinor,
      ...(input.currentAge === undefined ? {} : { currentAge: input.currentAge }),
      maxYears,
    });
  }

  const contributionsByYear = contributionMoneyByProjectionYear(
    input.plan,
    input.todayISO,
    maxYears,
    input.unitPriceMajorByHoldingId,
  );

  return {
    fireNumberMinor: input.fireNumberMinor,
    scenarios: projectPlanScenarios(input, contributionsByYear),
  };
}
