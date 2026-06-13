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

/**
 * The ids of the housing assets in a collection — real estate / primary residence
 * (`isHousingAsset`). A debt securing one of these nets housing equity rather than
 * its liquidity rung (ADR 0013 bridge), so callers that net debts against housing
 * build this set once and pass it down.
 */
export function housingAssetIdsOf(assets: readonly ManualAsset[]): ReadonlySet<string> {
  return new Set(assets.filter(isHousingAsset).map((asset) => asset.id));
}

/**
 * Whether a liability secures a housing asset — the basis for netting it against
 * housing equity instead of by liquidity rung (ADR 0013 bridge). True only when the
 * liability points at an asset present in `housingAssetIds`.
 */
export function securesHousingAsset(
  liability: { associatedAssetId?: string },
  housingAssetIds: ReadonlySet<string>,
): boolean {
  return !!liability.associatedAssetId && housingAssetIds.has(liability.associatedAssetId);
}
