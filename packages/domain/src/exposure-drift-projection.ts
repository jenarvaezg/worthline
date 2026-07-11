/**
 * Exposure-drift what-if (PRD #553 tie-in #560, ADR 0041): projects the
 * portfolio's look-through geography/asset-class composition forward under a
 * contribution plan and growth assumption. Reuses #539 look-through on
 * simulated per-holding values and S4's time-varying contribution stream.
 */

import {
  type ContributionOccurrence,
  type ContributionPlan,
  contributionOccurrenceMoneyMinor,
  expandContributionPlan,
} from "./contribution-plan";
import {
  type ExposureDimensionResult,
  type ExposureLookthrough,
  type ExposureLookthroughHolding,
  type ExposureProfile,
  lookThroughExposure,
} from "./exposure-lookthrough";
import type { FireGrowthAssumption } from "./fire-plan-projection";
import { DEFAULT_MAX_YEARS } from "./fire-projection";
import type { CurrencyCode, MoneyMinor } from "./money";

export interface ExposureDriftPoint {
  year: number;
  grossAssets: MoneyMinor;
  geography: ExposureDimensionResult;
  assetClass: ExposureDimensionResult;
}

export interface ExposureDriftProjection {
  growthAssumption: FireGrowthAssumption;
  trajectory: ExposureDriftPoint[];
}

export interface ExposureDriftProjectionInput {
  todayISO: string;
  baseCurrency: CurrencyCode;
  plan: ContributionPlan;
  growthAssumption: FireGrowthAssumption;
  assumedAnnualReturn: number;
  holdingAnnualReturnById?: Record<string, number>;
  unitPriceMajorByHoldingId?: Record<string, string>;
  holdings: readonly ExposureLookthroughHolding[];
  profiles: ReadonlyMap<string, ExposureProfile>;
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

function projectionYearForDate(todayISO: string, plannedDate: string): number {
  if (plannedDate < todayISO) {
    return -1;
  }
  return Math.floor(monthsBetween(todayISO, plannedDate) / 12) + 1;
}

function bucketGrowthRate(
  holdingId: string,
  input: ExposureDriftProjectionInput,
): number {
  if (input.growthAssumption === "flat") {
    return 0;
  }
  return input.holdingAnnualReturnById?.[holdingId] ?? input.assumedAnnualReturn;
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

function initialBuckets(
  holdings: readonly ExposureLookthroughHolding[],
): Map<string, number> {
  const buckets = new Map<string, number>();
  for (const holding of holdings) {
    if (holding.valueMinor > 0) {
      buckets.set(holding.id, holding.valueMinor);
    }
  }
  return buckets;
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
  input: ExposureDriftProjectionInput,
): void {
  for (const [holdingId, amount] of [...buckets.entries()]) {
    const rate = bucketGrowthRate(holdingId, input);
    buckets.set(holdingId, amount * (1 + rate));
  }
}

function addContributions(
  buckets: Map<string, number>,
  contributions: Map<string, number> | undefined,
): void {
  if (contributions === undefined) {
    return;
  }
  for (const [holdingId, amountMinor] of contributions.entries()) {
    buckets.set(holdingId, (buckets.get(holdingId) ?? 0) + amountMinor);
  }
}

function lookthroughAtBuckets(
  buckets: Map<string, number>,
  metaById: Map<string, ExposureLookthroughHolding>,
  input: ExposureDriftProjectionInput,
): ExposureLookthrough {
  const holdings: ExposureLookthroughHolding[] = [];
  for (const [holdingId, valueMinor] of buckets.entries()) {
    const meta = metaById.get(holdingId);
    if (!meta || valueMinor <= 0) {
      continue;
    }
    holdings.push({ ...meta, valueMinor });
  }

  const grossMinor = totalBucketMinor(buckets);
  return lookThroughExposure({
    baseCurrency: input.baseCurrency,
    grossAssets: { amountMinor: grossMinor, currency: input.baseCurrency },
    holdings,
    profiles: input.profiles,
  });
}

function toPoint(
  year: number,
  lookthrough: ExposureLookthrough,
  currency: CurrencyCode,
): ExposureDriftPoint {
  return {
    year,
    grossAssets: {
      amountMinor:
        lookthrough.geography.coverage.classified.amountMinor +
        lookthrough.geography.coverage.notApplicable.amountMinor +
        lookthrough.geography.coverage.unknown.amountMinor,
      currency,
    },
    geography: lookthrough.geography,
    assetClass: lookthrough.assetClass,
  };
}

/**
 * Projects geography and asset-class look-through forward under a contribution
 * plan. Year 0 is today's composition; each subsequent year applies one round
 * of growth (per the toggle) plus that year's planned contributions.
 */
export function projectExposureDrift(
  input: ExposureDriftProjectionInput,
): ExposureDriftProjection {
  const maxYears = input.maxYears ?? DEFAULT_MAX_YEARS;
  const metaById = new Map(input.holdings.map((holding) => [holding.id, holding]));

  if (input.holdings.length === 0) {
    return { growthAssumption: input.growthAssumption, trajectory: [] };
  }

  const buckets = initialBuckets(input.holdings);
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

  const trajectory: ExposureDriftPoint[] = [
    toPoint(0, lookthroughAtBuckets(buckets, metaById, input), input.baseCurrency),
  ];

  for (let year = 1; year <= maxYears; year += 1) {
    growBuckets(buckets, input);
    addContributions(buckets, contributionsByYear.get(year));
    trajectory.push(
      toPoint(year, lookthroughAtBuckets(buckets, metaById, input), input.baseCurrency),
    );
  }

  return { growthAssumption: input.growthAssumption, trajectory };
}
