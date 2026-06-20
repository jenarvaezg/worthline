import type { AssetPrice } from "@worthline/domain";
import type { InvestmentAssetRef, RefreshStalePricesResult } from "@worthline/pricing";

export interface RefreshAndPersistInput {
  /** Current price cache entries (used to determine which are stale). */
  cacheEntries: AssetPrice[];
  /** Investment assets with provider symbols for fetching. */
  assets: InvestmentAssetRef[];
  /** ISO timestamp representing "now" for staleness calculation. */
  nowIso: string;
  /** Injected: refreshStalePrices from @worthline/pricing (allows testing without I/O). */
  refreshStalePrices: (
    cacheEntries: AssetPrice[],
    assets: InvestmentAssetRef[],
    nowIso: string,
  ) => Promise<RefreshStalePricesResult>;
  /** Injected: persist a single refreshed price entry. */
  upsertPrice: (price: AssetPrice) => void | Promise<void>;
  /** Injected: read the current price cache after persisting. */
  readCache: () => AssetPrice[] | Promise<AssetPrice[]>;
}

export interface RefreshAndPersistResult {
  /** The price cache after refresh (always populated — stale cache on failure). */
  priceCache: AssetPrice[];
  /**
   * Non-empty on partial or total failure.
   * Contains failed provider symbols, or the thrown error message if the
   * entire refresh threw. Exposed so issue #69 can surface these signals.
   */
  errors: string[];
}

/**
 * Price-refresh orchestration: determine stale → fetch via pricing provider → persist.
 *
 * Extracted from the copy-pasted refresh-on-load pattern in app/page.tsx (issue
 * #67). The dashboard refreshes on load via loadDashboard, which then captures
 * the daily snapshot on the freshly-refreshed prices (#153 removed the redundant
 * /inversiones refresh-on-load now that the section is collapsed).
 *
 * Behaviour:
 * - Never throws. Provider failures degrade silently; errors are returned so
 *   future callers (issue #69) can surface them to the user.
 * - Always calls readCache() so the caller always gets the current persisted state,
 *   whether or not a refresh occurred.
 */
export async function refreshAndPersistStalePrices(
  input: RefreshAndPersistInput,
): Promise<RefreshAndPersistResult> {
  let errors: string[] = [];

  try {
    const result = await input.refreshStalePrices(
      input.cacheEntries,
      input.assets,
      input.nowIso,
    );

    for (const price of result.refreshed) {
      await input.upsertPrice(price);
    }

    errors = result.failedSymbols;
  } catch (err) {
    errors = [err instanceof Error ? err.message : "Unknown refresh error"];
  }

  const priceCache = await input.readCache();
  return { priceCache, errors };
}
