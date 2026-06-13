import type { Instrument } from "./instrument-catalog";
import { defaultInstrumentForAssetType } from "./instrument-catalog";
import type { LiquidityTier } from "./liquidity-ladder";
import { isLiquid, rungForLiability } from "./liquidity-ladder";
import type { ManualAsset } from "./workspace-types";

export type { Instrument, LiquidityTier };
export { isLiquid, rungForLiability };

/**
 * What an asset is (ADR 0014, #149). Reads the stored instrument when present
 * (the backfilled column wins), deriving it from the legacy `type` /
 * `isPrimaryResidence` only for in-memory assets that predate the column.
 */
export function instrumentOfAsset(asset: ManualAsset): Instrument {
  return (
    asset.instrument ?? defaultInstrumentForAssetType(asset.type, asset.isPrimaryResidence)
  );
}

/**
 * An asset's rung on the liquidity ladder (ADR 0013). Housing — among the
 * least-liquid holdings there are — sits on `illiquid` regardless of any declared
 * tier. Housing-ness is now the instrument (`property`), not a rung of its own.
 */
export function tierOfAsset(asset: ManualAsset): LiquidityTier {
  if (isHousingAsset(asset)) {
    return "illiquid";
  }

  return asset.liquidityTier;
}

/**
 * A housing asset — one whose instrument is `property` (ADR 0014, #149). Housing
 * equity and the housing composition are sourced from this, decoupled from the
 * (now `illiquid`) liquidity rung and from the legacy AssetType.
 */
export function isHousingAsset(asset: ManualAsset): boolean {
  return instrumentOfAsset(asset) === "property";
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
