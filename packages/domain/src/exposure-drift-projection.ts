/**
 * Exposure-drift what-if (PRD #553 tie-in #560, ADR 0041): projects the
 * portfolio's look-through geography/asset-class composition forward under a
 * contribution plan and growth assumption. Reuses #539 look-through on
 * simulated per-holding values and S4's time-varying contribution stream.
 */

import { instrumentOfAsset } from "./classification";
import type { ContributionPlan } from "./contribution-plan";
import {
  type ExposureDimensionResult,
  type ExposureLookthrough,
  type ExposureLookthroughHolding,
  type ExposureProfile,
  lookThroughExposure,
} from "./exposure-lookthrough";
import {
  contributionMoneyByProjectionYear,
  type FireGrowthAssumption,
} from "./fire-plan-projection";
import { DEFAULT_MAX_YEARS } from "./fire-projection";
import type { Instrument } from "./instrument-catalog";
import type { CurrencyCode, MoneyMinor } from "./money";
import { projectPortfolio } from "./portfolio-projection";
import type { HoldingReturnsView } from "./returns-display";
import { resolveHoldingAnnualReturnForProjection } from "./returns-display";
import type { ScopeOption } from "./scope";
import type { Liability, ManualAsset, Workspace } from "./workspace-types";

export interface ExposureDriftHoldingMeta {
  id: string;
  isin?: string | null;
  providerSymbol?: string | null;
}

export interface AssembleExposureDriftHoldingsInput {
  baseCurrency: CurrencyCode;
  workspace: Workspace;
  scope: ScopeOption;
  assets: ManualAsset[];
  liabilities: Liability[];
  investmentMeta: readonly ExposureDriftHoldingMeta[];
  exposureProfiles: readonly ExposureProfile[];
  plan: ContributionPlan;
}

export interface AssembleExposureDriftHoldingsResult {
  holdings: ExposureLookthroughHolding[];
  profiles: Map<string, ExposureProfile>;
}

/**
 * Shared seam for exposure-drift what-if (#560, #946): scope-weighted holdings
 * from today's portfolio plus zero-value plan destinations, keyed exposure
 * profiles — consumed by /objetivos and the agent-view MCP surface before
 * `projectExposureDrift`.
 */
export function assembleExposureDriftHoldings(
  input: AssembleExposureDriftHoldingsInput,
): AssembleExposureDriftHoldingsResult {
  const portfolio = projectPortfolio({
    workspace: input.workspace,
    scope: input.scope,
    assets: input.assets,
    liabilities: input.liabilities,
  });
  const metaByAssetId = new Map(input.investmentMeta.map((row) => [row.id, row]));
  const profileMap = new Map(
    input.exposureProfiles.map((profile) => [profile.key, profile]),
  );
  const assetById = new Map(input.assets.map((asset) => [asset.id, asset]));

  const holdings: ExposureLookthroughHolding[] = portfolio.sections[0].rows.map(
    (row) => ({
      currency: input.baseCurrency,
      geography: null,
      id: row.id,
      instrument: row.instrument as Instrument,
      isin: metaByAssetId.get(row.id)?.isin ?? null,
      providerSymbol: metaByAssetId.get(row.id)?.providerSymbol ?? null,
      valueMinor: row.valueMinor,
    }),
  );

  for (const contribution of input.plan.contributions) {
    if (holdings.some((holding) => holding.id === contribution.destinationHoldingId)) {
      continue;
    }
    const asset = assetById.get(contribution.destinationHoldingId);
    if (!asset) {
      continue;
    }
    const meta = metaByAssetId.get(asset.id);
    holdings.push({
      currency: input.baseCurrency,
      geography: null,
      id: asset.id,
      instrument: instrumentOfAsset(asset),
      isin: meta?.isin ?? null,
      providerSymbol: meta?.providerSymbol ?? null,
      valueMinor: 0,
    });
  }

  return { holdings, profiles: profileMap };
}

/** Map per-holding display returns to the annual rates `projectExposureDrift` uses. */
export function holdingAnnualReturnByIdForProjection(input: {
  holdingIds: readonly string[];
  returnsById: ReadonlyMap<string, HoldingReturnsView | null | undefined>;
  assumedAnnualReturn: number;
}): Record<string, number> {
  return Object.fromEntries(
    input.holdingIds.map((holdingId) => [
      holdingId,
      resolveHoldingAnnualReturnForProjection(
        input.returnsById.get(holdingId),
        input.assumedAnnualReturn,
      ),
    ]),
  );
}

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

function bucketGrowthRate(
  holdingId: string,
  input: ExposureDriftProjectionInput,
): number {
  if (input.growthAssumption === "flat") {
    return 0;
  }
  return input.holdingAnnualReturnById?.[holdingId] ?? input.assumedAnnualReturn;
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
  let grossMinor = 0;
  for (const [holdingId, valueMinor] of buckets.entries()) {
    const meta = metaById.get(holdingId);
    if (!meta || valueMinor <= 0) {
      continue;
    }
    holdings.push({ ...meta, valueMinor });
    grossMinor += valueMinor;
  }

  // Gross equals exactly what is looked through, so the three-way coverage
  // always sums to gross. A bucket without resolvable meta (e.g. a plan
  // destination that is no longer a holding) is excluded from both holdings and
  // gross — never silently inflating the denominator while vanishing from
  // coverage.
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
  const contributionsByYear = contributionMoneyByProjectionYear(
    input.plan,
    input.todayISO,
    maxYears,
    input.unitPriceMajorByHoldingId,
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
