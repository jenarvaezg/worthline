/**
 * Home data-quality signal gather (PRD #654 S3, #665).
 *
 * Assembles the shared engine's input for the home hero, reusing the data the
 * dashboard load already read (assets, liabilities, snapshots, overrides, FIRE
 * config, price cache, windowed holding rows) and reading only the few extra
 * inputs the hero needs — so surfacing the health alert stays off the heavy I/O
 * budget of the home GET (#783). Both the home and the agent view call the same
 * `collectDataQualitySignals`, so the human and the agent read one inventory.
 */

import type { AgentViewReadStore } from "@worthline/db";
import {
  type AssetPrice,
  collectDataQualitySignals,
  type DataQualityConnectedSource,
  type DataQualityPriceFreshness,
  type DataQualitySignal,
  type DataQualitySourceFreshness,
  type DatedSnapshotHoldingRow,
  type DebtModel,
  type FireScopeConfig,
  type Liability,
  type ManualAsset,
  type NetWorthSnapshot,
  type ScopeOption,
  type WarningOverride,
  type Workspace,
} from "@worthline/domain";

export interface DashboardDataQualityInput {
  /** The agent-view read store — the seam for the few extra reads (#654). */
  agentView: AgentViewReadStore;
  workspace: Workspace;
  /** The scope the home is headlining. */
  scope: ScopeOption;
  /** Curve-valued holdings the dashboard already read for the same date. */
  assets: readonly ManualAsset[];
  liabilities: readonly Liability[];
  /** The scope's snapshots (already read for the histórico chart). */
  snapshots: readonly NetWorthSnapshot[];
  /** Windowed frozen holding rows (already read) — the has-holdings evidence. */
  holdingRows: readonly DatedSnapshotHoldingRow[];
  overrides: readonly WarningOverride[];
  fireConfigByScopeId: Readonly<Record<string, FireScopeConfig | undefined>>;
  /** Refreshed price cache — the freshness signals read this, not new I/O. */
  priceCache: readonly AssetPrice[];
  /** Calendar day the collection runs against (`YYYY-MM-DD`). */
  asOfDateKey: string;
}

/**
 * Collect the scope's data-quality signals for the home hero, reusing loaded
 * data and reading only connected-source metadata/positions/freshness, mortgage
 * debt models, and the manual-value audit history the engine still needs.
 */
export async function collectDashboardDataQualitySignals(
  input: DashboardDataQualityInput,
): Promise<DataQualitySignal[]> {
  const { agentView } = input;

  const rawSources = await agentView.readConnectedSources();
  const connectedSources: DataQualityConnectedSource[] = rawSources.map((source) => ({
    assetIds: source.assetIds,
    id: source.id,
    label: source.label,
    lastSyncAt: source.lastSyncAt,
  }));

  const mortgageIds = input.liabilities
    .filter((liability) => liability.type === "mortgage")
    .map((liability) => liability.id);

  const [
    sourceFreshnessEntries,
    positionEntries,
    debtModelEntries,
    manualValueHistoryByAssetId,
    assetCreatedAtById,
  ] = await Promise.all([
    Promise.all(
      connectedSources.map(
        async (source) =>
          [source.id, await agentView.readSourceFreshness(source.id)] as const,
      ),
    ),
    Promise.all(
      connectedSources.map(
        async (source) =>
          [source.id, await agentView.readSourcePositions(source.id)] as const,
      ),
    ),
    Promise.all(
      mortgageIds.map(async (id) => [id, await agentView.readDebtModel(id)] as const),
    ),
    agentView.readManualValueHistory(),
    agentView.readAssetCreatedAtById(),
  ]);

  const priceFreshnessByAssetId = new Map<string, DataQualityPriceFreshness>(
    input.priceCache.map((price) => [
      price.assetId,
      { fetchedAt: price.fetchedAt, freshnessState: price.freshnessState },
    ]),
  );

  const sourceFreshnessBySourceId = new Map<string, DataQualitySourceFreshness | null>(
    sourceFreshnessEntries,
  );
  const positionsBySourceId = new Map(positionEntries);
  const debtModelByLiabilityId = new Map<string, DebtModel | null>(debtModelEntries);

  // A snapshot has holdings when the (already windowed) rows carry its date. Out
  // of the window this can under-count, so only the low-severity
  // MISSING_SNAPSHOT_ROWS signal is affected — never the top-of-hero alert.
  const datesWithRows = new Set(input.holdingRows.map((row) => row.dateKey));
  const snapshotIdsWithHoldings = new Set(
    input.snapshots
      .filter((snapshot) => datesWithRows.has(snapshot.dateKey))
      .map((snapshot) => snapshot.id),
  );

  return collectDataQualitySignals({
    asOfDateKey: input.asOfDateKey,
    assetCreatedAtById,
    assets: input.assets,
    connectedSources,
    debtModelByLiabilityId,
    fireConfigByScopeId: input.fireConfigByScopeId,
    liabilities: input.liabilities,
    manualValueHistoryByAssetId,
    positionsBySourceId,
    priceFreshnessByAssetId,
    scope: { internalScopeId: input.scope.id, scopeLabel: input.scope.label },
    scopeOption: input.scope,
    snapshotIdsWithHoldings,
    snapshots: input.snapshots,
    sourceFreshnessBySourceId,
    warningOverrides: input.overrides,
    workspace: input.workspace,
  });
}
