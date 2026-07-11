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
import type { HoldingReturnsView } from "./returns-display";

/** Returns shifted from the base by ±1.5 % (PRD #421) — same as `projectFire`. */
const RETURN_SHIFT = 0.015;

/** Synthetic bucket for starting eligible when no per-holding split is supplied. */
const STARTING_BUCKET_ID = "__starting__";

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

/**
 * Resolves one holding's annual return for the what-if historical branch:
 * TWR annualized rate → IRR → CAGR → assumed fallback (#547, ADR 0041).
 */
export function resolveHoldingAnnualReturnForProjection(
  view: HoldingReturnsView | null | undefined,
  assumedAnnualReturn: number,
): number {
  if (view === null || view === undefined) {
    return assumedAnnualReturn;
  }
  if (view.twr?.annualizedRate !== null && view.twr?.annualizedRate !== undefined) {
    return view.twr.annualizedRate;
  }
  if (view.irr?.rate !== null && view.irr?.rate !== undefined) {
    return view.irr.rate;
  }
  if (view.annualized && view.cagr !== null) {
    return view.cagr;
  }
  return assumedAnnualReturn;
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
    return input.expectedRealReturn;
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
    holdingBuckets.set(
      occurrence.destinationHoldingId,
      current + (occurrence.moneyMinor ?? 0),
    );
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
  for (const [holdingId, amount] of [...buckets.entries()]) {
    const rate = bucketGrowthRate(holdingId, input) + scenarioShift;
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
  let yearsToFire: number | null = trajectory[0]!.eligibleMinor >= target ? 0 : null;
  let totalContributedMinor = 0;

  if (yearsToFire === null) {
    for (let year = 1; year <= maxYears; year += 1) {
      growBuckets(buckets, input, scenarioShift);
      totalContributedMinor += addContributions(buckets, contributionsByYear.get(year));
      const eligibleMinor = Math.round(totalBucketMinor(buckets));
      trajectory.push({ year, eligibleMinor });

      if (eligibleMinor >= target) {
        yearsToFire = year;
        break;
      }
    }
  }

  const baseReturn = input.growthAssumption === "flat" ? 0 : input.expectedRealReturn;
  const ageAtFire =
    yearsToFire !== null && input.currentAge !== undefined
      ? input.currentAge + yearsToFire
      : null;

  return {
    label,
    annualReturn: baseReturn + scenarioShift,
    yearsToFire,
    ageAtFire,
    finalEligibleMinor: trajectory.at(-1)!.eligibleMinor,
    totalContributedMinor,
    trajectory,
  };
}

/**
 * Projects FIRE under a contribution plan's time-varying stream and a
 * growth-assumption toggle. When the plan is a constant monthly equivalent and
 * historical growth resolves every bucket to `expectedRealReturn`, the base
 * scenario matches `projectFire`.
 */
export function projectFireWithContributionPlan(
  input: FirePlanProjectionInput,
): FireProjection {
  const maxYears = input.maxYears ?? DEFAULT_MAX_YEARS;

  if (input.plan.contributions.length === 0) {
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

  const pricedOccurrences = expandOccurrencesWithMoney(
    input.plan,
    input.todayISO,
    maxYears,
    input.unitPriceMajorByHoldingId,
  );
  const contributionsByYear = contributionsByProjectionYear(
    pricedOccurrences,
    input.todayISO,
    maxYears,
  );

  return {
    fireNumberMinor: input.fireNumberMinor,
    scenarios: [
      projectPlanScenario("optimistic", RETURN_SHIFT, input, contributionsByYear),
      projectPlanScenario("base", 0, input, contributionsByYear),
      projectPlanScenario("pessimistic", -RETURN_SHIFT, input, contributionsByYear),
    ],
  };
}
