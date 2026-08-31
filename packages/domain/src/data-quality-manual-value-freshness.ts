/**
 * A stored holding whose manual value has gone stale (PRD #654 S2).
 */

import {
  type DataQualityCollector,
  type DataQualitySignal,
  signalLabelWithOverride,
  signalNaturalKey,
} from "./data-quality-collector";
import { daysBetween } from "./dates";
import { isValueUpdateEligible, valuationMethodOfAsset } from "./holding-method";
import { lastManualValueUpdateDateKey, type ManualValuePoint } from "./value-history";
import type { ManualAsset } from "./workspace-types";

/** Fixed v1 threshold for stale manual values (PRD #654 S2). */
export const STALE_MANUAL_VALUE_THRESHOLD_DAYS = 90;

/** Machine code for a stored holding without a recent manual value update. */
export const STALE_MANUAL_VALUE_CODE = "STALE_MANUAL_VALUE";

export interface DataQualityManualValueFreshnessInput {
  assets: readonly ManualAsset[];
  /** Manual value audit history keyed by asset id. */
  manualValueHistoryByAssetId: ReadonlyMap<string, readonly ManualValuePoint[]>;
  /** Asset creation timestamps (ISO), keyed by asset id — stale-manual fallback. */
  assetCreatedAtById: ReadonlyMap<string, string>;
  /** Calendar day the collection runs against (`YYYY-MM-DD`). */
  asOfDateKey: string;
}

export const collectManualValueFreshnessSignals: DataQualityCollector<
  DataQualityManualValueFreshnessInput
> = (input) => {
  const signals: DataQualitySignal[] = [];

  for (const asset of input.assets) {
    // The signal's fix is «ponlo al día», so it may only fire on a holding that
    // pass actually lists (#1691). `isValueUpdateEligible` is that seam, and it
    // excludes a CONNECTED holding — whose value comes from its source, never from
    // a hand edit. Without it a connected collection filed under a `stored`
    // instrument was told its manual value was stale and handed a fix leading
    // somewhere it does not appear: an aviso that cannot be followed, the same
    // dead end as #1510-#1512.
    if (
      !input.ownedAssetIds.has(asset.id) ||
      !isValueUpdateEligible(asset) ||
      valuationMethodOfAsset(asset) !== "stored"
    ) {
      continue;
    }

    const lastUpdateDateKey = lastManualValueUpdateDateKey(
      input.manualValueHistoryByAssetId.get(asset.id),
      input.assetCreatedAtById.get(asset.id),
    );
    if (lastUpdateDateKey === undefined) {
      continue;
    }

    if (
      daysBetween(lastUpdateDateKey, input.asOfDateKey) <
      STALE_MANUAL_VALUE_THRESHOLD_DAYS
    ) {
      continue;
    }

    const baseLabel = `El valor manual de "${asset.name}" lleva más de ${STALE_MANUAL_VALUE_THRESHOLD_DAYS} días sin actualizarse.`;
    signals.push({
      affected: { id: asset.id, label: asset.name, object: "holding" },
      category: "manual_value_freshness",
      code: STALE_MANUAL_VALUE_CODE,
      fixable: true,
      label: signalLabelWithOverride(
        baseLabel,
        STALE_MANUAL_VALUE_CODE,
        asset.id,
        input.overriddenKeys,
        true,
      ),
      naturalKey: signalNaturalKey(
        "manual_value_freshness",
        STALE_MANUAL_VALUE_CODE,
        asset.id,
      ),
      observedDate: lastUpdateDateKey,
      severity: "medium",
    });
  }

  return signals;
};
