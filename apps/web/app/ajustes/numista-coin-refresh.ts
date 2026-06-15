import type { WorthlineStore } from "@worthline/db";
import {
  fetchMetalSpotEur,
  getPrices,
  isTokenValid,
  mintNumistaToken,
  refreshCoinValuations,
} from "@worthline/pricing";

import {
  refreshStaleCoinValuations,
  type CoinSourceRef,
  type RefreshCoinValuationsResult,
} from "../refresh-coin-valuations";
import { parseNumistaToken, readApiKey } from "./numista-helpers";

/**
 * Production wiring for the decoupled coin-valuation refresh (PRD #166, ADR 0017).
 *
 * Binds the real Numista/Stooq network behind {@link refreshStaleCoinValuations}:
 * for each connected Numista source whose `numista` freshness row has lapsed, it
 * mints/reuses the OAuth token, refetches the per-grade estimate (only past its
 * long TTL — {@link refreshCoinValuations} owns that gate) and the daily metal
 * spot, then persists via the store. Token mint failure / network outage is caught
 * upstream, keeping the last-known value and marking the source stale.
 *
 * Runs on the dashboard load alongside investment prices; `withStore` is sync-only
 * so the caller keeps the store open across the awaited network here.
 */
export async function runNumistaCoinRefresh(
  store: WorthlineStore,
  nowIso: string,
): Promise<RefreshCoinValuationsResult> {
  const sources: CoinSourceRef[] = store.connectedSources
    .listSources()
    .filter((source) => source.adapter === "numista")
    .map((source) => ({
      sourceId: source.id,
      assetId: source.assetId,
      freshness: store.operations.readPriceCache(source.assetId),
    }));

  if (sources.length === 0) {
    return { errors: [] };
  }

  return refreshStaleCoinValuations({
    nowIso,
    sources,
    readPositions: (sourceId) => store.connectedSources.readPositions(sourceId),
    persist: (sourceId, updates, freshness) =>
      store.connectedSources.revaluePositions(sourceId, updates, freshness),
    revalue: async (sourceId, positions, now) => {
      const source = store.connectedSources.readSource(sourceId);
      const apiKey = source ? readApiKey(source.credentialsJson) : null;
      if (!source || !apiKey) {
        throw new Error("Numista credentials unavailable.");
      }

      const credentials = { apiKey };
      const nowMs = new Date(now).getTime();
      let token = parseNumistaToken(source.tokenJson);
      if (!token || !isTokenValid(token, nowMs)) {
        token = await mintNumistaToken(credentials, nowMs);
        store.connectedSources.saveToken(sourceId, JSON.stringify(token));
      }

      return refreshCoinValuations(
        positions,
        {
          prices: (typeId, issueId) =>
            getPrices(credentials, typeId, issueId)
              .then((prices) => prices)
              .catch(() => null),
          spotPerOzEur: (metal) => fetchMetalSpotEur(metal, now),
        },
        { nowIso: now },
      );
    },
  });
}
