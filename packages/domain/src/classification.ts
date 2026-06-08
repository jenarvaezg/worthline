import type { LiquidityTier } from "@worthline/contracts";

import type { Liability, ManualAsset } from "./index";

/**
 * The single home for the liquidity-tier taxonomy. Both the net-worth summary
 * and the liquidity pyramid resolve tiers through this module so they cannot
 * disagree about which bucket an asset or liability belongs to.
 */

/** The liquidity tier an asset declares it belongs to. */
export function tierOfAsset(asset: ManualAsset): LiquidityTier {
  return asset.liquidityTier;
}

/** Whether an asset contributes to housing equity (residence, not generic wealth). */
export function isHousingAsset(asset: ManualAsset): boolean {
  return (
    asset.type === "real_estate" ||
    asset.isPrimaryResidence ||
    asset.liquidityTier === "housing"
  );
}

/**
 * The liquidity tier a liability sits in. A liability attached to an asset
 * inherits that asset's tier; an unattached liability falls back by type
 * (a mortgage is housing debt, anything else is cash-tier debt).
 */
export function tierOfLiability(
  liability: Liability,
  assetTierById: Map<string, LiquidityTier>,
): LiquidityTier {
  if (liability.associatedAssetId) {
    return assetTierById.get(liability.associatedAssetId) ?? "housing";
  }

  return liability.type === "mortgage" ? "housing" : "cash";
}

/** Whether a tier counts toward liquid net worth. */
export function isLiquid(tier: LiquidityTier): boolean {
  return tier === "cash" || tier === "market";
}

/** Whether a tier counts toward housing equity. */
export function isHousing(tier: LiquidityTier): boolean {
  return tier === "housing";
}
