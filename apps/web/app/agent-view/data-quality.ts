import { readAmortizableStartByLiabilityId } from "@web/data-quality-amortizable-start";
import { readMonthlyDebtServiceByLiabilityId } from "@web/debt-service-reads";
import type { AgentViewReadStore } from "@worthline/db";
import type { InvestmentOperation } from "@worthline/domain";
import {
  collectDataQualitySignals,
  DATA_QUALITY_CATEGORY_ORDER,
  type DataQualityAffectedRef,
  type DataQualitySignal,
  listScopeOptions,
  netUnitsByAsset,
  systemClock,
  valuationMethodOfAsset,
} from "@worthline/domain";
import { deriveSourcePublicId } from "./connected-source-positions";
import {
  type AgentViewDataQualityCategory,
  type AgentViewDataQualityPage,
  type AgentViewDataQualitySeverity,
  type AgentViewDataQualitySignal,
  type AgentViewDataQualitySummary,
  AgentViewHttpError,
  type AgentViewObjectReference,
  type AgentViewScope,
} from "./contract";
import {
  compareDateId,
  type DateIdKey,
  decodeCursor,
  dropAfterCursor,
  encodeCursor,
} from "./cursor";
import { derivePublicId } from "./derived-id";
import { unknownScope } from "./http-errors";
import { publicIdMap, requirePublicId } from "./scope-resolution";
import type { ScopedAgentView } from "./scoped-read";
import { listAgentViewScopes } from "./scopes";

export const DEFAULT_DATA_QUALITY_LIMIT = 100;
export const MAX_DATA_QUALITY_LIMIT = 500;

/** The number of top signals folded into the main-context summary (PRD #328). */
export const TOP_SIGNALS_LIMIT = 10;

const ALL_SEVERITIES: readonly AgentViewDataQualitySeverity[] = ["high", "medium", "low"];

/** Severity rank: lower rank = higher severity, so an ascending sort is DESC. */
const SEVERITY_RANK: Record<AgentViewDataQualitySeverity, number> = {
  high: 0,
  low: 2,
  medium: 1,
};

export interface BuildDataQualityOptions {
  /** Page size, already clamped to `[1, MAX_DATA_QUALITY_LIMIT]` by the caller. */
  limit: number;
  /** Restrict to one category, when given. */
  category?: AgentViewDataQualityCategory | undefined;
  /** Restrict to one severity, when given. */
  severity?: AgentViewDataQualitySeverity | undefined;
  /** Opaque cursor from a previous page's `meta.nextCursor`. */
  cursor?: string | undefined;
}

/**
 * Assemble a scope's full, filterable, paginated data-quality signal list with no
 * side effects (PRD #328, #341): domain warnings (blocking + overrideable), price
 * and source freshness, missing configuration, history coverage, and projection
 * gaps — all normalized to one shape and one severity scale. Reads persisted
 * state only; surfacing a `warning` signal NEVER writes an override (ADR 0023).
 */
export async function buildDataQuality(
  scoped: ScopedAgentView,
  options: BuildDataQualityOptions,
): Promise<AgentViewDataQualityPage> {
  const { signals } = await collectScopeSignals(scoped);

  const filtered = signals.filter(
    (signal) =>
      (options.category === undefined || signal.category === options.category) &&
      (options.severity === undefined || signal.severity === options.severity),
  );

  const sorted = filtered
    .map((signal) => ({ key: sortKey(signal), signal }))
    .sort((a, b) => compareDateId(a.key, b.key, "date"));

  const afterCursor = options.cursor
    ? dropAfterCursor(sorted, decodeCursor(options.cursor), "date", (entry) => entry.key)
    : sorted;

  const page = afterCursor.slice(0, options.limit);
  const hasNext = afterCursor.length > options.limit;
  const last = page[page.length - 1];
  const nextCursor =
    hasNext && last ? encodeCursor(last.key.dateKey, last.key.publicId) : undefined;

  return {
    meta: {
      hasNext,
      limit: options.limit,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    },
    signals: page.map((entry) => entry.signal),
  };
}

/**
 * The compact data-quality summary folded into the main financial context
 * (PRD #328, #341): the scope's signal counts by severity and by category, plus
 * the top highest-severity signals in the canonical stable order. Reuses the same
 * signal collection as the full endpoint, so both read identical figures.
 */
export async function buildDataQualitySummary(
  scoped: ScopedAgentView,
  /** The ledger the caller already read, so the context reads it once (#1593). */
  input?: SharedLedgerInput,
): Promise<AgentViewDataQualitySummary> {
  const { signals } = await collectScopeSignals(scoped, input);

  const countsBySeverity = emptySeverityCounts();
  const countsByCategory = emptyCategoryCounts();
  for (const signal of signals) {
    countsBySeverity[signal.severity] += 1;
    countsByCategory[signal.category] += 1;
  }

  const topSignals = signals
    .map((signal) => ({ key: sortKey(signal), signal }))
    .sort((a, b) => compareDateId(a.key, b.key, "date"))
    .slice(0, TOP_SIGNALS_LIMIT)
    .map((entry) => entry.signal);

  return { countsByCategory, countsBySeverity, topSignals };
}

/** What a caller that already read the workspace's ledgers can hand this fold. */
interface SharedLedgerInput {
  operationsByAssetId: ReadonlyMap<string, readonly InvestmentOperation[]>;
}

async function collectScopeSignals(
  scoped: ScopedAgentView,
  input?: SharedLedgerInput,
): Promise<{ scope: AgentViewScope; signals: AgentViewDataQualitySignal[] }> {
  const { store } = scoped;
  const workspace = await store.readWorkspace();

  if (!workspace) {
    throw unknownScope();
  }

  const scope = (await listAgentViewScopes(store)).find(
    (candidate) => candidate.id === scoped.scopeId,
  );

  if (!scope) {
    throw unknownScope();
  }

  const internalScopeId = await scoped.internalScopeId();
  const scopeOption = listScopeOptions(workspace).find(
    (option) => option.id === internalScopeId,
  );

  if (!scopeOption) {
    throw new AgentViewHttpError({
      code: "internal_error",
      message: "Agent view scope is not resolvable.",
      status: 500,
    });
  }

  const assets = await store.readAssets();
  const liabilities = await store.readLiabilities();
  const connectedSources = await store.readConnectedSources();
  const snapshots = await store.readSnapshots(internalScopeId);
  const holdingsByDate = await store.readSnapshotHoldings({ scopeId: internalScopeId });
  const snapshotIdsWithHoldings = new Set(holdingsByDate.map((row) => row.snapshotId));
  // One clock read for this resolution: the derived FIRE age (#1415) and the
  // signals' own as-of date are the same day.
  const asOfDateKey = systemClock().today();
  const fireConfigByScopeId = await store.readFireConfig(asOfDateKey);
  const warningOverrides = await store.readWarningOverrides();
  const publicIdRows = await store.readPublicIds();
  const holdingPublicIds = publicIdMap(publicIdRows, "holding");
  // Las carteras gestionadas se nombran por su id público `wl_prt_…` (#1550), el
  // mismo con el que el agente puede pedir su ficha.
  const portfolioPublicIds = publicIdMap(publicIdRows, "managed_portfolio");
  const manualValueHistoryByAssetId = await store.readManualValueHistory(
    assets.map((asset) => asset.id),
  );
  const assetCreatedAtById = await store.readAssetCreatedAtById();

  const priceFreshnessByAssetId = new Map(
    await Promise.all(
      assets.map(async (asset) => {
        const freshness = await store.readPriceFreshness(asset.id);
        return freshness === null ? null : ([asset.id, freshness] as const);
      }),
    ).then((entries) => entries.filter((entry) => entry !== null)),
  );

  const sourceFreshnessBySourceId = new Map(
    await Promise.all(
      connectedSources.map(
        async (source) =>
          [source.id, await store.readSourceFreshness(source.id)] as const,
      ),
    ),
  );

  // El otro eje de la salud de una fuente (#1226): sus intentos de sync retenidos,
  // de los que el motor cuenta cuántos han fallado seguidos. Lo lee el MISMO puerto
  // que alimenta el bloque de salud del home, para que el agente y el humano no
  // puedan contar rachas distintas.
  const syncAttemptsBySourceId = new Map(
    await Promise.all(
      connectedSources.map(
        async (source) => [source.id, await store.readSyncAttempts(source.id)] as const,
      ),
    ),
  );

  // Un modelo por deuda, leído UNA vez y repartido en dos lecturas (#1520): la señal
  // de histórico mira solo las hipotecas, que es su regla, y el testigo del gasto mira
  // todas — el modelo se declara por deuda y no por tipo, así que un préstamo al
  // consumo amortizable paga cuota igual que una hipoteca.
  const mortgageIds = new Set(
    liabilities
      .filter((liability) => liability.type === "mortgage")
      .map((liability) => liability.id),
  );
  const debtModelEntries = await Promise.all(
    liabilities.map(
      async (liability) =>
        [liability.id, await store.readDebtModel(liability.id)] as const,
    ),
  );
  const debtModelByLiabilityId = new Map(
    debtModelEntries.filter(([id]) => mortgageIds.has(id)),
  );
  const amortizableStartByLiabilityId = await readAmortizableStartByLiabilityId(
    store,
    debtModelByLiabilityId,
  );
  // La cuota vigente de cada deuda con cuadro (#1520), para cruzarla contra el gasto
  // declarado. El modelo se declara por deuda y no por tipo, así que el testigo mira
  // TODAS las deudas: un préstamo al consumo amortizable paga cuota igual que una
  // hipoteca, y las señales que sí son de hipoteca siguen con su propia lista.
  const debtServiceByLiabilityId = await readMonthlyDebtServiceByLiabilityId(
    store,
    new Map(debtModelEntries),
    asOfDateKey,
  );

  const positionsBySourceId = new Map(
    await Promise.all(
      connectedSources.map(
        async (source) =>
          [source.id, await store.readSourcePositions(source.id)] as const,
      ),
    ),
  );

  // The Papelera's own rows (#1365). Every read above excludes the trash, so a
  // holding deleted with units still on its ledger is invisible to all of them —
  // both the row and its ledger have to be asked for by id.
  const trashedHoldings = await store.readTrashedHoldings();

  // Las carteras gestionadas con su saldo declarado, y los holdings valorados por
  // CURVA a la misma fecha (#1550): el careo del testigo tiene que citar las mismas
  // cifras que pinta el tablero, no los valores almacenados (#1422). Es la misma
  // lectura que ya hacen `get_financial_context` y la ficha de un holding.
  const managedPortfolios = await store.readManagedPortfolios();
  const curveValued = await store.readCurveValuedHoldings(asOfDateKey);
  const holdingValueByHoldingId = new Map(
    curveValued.assets.map((asset) => [asset.id, asset.currentValue]),
  );

  // Net units per holding, so a sold-out position is silent here for the same
  // reasons it is on the home hero (#1348). Folded for EVERY `derived` holding,
  // not just the ones a given signal can fire on: the engine now reads this map
  // for two codes (MISSING_PROVIDER_SYMBOL and price freshness) and will read it
  // for more, and a map narrowed to one code's candidates would silently
  // under-populate for the next — the exact drift the required input prevents.
  // The fold itself, including "an empty ledger is unstarted, not closed", is the
  // domain's. Trashed ASSETS join the fold for the same reason: their units are
  // what decides whether the delete took value out of the patrimonio (#1365).
  // The ledger arrives from ONE read — the caller's when it already has it (the
  // financial context reads it for its returns and holdings blocks, #1593),
  // otherwise this fold's own bulk read. Never one query per holding: the id set
  // below runs into the dozens, and the fold is a fold.
  const ledger = input?.operationsByAssetId ?? (await store.readAllOperations());
  const ledgerHoldingIds = new Set([
    ...assets
      .filter((asset) => valuationMethodOfAsset(asset) === "derived")
      .map((asset) => asset.id),
    // Investment holdings whose instrument is not `derived` still keep an
    // operations ledger, and the savings-coherence watch (#1449) measures
    // over ALL of it: a window the home reads in full and the agent view
    // reads in part would put the two at odds about the same scope.
    ...assets.filter((asset) => asset.type === "investment").map((a) => a.id),
    ...trashedHoldings
      .filter((holding) => holding.kind === "asset")
      .map((holding) => holding.id),
  ]);
  const operationsByAssetId = new Map(
    [...ledgerHoldingIds].map(
      (holdingId) => [holdingId, [...(ledger.get(holdingId) ?? [])]] as const,
    ),
  );
  const netUnitsByAssetId = netUnitsByAsset(operationsByAssetId);

  const domainSignals = collectDataQualitySignals({
    asOfDateKey,
    assetCreatedAtById,
    assets,
    amortizableStartByLiabilityId,
    connectedSources,
    debtModelByLiabilityId,
    debtServiceByLiabilityId,
    fireConfigByScopeId,
    holdingValueByHoldingId,
    investmentOperationsByAssetId: operationsByAssetId,
    liabilities,
    managedPortfolios,
    manualValueHistoryByAssetId,
    netUnitsByAssetId,
    positionsBySourceId,
    priceFreshnessByAssetId,
    scope: {
      internalScopeId,
      scopeLabel: scope.label,
    },
    scopeOption,
    snapshotIdsWithHoldings,
    snapshotHoldings: holdingsByDate.map((row) => ({
      dateKey: row.dateKey,
      holdingId: row.holdingId,
      kind: row.kind,
    })),
    snapshots,
    sourceFreshnessBySourceId,
    syncAttemptsBySourceId,
    trashedHoldings,
    warningOverrides,
    workspace,
  });

  return {
    scope,
    signals: domainSignals.map((signal) =>
      toAgentViewSignal(signal, holdingPublicIds, portfolioPublicIds, scope.id),
    ),
  };
}

function toAgentViewSignal(
  signal: DataQualitySignal,
  holdingPublicIds: Map<string, string>,
  portfolioPublicIds: Map<string, string>,
  scopePublicId: string,
): AgentViewDataQualitySignal {
  return {
    category: signal.category,
    code: signal.code,
    fixable: signal.fixable,
    id: derivePublicId("dqs", signal.naturalKey),
    label: signal.label,
    object: "data_quality_signal",
    ...(signal.observedDate === undefined ? {} : { observedDate: signal.observedDate }),
    ...(signal.originalWarningType === undefined
      ? {}
      : { originalWarningType: signal.originalWarningType }),
    ...(signal.affected === undefined
      ? {}
      : {
          affected: toAgentViewAffected(
            signal.affected,
            holdingPublicIds,
            portfolioPublicIds,
            scopePublicId,
          ),
        }),
    severity: signal.severity,
  };
}

function toAgentViewAffected(
  affected: DataQualityAffectedRef,
  holdingPublicIds: Map<string, string>,
  portfolioPublicIds: Map<string, string>,
  scopePublicId: string,
): AgentViewObjectReference {
  if (affected.object === "managed_portfolio") {
    return {
      id: requirePublicId(portfolioPublicIds, affected.id),
      label: affected.label,
      object: "managed_portfolio",
    };
  }

  if (affected.object === "holding") {
    return {
      id: requirePublicId(holdingPublicIds, affected.id),
      label: affected.label,
      object: "holding",
    };
  }

  if (affected.object === "connected_source") {
    return {
      id: deriveSourcePublicId(affected.id),
      label: affected.label,
      object: "connected_source",
    };
  }

  return {
    id: scopePublicId,
    label: affected.label,
    object: "scope",
  };
}

function sortKey(signal: AgentViewDataQualitySignal): DateIdKey {
  const categoryRank = DATA_QUALITY_CATEGORY_ORDER.indexOf(signal.category);
  const affectedId = signal.affected?.id ?? "";
  return {
    dateKey: `${SEVERITY_RANK[signal.severity]}|${categoryRank}|${affectedId}`,
    publicId: signal.id,
  };
}

function emptySeverityCounts(): Record<AgentViewDataQualitySeverity, number> {
  return Object.fromEntries(ALL_SEVERITIES.map((severity) => [severity, 0])) as Record<
    AgentViewDataQualitySeverity,
    number
  >;
}

function emptyCategoryCounts(): Record<AgentViewDataQualityCategory, number> {
  return Object.fromEntries(
    DATA_QUALITY_CATEGORY_ORDER.map((category) => [category, 0]),
  ) as Record<AgentViewDataQualityCategory, number>;
}
