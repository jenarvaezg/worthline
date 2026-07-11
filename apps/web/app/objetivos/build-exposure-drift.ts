import type {
  ContributionPlan,
  ExposureDriftPoint,
  ExposureDriftProjection,
  ExposureLookthroughHolding,
  ExposureProfile,
  FireGrowthAssumption,
  HoldingReturnsView,
  Instrument,
  Liability,
  ManualAsset,
  ScopeOption,
  Workspace,
} from "@worthline/domain";
import {
  instrumentOfAsset,
  projectExposureDrift,
  projectPortfolio,
  resolveHoldingAnnualReturnForProjection,
} from "@worthline/domain";

export interface BuildExposureDriftInput {
  workspace: Workspace;
  scope: ScopeOption;
  assets: ManualAsset[];
  liabilities: Liability[];
  investmentMeta: Array<{
    id: string;
    isin?: string | null;
    providerSymbol?: string | null;
  }>;
  exposureProfiles: ExposureProfile[];
  contributionPlan: ContributionPlan;
  growthAssumption: FireGrowthAssumption;
  assumedAnnualReturn: number;
  holdingReturnsById: Map<string, HoldingReturnsView | null>;
  unitPrices: Record<string, string>;
  today: string;
  maxYears?: number;
}

function toAnnualReturn(
  returns: HoldingReturnsView | null,
  assumedAnnualReturn: number,
): number {
  return resolveHoldingAnnualReturnForProjection(returns, assumedAnnualReturn);
}

/** Assemble scope-weighted holdings and project exposure drift under the plan. */
export function buildExposureDriftProjection(
  input: BuildExposureDriftInput,
): ExposureDriftProjection {
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
      currency: input.workspace.baseCurrency,
      geography: null,
      id: row.id,
      instrument: row.instrument as Instrument,
      isin: metaByAssetId.get(row.id)?.isin ?? null,
      providerSymbol: metaByAssetId.get(row.id)?.providerSymbol ?? null,
      valueMinor: row.valueMinor,
    }),
  );

  for (const contribution of input.contributionPlan.contributions) {
    if (holdings.some((holding) => holding.id === contribution.destinationHoldingId)) {
      continue;
    }
    const asset = assetById.get(contribution.destinationHoldingId);
    if (!asset) {
      continue;
    }
    const meta = metaByAssetId.get(asset.id);
    holdings.push({
      currency: input.workspace.baseCurrency,
      geography: null,
      id: asset.id,
      instrument: instrumentOfAsset(asset),
      isin: meta?.isin ?? null,
      providerSymbol: meta?.providerSymbol ?? null,
      valueMinor: 0,
    });
  }

  const holdingAnnualReturnById = Object.fromEntries(
    holdings.map((holding) => [
      holding.id,
      toAnnualReturn(
        input.holdingReturnsById.get(holding.id) ?? null,
        input.assumedAnnualReturn,
      ),
    ]),
  );

  return projectExposureDrift({
    todayISO: input.today,
    baseCurrency: input.workspace.baseCurrency,
    plan: input.contributionPlan,
    growthAssumption: input.growthAssumption,
    assumedAnnualReturn: input.assumedAnnualReturn,
    holdingAnnualReturnById,
    unitPriceMajorByHoldingId: input.unitPrices,
    holdings,
    profiles: profileMap,
    ...(input.maxYears === undefined ? {} : { maxYears: input.maxYears }),
  });
}

export function exposureDriftTrajectories(input: {
  flat: ExposureDriftPoint[];
  historical: ExposureDriftPoint[];
}): Record<FireGrowthAssumption, ExposureDriftPoint[]> {
  return {
    flat: input.flat,
    historical: input.historical,
  };
}
