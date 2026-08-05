/**
 * Data-quality signal collection (PRD #654 S1, #328) — pure domain engine.
 *
 * Collects the six signal categories for a scope using internal references only.
 * Consumers (agent view, home alert zone) wrap with public ids, pagination, and
 * fix-surface hrefs. Reads persisted inputs only — surfacing a warning never
 * writes an override (ADR 0023).
 */

import { summarizeCoinValueGaps } from "./coin-value-gap";
import type { SourcePosition } from "./connected-source";
import { coinValue, positionValue } from "./connected-source";
import { daysBetween } from "./dates";
import { type DecimalString, formatUnits } from "./decimal";
import type { FireScopeConfig } from "./fire";
import { valuationMethodOfAsset } from "./holding-method";
import { projectPortfolio } from "./portfolio-projection";
import type { PriceFreshnessState } from "./prices";
import { resolveScopeMemberIds, type ScopeOption } from "./scope";
import type { NetWorthSnapshot } from "./snapshot-types";
import { lastManualValueUpdateDateKey, type ManualValuePoint } from "./value-history";
import {
  collectWarnings,
  type DomainWarning,
  isClosedPosition,
  unitsReadAsClosed,
  type WarningOverride,
  type WarningSeverity,
} from "./warnings";
import type { DebtModel, Liability, ManualAsset, Workspace } from "./workspace-types";

export type DataQualityCategory =
  | "warning"
  | "trashed_balance"
  | "manual_value_freshness"
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

/**
 * A soft-deleted holding as the health engine sees it (#1365). Carries only what
 * the trashed-balance rule needs: who it is, and which members own a share of it —
 * the trash is outside every live read, so its scope relevance is decided by
 * ownership intersection exactly as the trash listing decides it (#342), not by
 * the portfolio projection (which, by definition, cannot see it).
 */
export interface DataQualityTrashedHolding {
  id: string;
  name: string;
  ownerMemberIds: readonly string[];
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
  /**
   * The workspace's soft-deleted holdings (#1365). Required — not optional — for
   * the same reason `netUnitsByAssetId` is: a signal about the trash that only
   * one of the two consumers feeds is a signal the agent and the human disagree
   * about. An empty array is the honest reading of "nothing in the trash".
   */
  trashedHoldings: readonly DataQualityTrashedHolding[];
  warningOverrides: readonly WarningOverride[];
  fireConfigByScopeId: Readonly<Record<string, FireScopeConfig | undefined>>;
  snapshots: readonly NetWorthSnapshot[];
  snapshotIdsWithHoldings: ReadonlySet<string>;
  priceFreshnessByAssetId: ReadonlyMap<string, DataQualityPriceFreshness>;
  sourceFreshnessBySourceId: ReadonlyMap<string, DataQualitySourceFreshness | null>;
  debtModelByLiabilityId: ReadonlyMap<string, DebtModel | null>;
  positionsBySourceId: ReadonlyMap<string, readonly SourcePosition[]>;
  /** Manual value audit history keyed by asset id. */
  manualValueHistoryByAssetId: ReadonlyMap<string, readonly ManualValuePoint[]>;
  /** Asset creation timestamps (ISO), keyed by asset id — stale-manual fallback. */
  assetCreatedAtById: ReadonlyMap<string, string>;
  /**
   * Net units still held per investment holding (`netUnitsByAsset`), for holdings
   * with at least one recorded operation. Required — not optional — so both
   * consumers of this engine (the home hero and the agent view's
   * `get_data_quality`) are forced to feed the SAME closed-position filter
   * instead of each growing its own (#1348).
   */
  netUnitsByAssetId: ReadonlyMap<string, DecimalString>;
  /** Calendar day the collection runs against (`YYYY-MM-DD`). */
  asOfDateKey: string;
}

/** Fixed v1 threshold for stale manual values (PRD #654 S2). */
export const STALE_MANUAL_VALUE_THRESHOLD_DAYS = 90;

/** Machine code for a stored holding without a recent manual value update. */
export const STALE_MANUAL_VALUE_CODE = "STALE_MANUAL_VALUE";

/** Machine code for a trashed holding whose position still holds units (#1365). */
export const TRASHED_WITH_BALANCE_CODE = "TRASHED_WITH_BALANCE";

/**
 * Signal kinds the user may acknowledge as intentional via the persisted
 * `{code, entityId}` override shape (warnings + selected signal kinds).
 */
export const OVERRIDEABLE_SIGNAL_CODES = new Set<string>([
  "ZERO_VALUE_ASSET",
  "MISSING_PROVIDER_SYMBOL",
  STALE_MANUAL_VALUE_CODE,
]);

export function isOverrideableSignalCode(code: string): boolean {
  return OVERRIDEABLE_SIGNAL_CODES.has(code);
}

/** Few-snapshots threshold below which history coverage is flagged sparse (#341). */
export const SPARSE_SNAPSHOT_THRESHOLD = 3;

/** Stable category order for the secondary sort key (PRD #328). */
export const DATA_QUALITY_CATEGORY_ORDER: readonly DataQualityCategory[] = [
  "warning",
  "trashed_balance",
  "manual_value_freshness",
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
    ...warningSignals(
      input.assets,
      input.warningOverrides,
      ownedAssetIds,
      input.netUnitsByAssetId,
    ),
    ...trashedBalanceSignals(
      input.trashedHoldings,
      input.netUnitsByAssetId,
      new Set(resolveScopeMemberIds(input.workspace, input.scope.internalScopeId)),
    ),
    ...staleManualValueSignals(
      input.assets,
      ownedAssetIds,
      input.manualValueHistoryByAssetId,
      input.assetCreatedAtById,
      input.asOfDateKey,
      input.warningOverrides,
    ),
    ...priceFreshnessSignals(
      input.assets,
      ownedAssetIds,
      input.priceFreshnessByAssetId,
      input.netUnitsByAssetId,
    ),
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
  netUnitsByAssetId: ReadonlyMap<string, DecimalString>,
): DataQualitySignal[] {
  const overridden = new Set(
    warningOverrides.map((override) => `${override.code}:${override.entityId}`),
  );

  // Overrides are NOT passed to `collectWarnings`: an acknowledged warning stays
  // in the inventory and gets labelled instead of dropped. The closed-position
  // filter is different — a sold-out position has no pending task at all (#1348).
  return collectWarnings([...assets], [], { netUnitsByAssetId })
    .filter((warning) => ownedAssetIds.has(warning.entityId))
    .map((warning) => warningToSignal(warning, overridden, assets));
}

function warningToSignal(
  warning: DomainWarning,
  overridden: Set<string>,
  assets: readonly ManualAsset[],
): DataQualitySignal {
  const label = signalLabelWithOverride(
    warning.message,
    warning.code,
    warning.entityId,
    overridden,
    warning.severity === "overrideable",
  );

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

/**
 * A holding sitting in the Papelera with units still on its ledger (#1365): its
 * value left the patrimonio at the capture after the delete, and the histórico
 * records no sale, no traspaso, and no deposit into any account. The money looks
 * evaporated — indistinguishable from the shape of someone who sold the fund and
 * then deleted it "porque ya no lo tengo" without recording the sale first.
 *
 * `high`, because unlike a stale price this is not a figure that MIGHT be wrong:
 * the drop already happened. Both repairs already exist on the trash listing and
 * both clear this signal by removing its cause — restore it and record the sale,
 * or hard-delete to confirm the borrado — so it needs no acknowledgement door of
 * its own (and, unlike an overrideable warning, a trashed holding has no ficha to
 * acknowledge it from).
 *
 * Positive evidence only: the holding must HAVE an entry in the net-units map and
 * that entry must not read as closed. A holding absent from the map — a cash
 * account, a flat, anything without an operations ledger — says nothing about
 * units and is silent here, rather than being flagged on a rule it cannot answer.
 */
function trashedBalanceSignals(
  trashedHoldings: readonly DataQualityTrashedHolding[],
  netUnitsByAssetId: ReadonlyMap<string, DecimalString>,
  scopeMemberIds: ReadonlySet<string>,
): DataQualitySignal[] {
  const signals: DataQualitySignal[] = [];

  for (const holding of trashedHoldings) {
    if (!holding.ownerMemberIds.some((memberId) => scopeMemberIds.has(memberId))) {
      continue;
    }

    const units = netUnitsByAssetId.get(holding.id);
    if (units === undefined || unitsReadAsClosed(units)) {
      continue;
    }

    signals.push({
      affected: { id: holding.id, label: holding.name, object: "holding" },
      category: "trashed_balance",
      code: TRASHED_WITH_BALANCE_CODE,
      fixable: true,
      label:
        `"${holding.name}" está en la Papelera con ${formatUnits(units)} unidades: su valor salió ` +
        "de tu patrimonio sin venta ni traspaso. Recupéralo y registra la venta, o confirma el borrado.",
      naturalKey: signalNaturalKey(
        "trashed_balance",
        TRASHED_WITH_BALANCE_CODE,
        holding.id,
      ),
      severity: "high",
    });
  }

  return signals;
}

function staleManualValueSignals(
  assets: readonly ManualAsset[],
  ownedAssetIds: Set<string>,
  manualValueHistoryByAssetId: ReadonlyMap<string, readonly ManualValuePoint[]>,
  assetCreatedAtById: ReadonlyMap<string, string>,
  asOfDateKey: string,
  warningOverrides: readonly WarningOverride[],
): DataQualitySignal[] {
  const overridden = new Set(
    warningOverrides.map((override) => `${override.code}:${override.entityId}`),
  );
  const signals: DataQualitySignal[] = [];

  for (const asset of assets) {
    if (!ownedAssetIds.has(asset.id) || valuationMethodOfAsset(asset) !== "stored") {
      continue;
    }

    const lastUpdateDateKey = lastManualValueUpdateDateKey(
      manualValueHistoryByAssetId.get(asset.id),
      assetCreatedAtById.get(asset.id),
    );
    if (lastUpdateDateKey === undefined) {
      continue;
    }

    if (daysBetween(lastUpdateDateKey, asOfDateKey) < STALE_MANUAL_VALUE_THRESHOLD_DAYS) {
      continue;
    }

    const baseLabel = `El valor manual de "${asset.name}" lleva más de ${STALE_MANUAL_VALUE_THRESHOLD_DAYS} días sin actualizarse.`;
    signals.push({
      affected: { id: asset.id, label: asset.name, object: "holding" },
      category: "manual_value_freshness",
      code: STALE_MANUAL_VALUE_CODE,
      fixable: true,
      label: signalLabelWithOverride(
        baseLabel,
        STALE_MANUAL_VALUE_CODE,
        asset.id,
        overridden,
        true,
      ),
      naturalKey: signalNaturalKey(
        "manual_value_freshness",
        STALE_MANUAL_VALUE_CODE,
        asset.id,
      ),
      observedDate: lastUpdateDateKey,
      severity: "medium",
    });
  }

  return signals;
}

function signalLabelWithOverride(
  baseLabel: string,
  code: string,
  entityId: string,
  overridden: Set<string>,
  overrideable: boolean,
): string {
  if (!overrideable || !overridden.has(`${code}:${entityId}`)) {
    return baseLabel;
  }

  return `${baseLabel} (marcado como intencional)`;
}

function priceFreshnessSignals(
  assets: readonly ManualAsset[],
  ownedAssetIds: Set<string>,
  priceFreshnessByAssetId: ReadonlyMap<string, DataQualityPriceFreshness>,
  netUnitsByAssetId: ReadonlyMap<string, DecimalString>,
): DataQualitySignal[] {
  const signals: DataQualitySignal[] = [];

  for (const asset of assets) {
    // The second half of #1348: a CLOSED position keeps its price-cache row, so
    // its quote goes stale (and, once the provider drops the symbol, fails)
    // forever — and FAILED_PRICE is `high`, which turns the home hero red over a
    // holding worth 0. A price nothing multiplies cannot compromise today's
    // figure, so a sold-out position is silent here for exactly the reason it is
    // silent for MISSING_PROVIDER_SYMBOL. Non-derived holdings are never in the
    // map, so their freshness signals are untouched.
    if (!ownedAssetIds.has(asset.id) || isClosedPosition(asset, netUnitsByAssetId)) {
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

/** Whether a position contributes nothing to the figure it sits under: a coin no
 *  rung could value, or a token with no unit price. Both rules are the domain's
 *  own valuation verdict, never re-derived here (ADR 0017/0021). */
function isUnvaluedPosition(position: SourcePosition): boolean {
  return position.kind === "coin"
    ? coinValue(position).basis === "zero"
    : positionValue(position.balance, position.unitPrice).basis === "zero";
}

/** How many things a position stands for: a coin line can be `×3` (and the
 *  collection view counts coins, not lines); a token balance is always one line. */
function positionUnitCount(position: SourcePosition): number {
  return position.kind === "coin" ? position.quantity : 1;
}

function sumUnits(positions: readonly SourcePosition[]): number {
  return positions.reduce((total, position) => total + positionUnitCount(position), 0);
}

/**
 * The es-ES words a source's unvalued positions are described with. Both the noun
 * and what they lack follow the SAME kind decision, so they can never disagree
 * ("monedas … sin fuente de precio"). A source is homogeneous in practice (Numista
 * mirrors coins, Binance tokens); a mixed one falls back to the generic noun.
 */
function unvaluedWording(
  positions: readonly SourcePosition[],
  count: number,
): { noun: string; lack: string } {
  const kinds = new Set(positions.map((position) => position.kind));
  if (kinds.size !== 1) {
    return { lack: "sin valor", noun: count === 1 ? "posición" : "posiciones" };
  }
  if (kinds.has("coin")) {
    return { lack: "sin valor", noun: count === 1 ? "moneda" : "monedas" };
  }
  return { lack: "sin fuente de precio", noun: count === 1 ? "token" : "tokens" };
}

/**
 * ONE signal per connected source, never one per position (#1356). A collection of
 * 178 coins with 77 unvalued used to push 77 identical lines into the panel and
 * bury everything actionable; the object affected was already the source, so the
 * count folds into the same natural key.
 *
 * The line says how many of how many, and — for a coin collection, whose zero has
 * several possible causes — WHAT is missing, which is the part the user can act on
 * (in Numista). An unpriced token has a single cause, so it gets no breakdown; a
 * mixed source gets none either, so a breakdown always partitions the count it
 * follows rather than explaining only part of it.
 */
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
    const unvalued = positions.filter(isUnvaluedPosition);
    if (unvalued.length === 0) {
      continue;
    }

    const total = sumUnits(positions);
    const affectedUnits = sumUnits(unvalued);
    const { noun, lack } = unvaluedWording(positions, total);
    const coins = unvalued.filter(
      (position): position is Extract<SourcePosition, { kind: "coin" }> =>
        position.kind === "coin",
    );
    const missing =
      coins.length === unvalued.length ? summarizeCoinValueGaps(coins) : null;

    signals.push({
      affected: {
        id: source.id,
        label: source.label,
        object: "connected_source",
      },
      category: "projection_gap",
      code: "UNVALUED_POSITION",
      fixable: false,
      label:
        `${affectedUnits} de ${total} ${noun} de "${source.label}" ${lack}, a 0 € en tu patrimonio.` +
        (missing === null ? "" : ` Lo que falta: ${missing}.`),
      naturalKey: signalNaturalKey("projection_gap", "UNVALUED_POSITION", source.id),
      severity: "medium",
    });
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
