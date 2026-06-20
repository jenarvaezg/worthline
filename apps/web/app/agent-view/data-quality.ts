import type { AgentViewPriceFreshness, AgentViewReadStore } from "@worthline/db";
import {
  coinValue,
  collectWarnings,
  listScopeOptions,
  projectPortfolio,
} from "@worthline/domain";
import type {
  DomainWarning,
  Liability,
  ManualAsset,
  ScopeOption,
  WarningSeverity,
  Workspace,
} from "@worthline/domain";

import {
  AgentViewHttpError,
  type AgentViewDataQualityCategory,
  type AgentViewDataQualityPage,
  type AgentViewDataQualitySeverity,
  type AgentViewDataQualitySignal,
  type AgentViewDataQualitySummary,
  type AgentViewObjectReference,
  type AgentViewScope,
} from "./contract";
import { deriveSourcePublicId, toFreshnessSummary } from "./connected-source-positions";
import {
  compareDateId,
  decodeCursor,
  dropAfterCursor,
  encodeCursor,
  type DateIdKey,
} from "./cursor";
import { derivePublicId } from "./derived-id";
import { publicIdMap, requirePublicId, resolveInternalScopeId } from "./scope-resolution";
import { listAgentViewScopes } from "./scopes";

export const DEFAULT_DATA_QUALITY_LIMIT = 100;
export const MAX_DATA_QUALITY_LIMIT = 500;

/** The number of top signals folded into the main-context summary (PRD #328). */
export const TOP_SIGNALS_LIMIT = 10;

/** Few-snapshots threshold below which history coverage is flagged sparse (#341). */
const SPARSE_SNAPSHOT_THRESHOLD = 3;

/** Stable category order for the secondary sort key (PRD #328). */
const CATEGORY_ORDER: readonly AgentViewDataQualityCategory[] = [
  "warning",
  "price_freshness",
  "source_freshness",
  "missing_configuration",
  "history_coverage",
  "projection_gap",
];

/** Severity rank: lower rank = higher severity, so an ascending sort is DESC. */
const SEVERITY_RANK: Record<AgentViewDataQualitySeverity, number> = {
  high: 0,
  low: 2,
  medium: 1,
};

const ALL_SEVERITIES: readonly AgentViewDataQualitySeverity[] = ["high", "medium", "low"];

export interface BuildDataQualityOptions {
  /** Public scope ID (`wl_scp_…`) selected by the caller. */
  scopeId: string;
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
  store: AgentViewReadStore,
  options: BuildDataQualityOptions,
): Promise<AgentViewDataQualityPage> {
  // `collectScopeSignals` resolves the scope (a 404 for an unknown id) and is the
  // single source of the signal set the summary endpoint also reads.
  const { signals } = await collectScopeSignals(store, options.scopeId);

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
  store: AgentViewReadStore,
  publicScopeId: string,
): Promise<AgentViewDataQualitySummary> {
  const { signals } = await collectScopeSignals(store, publicScopeId);

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

/**
 * Resolve the scope and compute every data-quality signal it is relevant to, in a
 * deterministic order. Asset/liability-level signals are filtered to the holdings
 * the scope owns (`projectPortfolio` already drops rows with no stake); scope-
 * level signals (FIRE config, history coverage) are computed for the resolved
 * internal scope. No write of any kind.
 */
async function collectScopeSignals(
  store: AgentViewReadStore,
  publicScopeId: string,
): Promise<{ scope: AgentViewScope; signals: AgentViewDataQualitySignal[] }> {
  const workspace = await store.readWorkspace();

  if (!workspace) {
    throw unknownScope();
  }

  const scope = (await listAgentViewScopes(store)).find(
    (candidate) => candidate.id === publicScopeId,
  );

  if (!scope) {
    throw unknownScope();
  }

  const internalScopeId = await resolveInternalScopeId(store, publicScopeId);
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
  const ownedAssetIds = ownedHoldingIds(workspace, scopeOption, assets, liabilities);
  const holdingPublicIds = publicIdMap(await store.readPublicIds(), "holding");

  const signals: AgentViewDataQualitySignal[] = [
    ...(await warningSignals(store, ownedAssetIds, holdingPublicIds)),
    ...(await priceFreshnessSignals(store, assets, ownedAssetIds, holdingPublicIds)),
    ...(await sourceFreshnessSignals(store, ownedAssetIds)),
    ...(await missingConfigurationSignals(
      store,
      scope,
      internalScopeId,
      liabilities,
      ownedAssetIds,
      holdingPublicIds,
    )),
    ...(await historyCoverageSignals(store, scope, internalScopeId)),
    ...(await projectionGapSignals(store, ownedAssetIds)),
  ];

  return { scope, signals };
}

/** The internal asset + liability ids the scope owns (ownedMinor > 0). */
function ownedHoldingIds(
  workspace: Workspace,
  scope: ScopeOption,
  assets: ManualAsset[],
  liabilities: Liability[],
): Set<string> {
  const projection = projectPortfolio({ assets, liabilities, scope, workspace });
  return new Set([
    ...projection.sections[0].rows.map((row) => row.id),
    ...projection.sections[1].rows.map((row) => row.id),
  ]);
}

/**
 * Domain warnings as data-quality signals (PRD #328, #341): both blocking and
 * overrideable are surfaced. `collectWarnings` is run WITHOUT the persisted
 * overrides so overrideable warnings stay visible; the persisted overrides are
 * read only to label which were acknowledged — never written. The original
 * domain `code` is preserved as `originalWarningType`.
 */
async function warningSignals(
  store: AgentViewReadStore,
  ownedAssetIds: Set<string>,
  holdingPublicIds: Map<string, string>,
): Promise<AgentViewDataQualitySignal[]> {
  const overridden = new Set(
    (await store.readWarningOverrides()).map((o) => `${o.code}:${o.entityId}`),
  );

  const assets = await store.readAssets();
  return collectWarnings(assets)
    .filter((warning) => ownedAssetIds.has(warning.entityId))
    .map((warning) => warningToSignal(warning, overridden, holdingPublicIds, assets));
}

function warningToSignal(
  warning: DomainWarning,
  overridden: Set<string>,
  holdingPublicIds: Map<string, string>,
  assets: ManualAsset[],
): AgentViewDataQualitySignal {
  const isOverridden = overridden.has(`${warning.code}:${warning.entityId}`);
  const label =
    warning.severity === "overrideable" && isOverridden
      ? `${warning.message} (marcado como intencional)`
      : warning.message;

  return {
    category: "warning",
    code: warning.code,
    fixable: true,
    id: signalId("warning", warning.code, warning.entityId),
    label,
    object: "data_quality_signal",
    originalWarningType: warning.code,
    severity: warningSeverity(warning.severity),
    ...affectedRef(
      holdingPublicIds,
      warning.entityId,
      assetLabel(assets, warning.entityId),
    ),
  };
}

/** blocking → high, overrideable → medium (PRD #328 severity mapping). */
function warningSeverity(severity: WarningSeverity): AgentViewDataQualitySeverity {
  return severity === "blocking" ? "high" : "medium";
}

/**
 * Stale / failed price quotes for the scope's priced assets (PRD #328, #341).
 * A `failed` quote is `high`, a `stale` quote is `medium`; `fresh`/`manual`
 * quotes raise no signal. The price figure never leaves the read port.
 */
async function priceFreshnessSignals(
  store: AgentViewReadStore,
  assets: ManualAsset[],
  ownedAssetIds: Set<string>,
  holdingPublicIds: Map<string, string>,
): Promise<AgentViewDataQualitySignal[]> {
  const signals: AgentViewDataQualitySignal[] = [];

  for (const asset of assets) {
    if (!ownedAssetIds.has(asset.id)) {
      continue;
    }

    const freshness = await store.readPriceFreshness(asset.id);
    const signal = priceFreshnessToSignal(asset, freshness, holdingPublicIds);
    if (signal) {
      signals.push(signal);
    }
  }

  return signals;
}

function priceFreshnessToSignal(
  asset: ManualAsset,
  freshness: AgentViewPriceFreshness | null,
  holdingPublicIds: Map<string, string>,
): AgentViewDataQualitySignal | null {
  if (freshness === null) {
    return null;
  }

  if (freshness.freshnessState === "failed") {
    return {
      category: "price_freshness",
      code: "FAILED_PRICE",
      fixable: false,
      id: signalId("price_freshness", "FAILED_PRICE", asset.id),
      label: `El último precio de "${asset.name}" falló al actualizarse.`,
      object: "data_quality_signal",
      severity: "high",
      observedDate: dateOnly(freshness.fetchedAt),
      ...affectedRef(holdingPublicIds, asset.id, asset.name),
    };
  }

  if (freshness.freshnessState === "stale") {
    return {
      category: "price_freshness",
      code: "STALE_PRICE",
      fixable: false,
      id: signalId("price_freshness", "STALE_PRICE", asset.id),
      label: `El precio de "${asset.name}" está desactualizado.`,
      object: "data_quality_signal",
      severity: "medium",
      observedDate: dateOnly(freshness.fetchedAt),
      ...affectedRef(holdingPublicIds, asset.id, asset.name),
    };
  }

  return null;
}

/**
 * Stale / failed connected-source syncs (PRD #328, #341): a `failed` last sync is
 * `high`, a `stale` one is `medium`. Only sources backing a holding the scope owns
 * are surfaced. The affected object is the source (`wl_src_…`).
 */
async function sourceFreshnessSignals(
  store: AgentViewReadStore,
  ownedAssetIds: Set<string>,
): Promise<AgentViewDataQualitySignal[]> {
  const signals: AgentViewDataQualitySignal[] = [];

  for (const source of await store.readConnectedSources()) {
    if (!source.assetIds.some((assetId) => ownedAssetIds.has(assetId))) {
      continue;
    }

    const freshness = toFreshnessSummary(
      source,
      await store.readSourceFreshness(source.id),
    );
    if (freshness?.status !== "failed" && freshness?.status !== "stale") {
      continue;
    }

    const affected: AgentViewObjectReference = {
      id: deriveSourcePublicId(source.id),
      label: source.label,
      object: "connected_source",
    };
    const isFailed = freshness.status === "failed";

    signals.push({
      affected,
      category: "source_freshness",
      code: isFailed ? "FAILED_SOURCE_SYNC" : "STALE_SOURCE_SYNC",
      fixable: false,
      id: signalId(
        "source_freshness",
        isFailed ? "FAILED_SOURCE_SYNC" : "STALE_SOURCE_SYNC",
        source.id,
      ),
      label: isFailed
        ? `La última sincronización de "${source.label}" falló.`
        : `La sincronización de "${source.label}" está desactualizada.`,
      object: "data_quality_signal",
      severity: isFailed ? "high" : "medium",
      ...(freshness.lastFailedSync === undefined
        ? {}
        : { observedDate: dateOnly(freshness.lastFailedSync.at) }),
    });
  }

  return signals;
}

/**
 * Missing configuration the scope's figures need (PRD #328, #341): a scope with
 * no FIRE config (a scope-global `medium` signal) and an amortized liability with
 * no declared debt model (an asset-level `medium` signal). Kept deliberately
 * reasonable — the FIRE case plus one holding-level case (ADR 0023).
 */
async function missingConfigurationSignals(
  store: AgentViewReadStore,
  scope: AgentViewScope,
  internalScopeId: string,
  liabilities: Liability[],
  ownedAssetIds: Set<string>,
  holdingPublicIds: Map<string, string>,
): Promise<AgentViewDataQualitySignal[]> {
  const signals: AgentViewDataQualitySignal[] = [];

  if ((await store.readFireConfig())[internalScopeId] === undefined) {
    signals.push({
      affected: { id: scope.id, label: scope.label, object: "scope" },
      category: "missing_configuration",
      code: "MISSING_FIRE_CONFIG",
      fixable: true,
      id: signalId("missing_configuration", "MISSING_FIRE_CONFIG", internalScopeId),
      label: "Este ámbito no tiene configuración FIRE.",
      object: "data_quality_signal",
      severity: "medium",
    });
  }

  for (const liability of liabilities) {
    if (!ownedAssetIds.has(liability.id) || liability.type !== "mortgage") {
      continue;
    }

    if ((await store.readDebtModel(liability.id)) === null) {
      signals.push({
        category: "missing_configuration",
        code: "MISSING_DEBT_MODEL",
        fixable: true,
        id: signalId("missing_configuration", "MISSING_DEBT_MODEL", liability.id),
        label: `La hipoteca "${liability.name}" no tiene modelo de deuda.`,
        object: "data_quality_signal",
        severity: "medium",
        ...affectedRef(holdingPublicIds, liability.id, liability.name),
      });
    }
  }

  return signals;
}

/**
 * History-coverage gaps (PRD #328, #341): a scope with few/no snapshots (a
 * `low`/`medium` scope-global signal) and any snapshot with no frozen holding
 * rows (a `low` signal). Computed for the resolved internal scope.
 */
async function historyCoverageSignals(
  store: AgentViewReadStore,
  scope: AgentViewScope,
  internalScopeId: string,
): Promise<AgentViewDataQualitySignal[]> {
  const signals: AgentViewDataQualitySignal[] = [];
  const snapshots = await store.readSnapshots(internalScopeId);

  if (snapshots.length < SPARSE_SNAPSHOT_THRESHOLD) {
    signals.push({
      affected: { id: scope.id, label: scope.label, object: "scope" },
      category: "history_coverage",
      code: snapshots.length === 0 ? "NO_SNAPSHOTS" : "SPARSE_SNAPSHOTS",
      fixable: false,
      id: signalId(
        "history_coverage",
        snapshots.length === 0 ? "NO_SNAPSHOTS" : "SPARSE_SNAPSHOTS",
        internalScopeId,
      ),
      label:
        snapshots.length === 0
          ? "Este ámbito no tiene capturas de patrimonio."
          : "Este ámbito tiene un histórico de capturas escaso.",
      object: "data_quality_signal",
      severity: snapshots.length === 0 ? "medium" : "low",
    });
  }

  const holdingsByDate = await store.readSnapshotHoldings({ scopeId: internalScopeId });
  const datesWithRows = new Set(holdingsByDate.map((row) => row.snapshotId));

  for (const snapshot of snapshots) {
    if (datesWithRows.has(snapshot.id)) {
      continue;
    }

    signals.push({
      affected: { id: scope.id, label: scope.label, object: "scope" },
      category: "history_coverage",
      code: "MISSING_SNAPSHOT_ROWS",
      fixable: false,
      id: signalId("history_coverage", "MISSING_SNAPSHOT_ROWS", snapshot.id),
      label: `La captura del ${snapshot.dateKey} no tiene desglose de holdings.`,
      object: "data_quality_signal",
      observedDate: snapshot.dateKey,
      severity: "low",
    });
  }

  return signals;
}

/**
 * Connected-source positions that could not be valued (PRD #328, #341): a coin
 * with no candidate / no purchase price, or a token with no unit price, lands at
 * value 0 with a quality signal — surfaced here as a `medium` projection gap.
 * Only sources backing a holding the scope owns are walked.
 */
async function projectionGapSignals(
  store: AgentViewReadStore,
  ownedAssetIds: Set<string>,
): Promise<AgentViewDataQualitySignal[]> {
  const signals: AgentViewDataQualitySignal[] = [];

  for (const source of await store.readConnectedSources()) {
    if (!source.assetIds.some((assetId) => ownedAssetIds.has(assetId))) {
      continue;
    }

    const affected: AgentViewObjectReference = {
      id: deriveSourcePublicId(source.id),
      label: source.label,
      object: "connected_source",
    };

    for (const position of await store.readSourcePositions(source.id)) {
      const isUnvalued =
        position.kind === "token"
          ? position.unitPrice === null
          : coinValue(position).basis === "zero";

      if (!isUnvalued) {
        continue;
      }

      signals.push({
        affected,
        category: "projection_gap",
        code: "UNVALUED_POSITION",
        fixable: false,
        id: signalId(
          "projection_gap",
          "UNVALUED_POSITION",
          `${source.id}:${position.externalId}`,
        ),
        label: `La posición "${position.name}" de "${source.label}" no pudo valorarse.`,
        object: "data_quality_signal",
        severity: "medium",
      });
    }
  }

  return signals;
}

/** This signal's composite sort key: severity DESC, category, affected id, signal id. */
function sortKey(signal: AgentViewDataQualitySignal): DateIdKey {
  const categoryRank = CATEGORY_ORDER.indexOf(signal.category);
  const affectedId = signal.affected?.id ?? "";
  return {
    dateKey: `${SEVERITY_RANK[signal.severity]}|${categoryRank}|${affectedId}`,
    publicId: signal.id,
  };
}

/** Derive a signal's stable opaque id from its natural key (NOT row order). */
function signalId(
  category: AgentViewDataQualityCategory,
  code: string,
  affectedEntityId: string,
): string {
  return derivePublicId("dqs", `${category}:${code}:${affectedEntityId}`);
}

/** A conditionally-spread `affected` holding reference for a known public id. */
function affectedRef(
  holdingPublicIds: Map<string, string>,
  internalId: string,
  label: string,
): { affected: AgentViewObjectReference } {
  return {
    affected: {
      id: requirePublicId(holdingPublicIds, internalId),
      label,
      object: "holding",
    },
  };
}

function assetLabel(assets: ManualAsset[], assetId: string): string {
  return assets.find((asset) => asset.id === assetId)?.name ?? "";
}

/** The `YYYY-MM-DD` of an ISO instant. */
function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function emptySeverityCounts(): Record<AgentViewDataQualitySeverity, number> {
  return Object.fromEntries(ALL_SEVERITIES.map((severity) => [severity, 0])) as Record<
    AgentViewDataQualitySeverity,
    number
  >;
}

function emptyCategoryCounts(): Record<AgentViewDataQualityCategory, number> {
  return Object.fromEntries(CATEGORY_ORDER.map((category) => [category, 0])) as Record<
    AgentViewDataQualityCategory,
    number
  >;
}

function unknownScope(): AgentViewHttpError {
  return new AgentViewHttpError({
    code: "not_found",
    message: "Unknown scope.",
    status: 404,
  });
}
