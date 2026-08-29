/**
 * A connected source as the health engine sees it: who it is, whether it belongs
 * to the scope, and whether its fetch is broken or merely lapsed.
 *
 * The shared half of the source-level families. Membership is defined once
 * because, decided per family, two signals about the same source could disagree
 * about which scope they belong to; the health reading is defined once for the
 * reason spelled out on {@link sourceFreshnessStatus}.
 */

import type { PriceFreshnessState } from "./prices";

export interface DataQualityConnectedSource {
  id: string;
  label: string;
  assetIds: string[];
  lastSyncAt: string | null;
}

export interface DataQualitySourceFreshness {
  freshnessState: PriceFreshnessState;
  fetchedAt: string;
  staleReason?: string;
}

/** The sources themselves — what every source-level family starts from. */
export interface DataQualityConnectedSourceInput {
  connectedSources: readonly DataQualityConnectedSource[];
}

/** The sources plus their fetch health, for the families that read both. */
export interface DataQualitySourceHealthInput extends DataQualityConnectedSourceInput {
  sourceFreshnessBySourceId: ReadonlyMap<string, DataQualitySourceFreshness | null>;
}

/**
 * Si una fuente pertenece al ámbito: alguno de los peldaños que materializa está
 * entre los holdings del ámbito.
 */
export function sourceIsInScope(
  source: DataQualityConnectedSource,
  ownedAssetIds: ReadonlySet<string>,
): boolean {
  return source.assetIds.some((assetId) => ownedAssetIds.has(assetId));
}

/**
 * Whether a connected source's FETCH is broken or merely lapsed — the one shared
 * reading of source health (#1224).
 *
 * It matters that this is shared rather than re-derived per surface: a fetch that
 * fails upstream (revoked credentials, provider outage) is caught before a
 * `sync_run` is ever opened, so it leaves NO run to read — its only trace is the
 * source's freshness row. A surface that looked solely at `sync_run` would inherit
 * the last good run's verdict and claim health while the source has been dark for
 * days, contradicting this collection (which CONTEXT.md requires every consumer to
 * agree with). `/ajustes/conexiones` calls this for exactly that reason.
 */
export function sourceFreshnessStatus(
  source: { lastSyncAt: string | null },
  freshness: DataQualitySourceFreshness | null,
): "failed" | "stale" | null {
  if (freshness === null && source.lastSyncAt === null) {
    return null;
  }

  const state = freshness?.freshnessState;
  if (state === "failed") {
    return "failed";
  }
  if (state === "stale") {
    return "stale";
  }
  return null;
}
