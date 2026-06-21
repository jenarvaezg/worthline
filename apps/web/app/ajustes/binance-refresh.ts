import type { WorthlineStore } from "@worthline/db";
import {
  binanceAdapter,
  fetchCoinGeckoLogos,
  fetchCoinGeckoPriceEur,
  getAllBalances,
  syncBinanceAccount,
} from "@worthline/pricing";

import {
  refreshStaleBinanceSources,
  type BinanceSourceRef,
  type RefreshBinanceSourcesResult,
} from "@web/refresh-binance-sources";

/**
 * Production wiring for the Binance live-revalue refresh (PRD #245 S4, issue #249,
 * ADR 0007/0021).
 *
 * Binds the real Binance/CoinGecko network behind {@link refreshStaleBinanceSources}:
 * for each connected Binance source whose `binance` freshness row has lapsed, it
 * re-reads the signed account balances, re-prices each token live, replaces the
 * source's positions (re-rolling every rung's holding value) and stamps the
 * freshness row fresh. Bad credentials / network outage is caught upstream, keeping
 * the last-known value and marking the source stale (never zeroed).
 *
 * Runs on the dashboard load alongside investment prices + coin valuations;
 * `withStore` is sync-only so the caller keeps the store open across the awaited
 * network here. The API key + secret are SECRETS (ADR 0021): never logged.
 */
export async function runBinanceRefresh(
  store: WorthlineStore,
  nowIso: string,
): Promise<RefreshBinanceSourcesResult> {
  const binanceSources = (await store.connectedSources.listSources()).filter(
    (source) => source.adapter === "binance",
  );
  const sources: BinanceSourceRef[] = await Promise.all(
    binanceSources.map(async (source) => ({
      sourceId: source.id,
      freshness: await store.operations.readPriceCache(source.assetId),
    })),
  );

  if (sources.length === 0) {
    return { errors: [] };
  }

  return refreshStaleBinanceSources({
    nowIso,
    sources,
    reSync: async (sourceId) => {
      const source = await store.connectedSources.readSource(sourceId);
      const creds = source
        ? binanceAdapter.readCredentials(source.credentialsJson)
        : null;
      if (!source || !creds) {
        throw new Error("Binance credentials unavailable.");
      }

      const nowMs = new Date(nowIso).getTime();
      return syncBinanceAccount({
        listBalances: () => getAllBalances(creds, { nowMs }),
        priceEur: (id) => fetchCoinGeckoPriceEur(id, nowIso),
        logoUrls: fetchCoinGeckoLogos,
      });
    },
    persistFresh: async (sourceId, drafts) => {
      await store.syncConnectedSource({ sourceId, positions: drafts, syncedAt: nowIso });
      await store.connectedSources.revaluePositions(sourceId, [], {
        fetchedAt: nowIso,
        freshnessState: "fresh",
      });
    },
    persistStale: (sourceId, lastFetchedAt, reason) =>
      store.connectedSources.revaluePositions(sourceId, [], {
        fetchedAt: lastFetchedAt ?? nowIso,
        freshnessState: "stale",
        staleReason: reason,
      }),
  });
}
