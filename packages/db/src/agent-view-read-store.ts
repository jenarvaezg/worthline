import type {
  ExportedPublicId,
  InvestmentOperation,
  Liability,
  ManualAsset,
  SourceAdapter,
  Workspace,
} from "@worthline/domain";

import { readAgentViewPublicIds } from "./agent-view-public-ids";
import type { ConnectedSourceRow } from "./connected-source-store";
import type { StoreContext } from "./store-context";

/**
 * A connected source as the agent view sees it — identity, label, freshness, and
 * the holdings it materialized. Credentials and tokens are excluded by
 * construction; the agent view never exposes secrets (PRD #328).
 */
export interface AgentViewConnectedSource {
  id: string;
  adapter: SourceAdapter;
  label: string;
  lastSyncAt: string | null;
  /** Asset ids this source materialized — one per occupied rung. */
  assetIds: string[];
}

/**
 * Narrow read-only port for the external agent view (PRD #328, ADR 0023). It
 * exposes only the reads the agent-view service needs and never any write or
 * side-effecting path — agent reads must not refresh prices, sync sources, or
 * capture snapshots. Construction injects already-bound store reads so the port
 * cannot reach the rest of the store surface.
 */
export interface AgentViewReadStore {
  readWorkspace: () => Workspace | null;
  readPublicIds: () => ExportedPublicId[];
  readAssets: () => ManualAsset[];
  readLiabilities: () => Liability[];
  readOperations: (assetId: string) => InvestmentOperation[];
  readConnectedSources: () => AgentViewConnectedSource[];
}

export interface AgentViewReadStoreDeps {
  readAssets: () => ManualAsset[];
  readLiabilities: () => Liability[];
  readOperations: (assetId: string) => InvestmentOperation[];
  listConnectedSources: () => ConnectedSourceRow[];
  listSourceAssetIds: (sourceId: string) => string[];
}

export function createAgentViewReadStore(
  ctx: StoreContext,
  deps: AgentViewReadStoreDeps,
): AgentViewReadStore {
  return {
    readWorkspace: () => ctx.getWorkspace(),
    readPublicIds: () => readAgentViewPublicIds(ctx.db),
    readAssets: () => deps.readAssets(),
    readLiabilities: () => deps.readLiabilities(),
    readOperations: (assetId) => deps.readOperations(assetId),
    readConnectedSources: () =>
      deps.listConnectedSources().map((row) => ({
        adapter: row.adapter,
        assetIds: deps.listSourceAssetIds(row.id),
        id: row.id,
        label: row.label,
        lastSyncAt: row.lastSyncAt,
      })),
  };
}
