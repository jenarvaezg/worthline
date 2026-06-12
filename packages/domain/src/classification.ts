import type { LiquidityTier } from "./liquidity-tier";
import type { Liability, ManualAsset } from "./workspace-types";

export type { LiquidityTier };

export function tierOfAsset(asset: ManualAsset): LiquidityTier {
  if (
    asset.type === "real_estate" ||
    asset.isPrimaryResidence ||
    asset.liquidityTier === "housing"
  ) {
    return "housing";
  }

  return asset.liquidityTier;
}

export function isHousingAsset(asset: ManualAsset): boolean {
  return tierOfAsset(asset) === "housing";
}

export function tierOfLiability(
  liability: Liability,
  assetTierById: Map<string, LiquidityTier>,
): LiquidityTier {
  if (liability.associatedAssetId) {
    return assetTierById.get(liability.associatedAssetId) ?? "housing";
  }

  return liability.type === "mortgage" ? "housing" : "cash";
}

export function isLiquid(tier: LiquidityTier): boolean {
  return tier === "cash" || tier === "market";
}

export function isHousing(tier: LiquidityTier): boolean {
  return tier === "housing";
}
