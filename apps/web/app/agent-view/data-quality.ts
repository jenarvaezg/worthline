import type { AgentViewReadStore } from "@worthline/db";
import {
  collectDataQualitySignals,
  DATA_QUALITY_CATEGORY_ORDER,
  type DataQualityAffectedRef,
  type DataQualitySignal,
  listScopeOptions,
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
): Promise<AgentViewDataQualitySummary> {
  const { signals } = await collectScopeSignals(scoped);

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

async function collectScopeSignals(
  scoped: ScopedAgentView,
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
  const fireConfigByScopeId = await store.readFireConfig();
  const warningOverrides = await store.readWarningOverrides();
  const holdingPublicIds = publicIdMap(await store.readPublicIds(), "holding");
  const manualValueHistoryByAssetId = await store.readManualValueHistory();
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

  const mortgageIds = liabilities
    .filter((liability) => liability.type === "mortgage")
    .map((liability) => liability.id);
  const debtModelByLiabilityId = new Map(
    await Promise.all(
      mortgageIds.map(
        async (liabilityId) =>
          [liabilityId, await store.readDebtModel(liabilityId)] as const,
      ),
    ),
  );

  const positionsBySourceId = new Map(
    await Promise.all(
      connectedSources.map(
        async (source) =>
          [source.id, await store.readSourcePositions(source.id)] as const,
      ),
    ),
  );

  const domainSignals = collectDataQualitySignals({
    asOfDateKey: new Date().toISOString().slice(0, 10),
    assetCreatedAtById,
    assets,
    connectedSources,
    debtModelByLiabilityId,
    fireConfigByScopeId,
    liabilities,
    manualValueHistoryByAssetId,
    positionsBySourceId,
    priceFreshnessByAssetId,
    scope: {
      internalScopeId,
      scopeLabel: scope.label,
    },
    scopeOption,
    snapshotIdsWithHoldings,
    snapshots,
    sourceFreshnessBySourceId,
    warningOverrides,
    workspace,
  });

  return {
    scope,
    signals: domainSignals.map((signal) =>
      toAgentViewSignal(signal, holdingPublicIds, scope.id),
    ),
  };
}

function toAgentViewSignal(
  signal: DataQualitySignal,
  holdingPublicIds: Map<string, string>,
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
          affected: toAgentViewAffected(signal.affected, holdingPublicIds, scopePublicId),
        }),
    severity: signal.severity,
  };
}

function toAgentViewAffected(
  affected: DataQualityAffectedRef,
  holdingPublicIds: Map<string, string>,
  scopePublicId: string,
): AgentViewObjectReference {
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

function unknownScope(): AgentViewHttpError {
  return new AgentViewHttpError({
    code: "not_found",
    message: "Unknown scope.",
    status: 404,
  });
}
