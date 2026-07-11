/**
 * Data-quality signal collection (PRD #654 S1, #328) — pure domain engine.
 *
 * Collects the six signal categories for a scope using internal references only.
 * Consumers (agent view, home alert zone) wrap with public ids, pagination, and
 * fix-surface hrefs. Reads persisted inputs only — surfacing a warning never
 * writes an override (ADR 0023).
 */

import type { SourcePosition } from "./connected-source";
import { coinValue } from "./connected-source";
import type { FireScopeConfig } from "./fire";
import { projectPortfolio } from "./portfolio-projection";
import type { PriceFreshnessState } from "./prices";
import type { ScopeOption } from "./scope";
import type { NetWorthSnapshot } from "./snapshot-types";
import {
  collectWarnings,
  type DomainWarning,
  type WarningOverride,
  type WarningSeverity,
} from "./warnings";
import type { DebtModel, Liability, ManualAsset, Workspace } from "./workspace-types";

export type DataQualityCategory =
  | "warning"
  | "price_freshness"
  | "source_freshness"
  | "missing_configuration"
  | "history_coverage"
  | "projection_gap";

export type DataQualitySeverity = "high" | "medium" | "low";

export type DataQualityAffectedObject = "holding" | "scope" | "connected_source";

/** Internal reference to the object a signal concerns. */
export interface DataQualityAffectedRef {
  object: DataQualityAffectedObject;
  id: string;
  label: string;
}

/**
 * One normalized data-quality signal with internal references. The stable
 * `naturalKey` (`category:code:affectedEntityId`) is the identity seam for
 * public-id derivation and stable ordering.
 */
export interface DataQualitySignal {
  naturalKey: string;
  category: DataQualityCategory;
  severity: DataQualitySeverity;
  label: string;
  code: string;
  fixable: boolean;
  affected?: DataQualityAffectedRef;
  observedDate?: string;
  originalWarningType?: string;
}

export interface DataQualityScopeContext {
  internalScopeId: string;
  scopeLabel: string;
}

export interface DataQualityConnectedSource {
  id: string;
  label: string;
  assetIds: string[];
  lastSyncAt: string | null;
}

export interface DataQualityPriceFreshness {
  freshnessState: PriceFreshnessState;
  fetchedAt: string;
}

export interface DataQualitySourceFreshness {
  freshnessState: PriceFreshnessState;
  fetchedAt: string;
  staleReason?: string;
}

export interface CollectDataQualitySignalsInput {
  scope: DataQualityScopeContext;
  workspace: Workspace;
  scopeOption: ScopeOption;
  assets: readonly ManualAsset[];
  liabilities: readonly Liability[];
  connectedSources: readonly DataQualityConnectedSource[];
  warningOverrides: readonly WarningOverride[];
  fireConfigByScopeId: Readonly<Record<string, FireScopeConfig | undefined>>;
  snapshots: readonly NetWorthSnapshot[];
  snapshotIdsWithHoldings: ReadonlySet<string>;
  priceFreshnessByAssetId: ReadonlyMap<string, DataQualityPriceFreshness>;
  sourceFreshnessBySourceId: ReadonlyMap<string, DataQualitySourceFreshness | null>;
  debtModelByLiabilityId: ReadonlyMap<string, DebtModel | null>;
  positionsBySourceId: ReadonlyMap<string, readonly SourcePosition[]>;
}

/** Few-snapshots threshold below which history coverage is flagged sparse (#341). */
export const SPARSE_SNAPSHOT_THRESHOLD = 3;

/** Stable category order for the secondary sort key (PRD #328). */
export const DATA_QUALITY_CATEGORY_ORDER: readonly DataQualityCategory[] = [
  "warning",
  "price_freshness",
  "source_freshness",
  "missing_configuration",
  "history_coverage",
  "projection_gap",
];

const SEVERITY_RANK: Record<DataQualitySeverity, number> = {
  high: 0,
  low: 2,
  medium: 1,
};

/**
 * Collect every data-quality signal relevant to a scope, in a deterministic order.
 * Asset/liability-level signals are filtered to holdings the scope owns; scope-
 * level signals (FIRE config, history coverage) use the internal scope id.
 */
export function collectDataQualitySignals(
  input: CollectDataQualitySignalsInput,
): DataQualitySignal[] {
  const ownedAssetIds = ownedHoldingIds(
    input.workspace,
    input.scopeOption,
    input.assets,
    input.liabilities,
  );

  return [
    ...warningSignals(input.assets, input.warningOverrides, ownedAssetIds),
    ...priceFreshnessSignals(input.assets, ownedAssetIds, input.priceFreshnessByAssetId),
    ...sourceFreshnessSignals(
      input.connectedSources,
      ownedAssetIds,
      input.sourceFreshnessBySourceId,
    ),
    ...missingConfigurationSignals(
      input.scope,
      input.liabilities,
      ownedAssetIds,
      input.fireConfigByScopeId,
      input.debtModelByLiabilityId,
    ),
    ...historyCoverageSignals(
      input.scope,
      input.snapshots,
      input.snapshotIdsWithHoldings,
    ),
    ...projectionGapSignals(
      input.connectedSources,
      ownedAssetIds,
      input.positionsBySourceId,
    ),
  ];
}

/** Sort key: severity DESC, category, affected id, natural key. */
export function dataQualitySignalSortKey(signal: DataQualitySignal): {
  dateKey: string;
  tieBreaker: string;
} {
  const categoryRank = DATA_QUALITY_CATEGORY_ORDER.indexOf(signal.category);
  const affectedId = signal.affected?.id ?? "";
  return {
    dateKey: `${SEVERITY_RANK[signal.severity]}|${categoryRank}|${affectedId}`,
    tieBreaker: signal.naturalKey,
  };
}

export function compareDataQualitySignals(
  left: DataQualitySignal,
  right: DataQualitySignal,
): number {
  const a = dataQualitySignalSortKey(left);
  const b = dataQualitySignalSortKey(right);
  const byPrimary = a.dateKey.localeCompare(b.dateKey);
  if (byPrimary !== 0) {
    return byPrimary;
  }
  return a.tieBreaker.localeCompare(b.tieBreaker);
}

function ownedHoldingIds(
  workspace: Workspace,
  scope: ScopeOption,
  assets: readonly ManualAsset[],
  liabilities: readonly Liability[],
): Set<string> {
  const projection = projectPortfolio({
    assets: [...assets],
    liabilities: [...liabilities],
    scope,
    workspace,
  });
  return new Set([
    ...projection.sections[0].rows.map((row) => row.id),
    ...projection.sections[1].rows.map((row) => row.id),
  ]);
}

function warningSignals(
  assets: readonly ManualAsset[],
  warningOverrides: readonly WarningOverride[],
  ownedAssetIds: Set<string>,
): DataQualitySignal[] {
  const overridden = new Set(
    warningOverrides.map((override) => `${override.code}:${override.entityId}`),
  );

  return collectWarnings([...assets])
    .filter((warning) => ownedAssetIds.has(warning.entityId))
    .map((warning) => warningToSignal(warning, overridden, assets));
}

function warningToSignal(
  warning: DomainWarning,
  overridden: Set<string>,
  assets: readonly ManualAsset[],
): DataQualitySignal {
  const isOverridden = overridden.has(`${warning.code}:${warning.entityId}`);
  const label =
    warning.severity === "overrideable" && isOverridden
      ? `${warning.message} (marcado como intencional)`
      : warning.message;

  return {
    affected: {
      id: warning.entityId,
      label: assetLabel(assets, warning.entityId),
      object: "holding",
    },
    category: "warning",
    code: warning.code,
    fixable: true,
    label,
    naturalKey: signalNaturalKey("warning", warning.code, warning.entityId),
    originalWarningType: warning.code,
    severity: warningSeverity(warning.severity),
  };
}

function warningSeverity(severity: WarningSeverity): DataQualitySeverity {
  return severity === "blocking" ? "high" : "medium";
}

function priceFreshnessSignals(
  assets: readonly ManualAsset[],
  ownedAssetIds: Set<string>,
  priceFreshnessByAssetId: ReadonlyMap<string, DataQualityPriceFreshness>,
): DataQualitySignal[] {
  const signals: DataQualitySignal[] = [];

  for (const asset of assets) {
    if (!ownedAssetIds.has(asset.id)) {
      continue;
    }

    const freshness = priceFreshnessByAssetId.get(asset.id);
    const signal = priceFreshnessToSignal(asset, freshness);
    if (signal) {
      signals.push(signal);
    }
  }

  return signals;
}

function priceFreshnessToSignal(
  asset: ManualAsset,
  freshness: DataQualityPriceFreshness | undefined,
): DataQualitySignal | null {
  if (freshness === undefined) {
    return null;
  }

  if (freshness.freshnessState === "failed") {
    return {
      affected: { id: asset.id, label: asset.name, object: "holding" },
      category: "price_freshness",
      code: "FAILED_PRICE",
      fixable: false,
      label: `El último precio de "${asset.name}" falló al actualizarse.`,
      naturalKey: signalNaturalKey("price_freshness", "FAILED_PRICE", asset.id),
      observedDate: dateOnly(freshness.fetchedAt),
      severity: "high",
    };
  }

  if (freshness.freshnessState === "stale") {
    return {
      affected: { id: asset.id, label: asset.name, object: "holding" },
      category: "price_freshness",
      code: "STALE_PRICE",
      fixable: false,
      label: `El precio de "${asset.name}" está desactualizado.`,
      naturalKey: signalNaturalKey("price_freshness", "STALE_PRICE", asset.id),
      observedDate: dateOnly(freshness.fetchedAt),
      severity: "medium",
    };
  }

  return null;
}

function sourceFreshnessSignals(
  connectedSources: readonly DataQualityConnectedSource[],
  ownedAssetIds: Set<string>,
  sourceFreshnessBySourceId: ReadonlyMap<string, DataQualitySourceFreshness | null>,
): DataQualitySignal[] {
  const signals: DataQualitySignal[] = [];

  for (const source of connectedSources) {
    if (!source.assetIds.some((assetId) => ownedAssetIds.has(assetId))) {
      continue;
    }

    const freshness = sourceFreshnessBySourceId.get(source.id) ?? null;
    const status = sourceFreshnessStatus(source, freshness);
    if (status === null) {
      continue;
    }

    const isFailed = status === "failed";
    signals.push({
      affected: {
        id: source.id,
        label: source.label,
        object: "connected_source",
      },
      category: "source_freshness",
      code: isFailed ? "FAILED_SOURCE_SYNC" : "STALE_SOURCE_SYNC",
      fixable: false,
      label: isFailed
        ? `La última sincronización de "${source.label}" falló.`
        : `La sincronización de "${source.label}" está desactualizada.`,
      naturalKey: signalNaturalKey(
        "source_freshness",
        isFailed ? "FAILED_SOURCE_SYNC" : "STALE_SOURCE_SYNC",
        source.id,
      ),
      ...(freshness === null ? {} : { observedDate: dateOnly(freshness.fetchedAt) }),
      severity: isFailed ? "high" : "medium",
    });
  }

  return signals;
}

function sourceFreshnessStatus(
  source: DataQualityConnectedSource,
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

function missingConfigurationSignals(
  scope: DataQualityScopeContext,
  liabilities: readonly Liability[],
  ownedAssetIds: Set<string>,
  fireConfigByScopeId: Readonly<Record<string, FireScopeConfig | undefined>>,
  debtModelByLiabilityId: ReadonlyMap<string, DebtModel | null>,
): DataQualitySignal[] {
  const signals: DataQualitySignal[] = [];

  if (fireConfigByScopeId[scope.internalScopeId] === undefined) {
    signals.push({
      affected: {
        id: scope.internalScopeId,
        label: scope.scopeLabel,
        object: "scope",
      },
      category: "missing_configuration",
      code: "MISSING_FIRE_CONFIG",
      fixable: true,
      label: "Este ámbito no tiene configuración FIRE.",
      naturalKey: signalNaturalKey(
        "missing_configuration",
        "MISSING_FIRE_CONFIG",
        scope.internalScopeId,
      ),
      severity: "medium",
    });
  }

  for (const liability of liabilities) {
    if (!ownedAssetIds.has(liability.id) || liability.type !== "mortgage") {
      continue;
    }

    if ((debtModelByLiabilityId.get(liability.id) ?? null) === null) {
      signals.push({
        affected: { id: liability.id, label: liability.name, object: "holding" },
        category: "missing_configuration",
        code: "MISSING_DEBT_MODEL",
        fixable: true,
        label: `La hipoteca "${liability.name}" no tiene modelo de deuda.`,
        naturalKey: signalNaturalKey(
          "missing_configuration",
          "MISSING_DEBT_MODEL",
          liability.id,
        ),
        severity: "medium",
      });
    }
  }

  return signals;
}

function historyCoverageSignals(
  scope: DataQualityScopeContext,
  snapshots: readonly NetWorthSnapshot[],
  snapshotIdsWithHoldings: ReadonlySet<string>,
): DataQualitySignal[] {
  const signals: DataQualitySignal[] = [];

  if (snapshots.length < SPARSE_SNAPSHOT_THRESHOLD) {
    signals.push({
      affected: {
        id: scope.internalScopeId,
        label: scope.scopeLabel,
        object: "scope",
      },
      category: "history_coverage",
      code: snapshots.length === 0 ? "NO_SNAPSHOTS" : "SPARSE_SNAPSHOTS",
      fixable: false,
      label:
        snapshots.length === 0
          ? "Este ámbito no tiene capturas de patrimonio."
          : "Este ámbito tiene un histórico de capturas escaso.",
      naturalKey: signalNaturalKey(
        "history_coverage",
        snapshots.length === 0 ? "NO_SNAPSHOTS" : "SPARSE_SNAPSHOTS",
        scope.internalScopeId,
      ),
      severity: snapshots.length === 0 ? "medium" : "low",
    });
  }

  for (const snapshot of snapshots) {
    if (snapshotIdsWithHoldings.has(snapshot.id)) {
      continue;
    }

    signals.push({
      affected: {
        id: scope.internalScopeId,
        label: scope.scopeLabel,
        object: "scope",
      },
      category: "history_coverage",
      code: "MISSING_SNAPSHOT_ROWS",
      fixable: false,
      label: `La captura del ${snapshot.dateKey} no tiene desglose de holdings.`,
      naturalKey: signalNaturalKey(
        "history_coverage",
        "MISSING_SNAPSHOT_ROWS",
        snapshot.id,
      ),
      observedDate: snapshot.dateKey,
      severity: "low",
    });
  }

  return signals;
}

function projectionGapSignals(
  connectedSources: readonly DataQualityConnectedSource[],
  ownedAssetIds: Set<string>,
  positionsBySourceId: ReadonlyMap<string, readonly SourcePosition[]>,
): DataQualitySignal[] {
  const signals: DataQualitySignal[] = [];

  for (const source of connectedSources) {
    if (!source.assetIds.some((assetId) => ownedAssetIds.has(assetId))) {
      continue;
    }

    const positions = positionsBySourceId.get(source.id) ?? [];
    for (const position of positions) {
      const isUnvalued =
        position.kind === "token"
          ? position.unitPrice === null
          : coinValue(position).basis === "zero";

      if (!isUnvalued) {
        continue;
      }

      signals.push({
        affected: {
          id: source.id,
          label: source.label,
          object: "connected_source",
        },
        category: "projection_gap",
        code: "UNVALUED_POSITION",
        fixable: false,
        label: `La posición "${position.name}" de "${source.label}" está sin fuente de precio y se informa como 0.`,
        naturalKey: signalNaturalKey(
          "projection_gap",
          "UNVALUED_POSITION",
          `${source.id}:${position.externalId}`,
        ),
        severity: "medium",
      });
    }
  }

  return signals;
}

function signalNaturalKey(
  category: DataQualityCategory,
  code: string,
  affectedEntityId: string,
): string {
  return `${category}:${code}:${affectedEntityId}`;
}

function assetLabel(assets: readonly ManualAsset[], assetId: string): string {
  return assets.find((asset) => asset.id === assetId)?.name ?? "";
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}
