import type {
  AssetPrice,
  InvestmentPriceProvider,
  LiquidityTier,
} from "@worthline/domain";
import { defaultInvestmentPriceProvider, selectStalePrices } from "@worthline/domain";

import { fetchAndCachePrice, type PriceProvider } from "./index";
import { fetchWithFallback, providerRegistry, type RegisteredSource } from "./registry";

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

/**
 * Maximum number of provider calls made concurrently while refreshing stale
 * prices (issue #202). Bounds the burst so users with many investment symbols
 * don't fan out an unbounded `Promise.all` against the price providers, which
 * risks provider rate limits and local resource exhaustion. Tuned low because
 * refresh runs in the background ahead of snapshot capture, not on a hot path.
 */
export const REFRESH_CONCURRENCY_LIMIT = 4;

/**
 * Maps `items` through `fn` with at most `limit` calls in flight at once,
 * returning results in input order. `fn` must not reject (callers degrade
 * failures into result values), so this helper never rejects either — it
 * preserves the existing "never throws" refresh semantics.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]!, index);
    }
  };

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
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

/** Options controlling which entries the refresh pass picks up (#317). */
export interface RefreshOptions {
  /**
   * Force a refetch of EVERY asset with a provider symbol, ignoring cache
   * staleness (the manual "Actualizar precios" button, #317 / ADR 0026). The
   * cached row's freshness is bypassed entirely — `cacheEntries` is not consulted
   * for selection. Replaces the old `forcedStaleCache` hack, which fabricated
   * epoch-dated rows to defeat `selectStalePrices`.
   */
  force?: boolean;
  /** Invoked once per refreshed asset, with the resulting cache row. */
  onRefreshed?: (price: AssetPrice) => void;
}

/**
 * Refreshes prices in the cache for assets that have a provider symbol.
 *
 * - By default selects only stale entries (>24h old, non-manual, non-failed).
 *   With `force: true`, refetches every asset with a provider symbol regardless
 *   of cache staleness (manual refresh, #317).
 * - Fetches fresh prices from the provider for the selected assets only.
 * - Never throws: provider failures degrade to freshnessState "failed".
 * - Returns the refreshed AssetPrice entries so callers can persist them and
 *   compose with auto-snapshot (#49): run refreshStalePrices before snapshot
 *   capture so the snapshot reflects the latest prices.
 */
export async function refreshStalePrices(
  cacheEntries: AssetPrice[],
  assets: InvestmentAssetRef[],
  nowIso: string,
  options: RefreshOptions = {},
): Promise<RefreshStalePricesResult> {
  const { force = false, onRefreshed } = options;

  const refreshable = force
    ? assets.filter((asset) => Boolean(asset.providerSymbol))
    : (() => {
        const staleAssetIds = new Set(
          selectStalePrices(cacheEntries, nowIso).map((e) => e.assetId),
        );
        return assets.filter(
          (asset) => staleAssetIds.has(asset.id) && Boolean(asset.providerSymbol),
        );
      })();

  if (refreshable.length === 0) {
    return { refreshed: [], updated: 0, failedSymbols: [], failures: [] };
  }

  const results = await mapWithConcurrency(
    refreshable,
    REFRESH_CONCURRENCY_LIMIT,
    async (asset) => {
      const provider = resolveInvestmentPriceProvider(asset);
      const price = await fetchAndCachePrice(provider, {
        assetId: asset.id,
        symbol: asset.providerSymbol!,
        currency: asset.currency,
        nowIso,
      });
      onRefreshed?.(price);
      return { price, symbol: asset.providerSymbol! };
    },
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

/**
 * Resolve the investment's source name (explicit override, else the tier
 * default) and return a provider that fetches through the declared fallback
 * POLICY (issue #243, ADR 0011). Adding a provider is a single `providerRegistry`
 * entry — there is no routing switch to extend here. The tier default stays in
 * `domain` (`defaultInvestmentPriceProvider`); only the name→provider resolution
 * lives behind the registry seam.
 */
function resolveInvestmentPriceProvider(asset: InvestmentAssetRef): PriceProvider {
  const source: RegisteredSource =
    asset.priceProvider ??
    defaultInvestmentPriceProvider(asset.liquidityTier ?? "market");

  // A thin adapter so `fetchAndCachePrice` drives the source through its
  // fallback chain; `name` is the primary so a total miss still records it.
  return {
    name: providerRegistry[source].name,
    fetchPrice: (ctx) => fetchWithFallback(source, ctx),
  };
}
