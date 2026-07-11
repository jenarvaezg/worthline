import type {
  ContributionPlan,
  ExposureDriftPoint,
  ExposureDriftProjection,
  FireGrowthAssumption,
  HoldingReturnsView,
  Liability,
  ManualAsset,
  ScopeOption,
  Workspace,
} from "@worthline/domain";
import {
  assembleExposureDriftHoldings,
  type ExposureProfile,
  holdingAnnualReturnByIdForProjection,
  projectExposureDrift,
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

/** Assemble scope-weighted holdings and project exposure drift under the plan. */
export function buildExposureDriftProjection(
  input: BuildExposureDriftInput,
): ExposureDriftProjection {
  const { holdings, profiles } = assembleExposureDriftHoldings({
    baseCurrency: input.workspace.baseCurrency,
    workspace: input.workspace,
    scope: input.scope,
    assets: input.assets,
    liabilities: input.liabilities,
    investmentMeta: input.investmentMeta,
    exposureProfiles: input.exposureProfiles,
    plan: input.contributionPlan,
  });

  const holdingAnnualReturnById = holdingAnnualReturnByIdForProjection({
    holdingIds: holdings.map((holding) => holding.id),
    returnsById: input.holdingReturnsById,
    assumedAnnualReturn: input.assumedAnnualReturn,
  });

  return projectExposureDrift({
    todayISO: input.today,
    baseCurrency: input.workspace.baseCurrency,
    plan: input.contributionPlan,
    growthAssumption: input.growthAssumption,
    assumedAnnualReturn: input.assumedAnnualReturn,
    holdingAnnualReturnById,
    unitPriceMajorByHoldingId: input.unitPrices,
    holdings,
    profiles,
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
