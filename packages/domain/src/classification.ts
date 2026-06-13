import type { LiquidityTier } from "./liquidity-ladder";
import { isLiquid, rungForLiability } from "./liquidity-ladder";
import type { ManualAsset } from "./workspace-types";

export type { LiquidityTier };
export { isLiquid, rungForLiability };

/**
 * An asset's rung on the liquidity ladder (ADR 0013). Real estate and the
 * primary residence are among the least-liquid holdings there are, so they sit
 * on `illiquid` regardless of any declared tier. Their housing-ness — the basis
 * for housing equity — is a separate, type-based fact (`isHousingAsset`), no
 * longer a rung of its own.
 */
export function tierOfAsset(asset: ManualAsset): LiquidityTier {
  if (asset.type === "real_estate" || asset.isPrimaryResidence) {
    return "illiquid";
  }

  return asset.liquidityTier;
}

/**
 * A housing asset, identified by type — real estate or the primary residence.
 * Bridge (ADR 0013/0014): housing equity and the housing composition stay
 * sourced from this type-based fact until the instrument re-sources them,
 * decoupled from the (now `illiquid`) liquidity rung.
 */
export function isHousingAsset(asset: ManualAsset): boolean {
  return asset.type === "real_estate" || asset.isPrimaryResidence;
}
