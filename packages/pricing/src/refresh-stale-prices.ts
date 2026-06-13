import type {
  AssetPrice,
  InvestmentPriceProvider,
  LiquidityTier,
} from "@worthline/domain";
import { defaultInvestmentPriceProvider, selectStalePrices } from "@worthline/domain";

import { finectProvider } from "./finect";
import { fetchAndCachePrice } from "./index";
import { stooqProvider } from "./stooq";
import { yahooProvider } from "./yahoo";

export interface InvestmentAssetRef {
  id: string;
  currency: string;
  liquidityTier?: LiquidityTier;
  priceProvider?: InvestmentPriceProvider;
  providerSymbol?: string | undefined;
}

/** A failed refresh paired with its human-readable reason (issue #137). */
export interface RefreshFailure {
  symbol: string;
  reason: string;
}

export interface RefreshStalePricesResult {
  /** AssetPrice entries that were refreshed (fresh or failed outcome). */
  refreshed: AssetPrice[];
  /** Number of entries successfully updated with a fresh price. */
  updated: number;
  /** Symbols that failed to refresh. */
  failedSymbols: string[];
  /** Failed symbols paired with the reason the refresh failed (issue #137). */
  failures: RefreshFailure[];
}

/**
 * Refreshes all stale prices in the cache for assets that have a provider symbol.
 *
 * - Selects stale entries from the cache (>24h old, non-manual, non-failed).
 * - Fetches fresh prices from the provider for those assets only.
 * - Never throws: provider failures degrade to freshnessState "failed".
 * - Returns the refreshed AssetPrice entries so callers can persist them and
 *   compose with auto-snapshot (#49): run refreshStalePrices before snapshot
 *   capture so the snapshot reflects the latest prices.
 */
export async function refreshStalePrices(
  cacheEntries: AssetPrice[],
  assets: InvestmentAssetRef[],
  nowIso: string,
  onRefreshed?: (price: AssetPrice) => void,
): Promise<RefreshStalePricesResult> {
  const staleEntries = selectStalePrices(cacheEntries, nowIso);
  const staleAssetIds = new Set(staleEntries.map((e) => e.assetId));

  const refreshable = assets.filter(
    (asset) => staleAssetIds.has(asset.id) && Boolean(asset.providerSymbol),
  );

  if (refreshable.length === 0) {
    return { refreshed: [], updated: 0, failedSymbols: [], failures: [] };
  }

  const results = await Promise.all(
    refreshable.map(async (asset) => {
      const provider = resolveInvestmentPriceProvider(asset);
      const price = await fetchAndCachePrice(provider, {
        assetId: asset.id,
        symbol: asset.providerSymbol!,
        currency: asset.currency,
        nowIso,
      });
      onRefreshed?.(price);
      return { price, symbol: asset.providerSymbol! };
    }),
  );

  const failures = results
    .filter((r) => r.price.freshnessState === "failed")
    .map((r) => ({ symbol: r.symbol, reason: r.price.staleReason ?? "" }));

  return {
    refreshed: results.map((r) => r.price),
    updated: results.filter((r) => r.price.freshnessState === "fresh").length,
    failedSymbols: failures.map((f) => f.symbol),
    failures,
  };
}

function resolveInvestmentPriceProvider(asset: InvestmentAssetRef) {
  const providerName =
    asset.priceProvider ??
    defaultInvestmentPriceProvider(asset.liquidityTier ?? "market");

  switch (providerName) {
    case "finect":
      return finectProvider;
    case "stooq":
      return stooqProvider;
    case "yahoo":
      return yahooProvider;
  }
}
