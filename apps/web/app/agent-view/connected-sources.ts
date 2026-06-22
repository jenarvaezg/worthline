import type { AgentViewReadStore } from "@worthline/db";

import {
  type AgentViewConnectedSourceListEntry,
  type AgentViewSourceFreshnessResult,
} from "./contract";
import {
  deriveSourcePublicId,
  resolveSourceByPublicId,
} from "./connected-source-positions";
import { publicIdMap, requirePublicId } from "./scope-resolution";

/**
 * List every connected source in the workspace (#465, PRD #417 S1), with no side
 * effects — a read never syncs or revalues. Each entry carries the source's
 * opaque public id, adapter, label, last sync time, and the public holding IDs it
 * materializes (one per occupied rung). The `readConnectedSources` port is
 * secret-free, so no credential, token, or provider payload can leak here.
 */
export async function buildConnectedSourcesList(
  store: AgentViewReadStore,
): Promise<AgentViewConnectedSourceListEntry[]> {
  const sources = await store.readConnectedSources();
  const holdingPublicIds = publicIdMap(await store.readPublicIds(), "holding");

  return sources.map((source) => ({
    id: deriveSourcePublicId(source.id),
    object: "connected_source",
    adapter: source.adapter,
    label: source.label,
    lastSyncAt: source.lastSyncAt,
    holdings: source.assetIds.map((assetId) =>
      requirePublicId(holdingPublicIds, assetId),
    ),
  }));
}

/**
 * Surface one connected source's valuation freshness (#465, PRD #417 S1), with no
 * side effects. Resolves the public `wl_src_…` to its source (an unknown id is a
 * `404` via the shared resolver), then reads the sanitized freshness off its
 * primary price-cache row. A source that has never been valued reports
 * `freshness: null`, never a guess. Secret-free by construction.
 */
export async function buildSourceFreshness(
  store: AgentViewReadStore,
  publicSourceId: string,
): Promise<AgentViewSourceFreshnessResult> {
  const source = await resolveSourceByPublicId(store, publicSourceId);
  const freshness = await store.readSourceFreshness(source.id);

  return {
    object: "source_freshness",
    source: publicSourceId,
    freshness: freshness
      ? {
          freshnessState: freshness.freshnessState,
          fetchedAt: freshness.fetchedAt,
          ...(freshness.staleReason === undefined
            ? {}
            : { staleReason: freshness.staleReason }),
        }
      : null,
  };
}
