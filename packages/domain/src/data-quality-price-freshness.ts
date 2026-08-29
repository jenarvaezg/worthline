/**
 * The quote behind a derived holding: stale, or failed outright (PRD #654 S1).
 */

import {
  type DataQualityCollector,
  type DataQualitySignal,
  dateOnly,
  signalNaturalKey,
} from "./data-quality-collector";
import type { DecimalString } from "./decimal";
import type { PriceFreshnessState } from "./prices";
import { isClosedPosition } from "./warnings";
import type { ManualAsset } from "./workspace-types";

export interface DataQualityPriceFreshness {
  freshnessState: PriceFreshnessState;
  fetchedAt: string;
}

export interface DataQualityPriceFreshnessInput {
  assets: readonly ManualAsset[];
  priceFreshnessByAssetId: ReadonlyMap<string, DataQualityPriceFreshness>;
  netUnitsByAssetId: ReadonlyMap<string, DecimalString>;
}

export const collectPriceFreshnessSignals: DataQualityCollector<
  DataQualityPriceFreshnessInput
> = (input) => {
  const signals: DataQualitySignal[] = [];

  for (const asset of input.assets) {
    // The second half of #1348: a CLOSED position keeps its price-cache row, so
    // its quote goes stale (and, once the provider drops the symbol, fails)
    // forever — and FAILED_PRICE is `high`, which turns the home hero red over a
    // holding worth 0. A price nothing multiplies cannot compromise today's
    // figure, so a sold-out position is silent here for exactly the reason it is
    // silent for MISSING_PROVIDER_SYMBOL. Non-derived holdings are never in the
    // map, so their freshness signals are untouched.
    if (
      !input.ownedAssetIds.has(asset.id) ||
      isClosedPosition(asset, input.netUnitsByAssetId)
    ) {
      continue;
    }

    const signal = priceFreshnessToSignal(
      asset,
      input.priceFreshnessByAssetId.get(asset.id),
    );
    if (signal) {
      signals.push(signal);
    }
  }

  return signals;
};

function priceFreshnessToSignal(
  asset: ManualAsset,
  freshness: DataQualityPriceFreshness | undefined,
): DataQualitySignal | null {
  if (freshness === undefined) {
    return null;
  }

  if (freshness.freshnessState === "failed") {
    return {
      affected: { id: asset.id, label: asset.name, object: "holding" },
      category: "price_freshness",
      code: "FAILED_PRICE",
      fixable: false,
      label: `El último precio de "${asset.name}" falló al actualizarse.`,
      naturalKey: signalNaturalKey("price_freshness", "FAILED_PRICE", asset.id),
      observedDate: dateOnly(freshness.fetchedAt),
      severity: "high",
    };
  }

  if (freshness.freshnessState === "stale") {
    return {
      affected: { id: asset.id, label: asset.name, object: "holding" },
      category: "price_freshness",
      code: "STALE_PRICE",
      fixable: false,
      label: `El precio de "${asset.name}" está desactualizado.`,
      naturalKey: signalNaturalKey("price_freshness", "STALE_PRICE", asset.id),
      observedDate: dateOnly(freshness.fetchedAt),
      severity: "medium",
    };
  }

  return null;
}
