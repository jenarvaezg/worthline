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
  type InvestmentOperation,
  type Liability,
  type ManualAsset,
  type NetWorthSnapshot,
  netUnitsByAsset,
  type ScopeOption,
  type WarningOverride,
  type Workspace,
} from "@worthline/domain";

import { readAmortizableStartByLiabilityId } from "./data-quality-amortizable-start";
import { readMonthlyDebtServiceByLiabilityId } from "./debt-service-reads";

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
  /**
   * The whole investment ledger the dashboard already read (the shared projection
   * context) — folded here into net units per holding so a fully-sold position
   * stops emitting MISSING_PROVIDER_SYMBOL (#1348). No extra I/O.
   */
  operationsByAsset: ReadonlyMap<string, readonly InvestmentOperation[]>;
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

  // El modelo de deuda se lee UNA vez por deuda y se reparte en dos lecturas (#1520):
  // el testigo del gasto mira todas —el modelo se declara por deuda y no por tipo, así
  // que un préstamo al consumo con cuadro paga cuota igual que una hipoteca— y la
  // señal de histórico sigue mirando solo las hipotecas, que es su regla. Dos pasadas
  // de la misma consulta doblarían el I/O del GET del home (#783) para nada.
  const mortgageIds = new Set(
    input.liabilities
      .filter((liability) => liability.type === "mortgage")
      .map((liability) => liability.id),
  );

  const [
    sourceFreshnessEntries,
    syncAttemptEntries,
    positionEntries,
    debtModelEntries,
    manualValueHistoryByAssetId,
    assetCreatedAtById,
    trashedHoldings,
    managedPortfolios,
  ] = await Promise.all([
    Promise.all(
      connectedSources.map(
        async (source) =>
          [source.id, await agentView.readSourceFreshness(source.id)] as const,
      ),
    ),
    // Los intentos de sync de cada fuente (#1226). Una consulta indexada por fuente
    // conectada — el mismo coste y la misma tanda que la frescura de arriba, y solo
    // por fuente realmente conectada (hoy dos), así que no mueve el presupuesto de
    // I/O del GET del home (#783).
    Promise.all(
      connectedSources.map(
        async (source) =>
          [source.id, await agentView.readSyncAttempts(source.id)] as const,
      ),
    ),
    Promise.all(
      connectedSources.map(
        async (source) =>
          [source.id, await agentView.readSourcePositions(source.id)] as const,
      ),
    ),
    Promise.all(
      input.liabilities.map(
        async (liability) =>
          [liability.id, await agentView.readDebtModel(liability.id)] as const,
      ),
    ),
    agentView.readManualValueHistory(input.assets.map((asset) => asset.id)),
    agentView.readAssetCreatedAtById(),
    agentView.readTrashedHoldings(),
    // Las carteras gestionadas con su saldo declarado (#1550). Una consulta a una
    // tabla diminuta (una fila por cartera), en la misma tanda que las demás.
    agentView.readManagedPortfolios(),
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
  const debtModelByAnyLiabilityId = new Map<string, DebtModel | null>(debtModelEntries);
  const debtModelByLiabilityId = new Map<string, DebtModel | null>(
    debtModelEntries.filter(([id]) => mortgageIds.has(id)),
  );
  const amortizableStartByLiabilityId = await readAmortizableStartByLiabilityId(
    agentView,
    debtModelByLiabilityId,
  );
  // La cuota vigente de cada deuda con cuadro (#1520), para cruzarla contra el gasto
  // declarado. Solo lee de las amortizables, que en esta cartera son una o dos.
  const debtServiceByLiabilityId = await readMonthlyDebtServiceByLiabilityId(
    agentView,
    debtModelByAnyLiabilityId,
    input.asOfDateKey,
  );

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
    amortizableStartByLiabilityId,
    connectedSources,
    debtModelByLiabilityId,
    debtServiceByLiabilityId,
    fireConfigByScopeId: input.fireConfigByScopeId,
    // Los valores de los miembros salen de los MISMOS holdings valorados por
    // curva que pinta el tablero (#1422): el careo del testigo no puede citar
    // una cifra que la ficha de la cartera contradiga.
    holdingValueByHoldingId: new Map(
      input.assets.map((asset) => [asset.id, asset.currentValue]),
    ),
    // The same ledger, un-folded: the savings-coherence watch (#1449) needs the
    // operations themselves, not just the net units derived from them.
    investmentOperationsByAssetId: input.operationsByAsset,
    liabilities: input.liabilities,
    managedPortfolios,
    manualValueHistoryByAssetId,
    netUnitsByAssetId: netUnitsByAsset(input.operationsByAsset),
    positionsBySourceId,
    priceFreshnessByAssetId,
    scope: { internalScopeId: input.scope.id, scopeLabel: input.scope.label },
    scopeOption: input.scope,
    snapshotIdsWithHoldings,
    snapshotHoldings: input.holdingRows.map((row) => ({
      dateKey: row.dateKey,
      holdingId: row.holdingId,
      kind: row.kind,
    })),
    snapshots: input.snapshots,
    sourceFreshnessBySourceId,
    syncAttemptsBySourceId: new Map(syncAttemptEntries),
    // The Papelera's own rows (#1365). Their net units need no extra I/O: the
    // shared projection context reads the WHOLE operations table, trashed
    // holdings included, so `netUnitsByAssetId` above already covers them. The
    // store row is passed as read — it already carries the id, name, and owner
    // members the engine's `DataQualityTrashedHolding` asks for.
    trashedHoldings,
    warningOverrides: input.overrides,
    workspace: input.workspace,
  });
}
