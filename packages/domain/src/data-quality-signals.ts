/**
 * Data-quality signal collection (PRD #654 S1, #328) — pure domain engine.
 *
 * Collects the six signal categories for a scope using internal references only.
 * Consumers (agent view, home alert zone) wrap with public ids, pagination, and
 * fix-surface hrefs. Reads persisted inputs only — surfacing a warning never
 * writes an override (ADR 0023).
 */

import { instrumentOfAsset } from "./classification";
import { summarizeCoinValueGaps } from "./coin-value-gap";
import type { SourcePosition } from "./connected-source";
import { coinValue, positionValue } from "./connected-source";
import { daysBetween } from "./dates";
import { type DecimalString, formatUnits } from "./decimal";
import { INVESTMENT_PROFILE_INSTRUMENTS } from "./exposure-identity";
import type { FireScopeConfig } from "./fire";
import { valuationMethodOfAsset } from "./holding-method";
import type { InvestmentOperation } from "./investment-types";
import type { PriceFreshnessState } from "./prices";
import { describeSavingsDivergence, scopeSavingsCoherence } from "./savings-coherence";
import { resolveScopeMemberIds, type ScopeOption } from "./scope";
import { scopeOwnedHoldingIds } from "./scope-holdings";
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
  | "savings_coherence"
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

/**
 * Un intento de sync tal como la salud de datos lo lee (#1226): en qué acabó y
 * cuándo. Es la proyección de una fila de `sync_run` — no una traducción: los
 * mismos cuatro estados, el instante ya resuelto por quien tiene la fila delante.
 * El motivo del fallo NO viaja: su `message` viene de un `catch` (mensaje de
 * driver, a veces un token en la cadena de conexión) y su sitio es el log del
 * servidor, así que la señal habla de cuántos intentos fallaron y remite a la
 * página, que es donde el `code` se traduce.
 */
export interface DataQualitySyncAttempt {
  /** `pending`/`running` son no terminales: un intento en vuelo aún no dice nada. */
  status: "pending" | "running" | "ok" | "error";
  /** El instante que fecha el intento, o null si la fila no fechó ninguno. */
  at: string | null;
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
  /**
   * Los intentos de sync retenidos por fuente, NEWEST-FIRST (#1226) — el eje que
   * cuenta cuántas veces seguidas ha fallado algo, que la frescura no sabe contar.
   * Requerido, no opcional, por la misma razón que `netUnitsByAssetId`: una alerta
   * que solo uno de los dos consumidores alimenta es una alerta sobre la que el
   * humano y el agente se contradicen. Un mapa vacío es la lectura honesta de «esta
   * fuente no ha intentado nada todavía».
   */
  syncAttemptsBySourceId: ReadonlyMap<string, readonly DataQualitySyncAttempt[]>;
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
  /**
   * The investment ledger keyed by holding id — the evidence behind the
   * declared-vs-measured savings watch (#1449). Required, not optional, for the
   * same reason `netUnitsByAssetId` is: both consumers already hold this map
   * (the shared projection context on the home, the per-holding reads on the
   * agent view), and a signal only one of them feeds is a signal the human and
   * the agent disagree about. An empty map reads as "no ledger", which silences
   * the watch rather than accusing anyone.
   */
  investmentOperationsByAssetId: ReadonlyMap<string, readonly InvestmentOperation[]>;
  /**
   * Frozen holding rows the coverage rules inspect (#1438). Required — not
   * optional — for the same reason `netUnitsByAssetId` is: both consumers feed
   * the same evidence. The home already holds the chart window's `holdingRows`
   * (same honesty as `MISSING_SNAPSHOT_ROWS`: out of window can under-count);
   * the agent-view already reads `readSnapshotHoldings({ scopeId })` in full.
   * `{ dateKey, holdingId, kind }` is enough — the signal never reads values.
   */
  snapshotHoldings: readonly DataQualitySnapshotHolding[];
  /**
   * Amortizable start date keyed by liability id (#1438). Empty = there are no
   * amortizable debts to evaluate, not "skip the signal". Both callers that
   * already read `debtModelByLiabilityId` fill this from the plan / first
   * re-baseline via `amortizableLiabilityStartDate` — the same rule the
   * membership predicate applies.
   */
  amortizableStartByLiabilityId: ReadonlyMap<string, string>;
  /** Calendar day the collection runs against (`YYYY-MM-DD`). */
  asOfDateKey: string;
}

/** One frozen holding row as the history-coverage signal reads it (#1438). */
export interface DataQualitySnapshotHolding {
  dateKey: string;
  holdingId: string;
  kind: "asset" | "liability";
}

/** Fixed v1 threshold for stale manual values (PRD #654 S2). */
export const STALE_MANUAL_VALUE_THRESHOLD_DAYS = 90;

/** Machine code for a stored holding without a recent manual value update. */
export const STALE_MANUAL_VALUE_CODE = "STALE_MANUAL_VALUE";

/** Machine code for a trashed holding whose position still holds units (#1365). */
export const TRASHED_WITH_BALANCE_CODE = "TRASHED_WITH_BALANCE";

/**
 * Machine code for an amortizable debt that is absent from every historical
 * snapshot after its start (#1438). One per debt, not one per snapshot.
 */
export const DEBT_MISSING_FROM_HISTORY_CODE = "DEBT_MISSING_FROM_HISTORY";

/**
 * Machine code for an investment priced by a provider symbol that carries NO ISIN
 * (#1489) — the orphan state, detectable in one query.
 *
 * The system's instrument identity is `isin ?? providerSymbol` (#539, ADR 0039), so a
 * symbol-only holding is not merely missing a label: a broker statement routing by
 * ISIN (ADR 0055) cannot land on it, the exposure catalog cannot hand it its profile,
 * and nothing in the product can decide that `IE00B52MJY50` and `SXR1.DE` are the same
 * ETF — which is how the assistant came to tell a real user his statement held a
 * DIFFERENT product from his own position.
 */
export const MISSING_INVESTMENT_ISIN_CODE = "MISSING_INVESTMENT_ISIN";

/**
 * Signal kinds the user may acknowledge as intentional via the persisted
 * `{code, entityId}` override shape (warnings + selected signal kinds).
 */
export const OVERRIDEABLE_SIGNAL_CODES = new Set<string>([
  "ZERO_VALUE_ASSET",
  "MISSING_PROVIDER_SYMBOL",
  "OVERSELL",
  "OVER_TRANSFER",
  STALE_MANUAL_VALUE_CODE,
  MISSING_INVESTMENT_ISIN_CODE,
]);

export function isOverrideableSignalCode(code: string): boolean {
  return OVERRIDEABLE_SIGNAL_CODES.has(code);
}

/**
 * Machine code for a scope whose declared savings capacity and measured savings
 * cannot both be true (#1449).
 */
export const SAVINGS_DECLARED_VS_MEASURED_CODE = "SAVINGS_DECLARED_VS_MEASURED";

/** Machine code for a connection whose sync keeps failing attempt after attempt (#1226). */
export const PERSISTENT_SYNC_FAILURE_CODE = "PERSISTENT_SYNC_FAILURE";

/**
 * Cuántos intentos terminales en error SEGUIDOS hacen que un sync sea
 * «persistente» (#1226) — el umbral que el PRD #1222 dejaba a la implementación.
 *
 * Dos, contados desde el más reciente. Uno solo no basta: un fallo aislado es un
 * proveedor que tosió o un error marcado `retriable`, y la página de conexiones ya
 * lo cuenta sin necesidad de alertar a nadie. Dos seguidos ya no se arreglan solos.
 * Con el cron dos veces al día eso son como mucho ~12 h hasta que la cifra
 * congelada deja de estar congelada en silencio — pronto para que no se podra,
 * tarde para que un hipo no dé la lata.
 *
 * `retriable` NO entra en la regla, aunque `SyncRunError` lo lleve: hoy TODO fallo
 * que llega a `sync_run` se marca retriable (el fetch se captura aguas arriba y no
 * abre corrida), así que una rama por no-retriable sería código muerto que promete
 * una política que nadie ejerce.
 */
export const PERSISTENT_SYNC_FAILURE_THRESHOLD = 2;

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
  "savings_coherence",
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
  const ownedAssetIds = scopeOwnedHoldingIds({
    assets: input.assets,
    liabilities: input.liabilities,
    scopeOption: input.scopeOption,
    workspace: input.workspace,
  });

  return [
    ...warningSignals(
      input.assets,
      input.warningOverrides,
      ownedAssetIds,
      input.netUnitsByAssetId,
      input.investmentOperationsByAssetId,
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
    ...persistentSyncFailureSignals(
      input.connectedSources,
      ownedAssetIds,
      input.syncAttemptsBySourceId,
      input.sourceFreshnessBySourceId,
    ),
    ...missingConfigurationSignals(
      input.scope,
      input.liabilities,
      ownedAssetIds,
      input.fireConfigByScopeId,
      input.debtModelByLiabilityId,
    ),
    ...missingInstrumentIdentitySignals(
      input.assets,
      ownedAssetIds,
      input.netUnitsByAssetId,
      input.warningOverrides,
    ),
    ...savingsCoherenceSignals(
      input.scope,
      input.workspace,
      ownedAssetIds,
      input.fireConfigByScopeId,
      input.investmentOperationsByAssetId,
      input.asOfDateKey,
    ),
    ...historyCoverageSignals(
      input.scope,
      input.snapshots,
      input.snapshotIdsWithHoldings,
      input.liabilities,
      input.debtModelByLiabilityId,
      input.amortizableStartByLiabilityId,
      input.snapshotHoldings,
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

function warningSignals(
  assets: readonly ManualAsset[],
  warningOverrides: readonly WarningOverride[],
  ownedAssetIds: Set<string>,
  netUnitsByAssetId: ReadonlyMap<string, DecimalString>,
  operationsByAssetId: ReadonlyMap<string, readonly InvestmentOperation[]>,
): DataQualitySignal[] {
  const overridden = new Set(
    warningOverrides.map((override) => `${override.code}:${override.entityId}`),
  );

  // Overrides are NOT passed to `collectWarnings`: an acknowledged warning stays
  // in the inventory and gets labelled instead of dropped. The closed-position
  // filter is different — a sold-out position has no pending task at all (#1348).
  return collectWarnings([...assets], [], {
    netUnitsByAssetId,
    operationsByAssetId,
  })
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
 *
 * «Sin venta ni traspaso» is literal (#1481): a ledger emptied by a `transfer_out`
 * folds to zero net units, so a holding that LEFT by traspaso never reaches this
 * signal — the same legitimate exit a sale is.
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

/**
 * Si una fuente pertenece al ámbito: alguno de los peldaños que materializa está
 * entre los holdings del ámbito. Una sola definición para las TRES señales de
 * fuente — si cada una decidiera la pertenencia por su cuenta, dos señales sobre la
 * misma fuente podrían discrepar de ámbito.
 */
function sourceIsInScope(
  source: DataQualityConnectedSource,
  ownedAssetIds: Set<string>,
): boolean {
  return source.assetIds.some((assetId) => ownedAssetIds.has(assetId));
}

function sourceFreshnessSignals(
  connectedSources: readonly DataQualityConnectedSource[],
  ownedAssetIds: Set<string>,
  sourceFreshnessBySourceId: ReadonlyMap<string, DataQualitySourceFreshness | null>,
): DataQualitySignal[] {
  const signals: DataQualitySignal[] = [];

  for (const source of connectedSources) {
    if (!sourceIsInScope(source, ownedAssetIds)) {
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

/**
 * Cuántos intentos han fallado SEGUIDOS, contando desde el más reciente (#1226).
 *
 * Los intentos no terminales se saltan en vez de cortar la racha: un reintento en
 * vuelo por delante no borra el veredicto de lo anterior — si lo borrase, la alerta
 * desaparecería justo mientras se reintenta y volvería al fallar, parpadeando. Es la
 * misma lectura que hace la píldora de la página con la «corrida terminal más
 * reciente» (#1224). El primer `ok` cierra la racha: ahí el sync volvió a funcionar.
 */
function consecutiveFailures(attempts: readonly DataQualitySyncAttempt[]): {
  count: number;
  latestFailureAt: string | null;
} {
  let count = 0;
  let latestFailureAt: string | null = null;

  for (const attempt of attempts) {
    if (attempt.status === "pending" || attempt.status === "running") {
      continue;
    }
    if (attempt.status === "ok") {
      break;
    }
    // La fecha es la del fallo MÁS RECIENTE, sea la que sea — incluido un `null`.
    // Con `??=` un intento reciente sin instante cedía la fecha a uno más viejo que
    // sí lo tenía, y la señal decía «falló el día que aún funcionaba».
    if (count === 0) {
      latestFailureAt = attempt.at;
    }
    count += 1;
  }

  return { count, latestFailureAt };
}

/**
 * Una conexión cuyo sync falla intento tras intento (#1226, PRD #1222 S4).
 *
 * Vive en la familia `source_freshness` a propósito: el objeto afectado es el
 * mismo (la fuente), la superficie donde se repara es la misma
 * (`/ajustes/conexiones`) y la pregunta que responde es la misma familia de
 * pregunta que `FAILED_SOURCE_SYNC` — «¿por qué no se mueve esto?». Lo que añade es
 * el eje que la frescura no tiene: la CUENTA.
 *
 * DONDE ESTA SEÑAL SE APARTA DE LA PROSA DE #1226: el issue la clasificaba como
 * «una señal que NO toca la cifra de hoy», remitiendo al filtro que aparta del home
 * lo que solo afecta a proyecciones o al histórico (`NON_FIGURE_CATEGORIES`), y esa
 * lectura la habría dejado únicamente en la superficie del agente. No cabe con sus
 * propios criterios de aceptación, que piden «alerta visible en las superficies de
 * data-health CON LINK a la página» y que la exposición agent/MCP sea un «también»:
 * el contrato del agente no lleva `href`, así que fuera del home no queda ninguna
 * superficie que cumpla lo primero. Y la premisa tampoco se sostiene: la cifra de
 * hoy no está intacta, está CONGELADA — es el número de hace días presentándose
 * como el de hoy, que es exactamente lo que el bloque del home existe para avisar.
 * Así que hereda el tratamiento de la familia `source_freshness`: llega al home,
 * como su hermana de fetch.
 *
 * `high`, como el fallo de fetch, por lo mismo. `fixable: false` porque lo que puede
 * fallar DENTRO de una corrida es nuestro guardado, no un dato que el usuario pueda
 * corregir; la frase, por eso, no le manda hacer nada y remite a la página, que es
 * donde el motivo se explica.
 *
 * Con `STALE_SOURCE_SYNC` (medium) conviven a propósito: un persist que falla no
 * mueve `last_sync_at`, así que la frescura se enrancia por detrás, y son dos
 * lecturas verdaderas y distintas («lleva días sin moverse» y «lo ha intentado N
 * veces sin conseguirlo») que juntas dicen más. En el home no hacen ruido: el bloque
 * se queda solo con el tramo de severidad más alta, y esta es `high`.
 *
 * Con `FAILED_SOURCE_SYNC` (high) NO conviven, y por eso esta cede: si el fetch está
 * roto AHORA, esa es la causa viva, y las corridas en error que quedan detrás son la
 * avería anterior de la misma conexión. Dos líneas rojas sobre Binance ocupando dos
 * de los tres huecos del bloque serían un signo repetido sobre una sola cosa que
 * hacer, y la colección se levanta «una señal por cosa que el usuario haría». No se
 * pierde aviso: la de fetch es igual de `high` y apunta al mismo sitio.
 *
 * La cuenta va en la frase (no «falla mucho», sino cuántas veces) y siempre es ≥ 2
 * por el umbral, así que el plural nunca tiene que ramificar.
 */
function persistentSyncFailureSignals(
  connectedSources: readonly DataQualityConnectedSource[],
  ownedAssetIds: Set<string>,
  syncAttemptsBySourceId: ReadonlyMap<string, readonly DataQualitySyncAttempt[]>,
  sourceFreshnessBySourceId: ReadonlyMap<string, DataQualitySourceFreshness | null>,
): DataQualitySignal[] {
  const signals: DataQualitySignal[] = [];

  for (const source of connectedSources) {
    if (!sourceIsInScope(source, ownedAssetIds)) {
      continue;
    }

    const freshness = sourceFreshnessBySourceId.get(source.id) ?? null;
    if (sourceFreshnessStatus(source, freshness) === "failed") {
      continue;
    }

    const { count, latestFailureAt } = consecutiveFailures(
      syncAttemptsBySourceId.get(source.id) ?? [],
    );
    if (count < PERSISTENT_SYNC_FAILURE_THRESHOLD) {
      continue;
    }

    signals.push({
      affected: {
        id: source.id,
        label: source.label,
        object: "connected_source",
      },
      category: "source_freshness",
      code: PERSISTENT_SYNC_FAILURE_CODE,
      fixable: false,
      label:
        `Las últimas ${count} sincronizaciones de "${source.label}" fallaron: sus cifras ` +
        "siguen congeladas en la última que funcionó.",
      naturalKey: signalNaturalKey(
        "source_freshness",
        PERSISTENT_SYNC_FAILURE_CODE,
        source.id,
      ),
      ...(latestFailureAt === null ? {} : { observedDate: dateOnly(latestFailureAt) }),
      severity: "high",
    });
  }

  return signals;
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

/**
 * Whether a holding is in scope for {@link MISSING_INVESTMENT_ISIN_CODE} at all.
 *
 * Four exclusions, each one a state where the missing ISIN is not a pending task:
 *  - a `stored`/`appreciating`/debt holding has no instrument identity to key;
 *  - a holding with NO provider symbol is already saying something worse, and
 *    `MISSING_PROVIDER_SYMBOL` says it — two signals over one hole would just teach
 *    the user to ignore both;
 *  - a connected-source rung is identified by its source (a Binance token has no
 *    ISIN and never will), exactly as it is exempt from the symbol warning (#685);
 *  - `crypto` (and anything else outside {@link INVESTMENT_PROFILE_INSTRUMENTS}) has
 *    no ISIN to be missing — the same set that decides who gets a look-through
 *    profile, read here so the two can never disagree about who HAS an identity.
 */
function isMissingIsinCandidate(asset: ManualAsset): boolean {
  return (
    valuationMethodOfAsset(asset) === "derived" &&
    !asset.isin &&
    Boolean(asset.providerSymbol) &&
    !asset.connectedSourceId &&
    INVESTMENT_PROFILE_INSTRUMENTS.has(instrumentOfAsset(asset))
  );
}

/**
 * The orphan investment: priced, valued, on screen — and unidentifiable (#1489).
 *
 * `low` on purpose, and the exception that proves it: nothing on screen is wrong. The
 * price arrives through the provider symbol, so today's figure is as good as any
 * other holding's. What is missing only bites LATER — the next statement that will not
 * route, the exposure profile that will not be inherited, the assistant that cannot
 * tell the same product from a different one. A `medium` here would rank a latent gap
 * above a stale price that is wrong right now.
 *
 * Overrideable (ADR 0004): a product genuinely without an ISIN exists — the user marks
 * it intentional once and the signal stops nagging, without leaving the inventory.
 * Closed positions are silent for the reason they are silent everywhere else (#1348):
 * a sold-out position no longer receives statements.
 */
function missingInstrumentIdentitySignals(
  assets: readonly ManualAsset[],
  ownedAssetIds: Set<string>,
  netUnitsByAssetId: ReadonlyMap<string, DecimalString>,
  warningOverrides: readonly WarningOverride[],
): DataQualitySignal[] {
  const overridden = new Set(
    warningOverrides.map((override) => `${override.code}:${override.entityId}`),
  );
  const signals: DataQualitySignal[] = [];

  for (const asset of assets) {
    if (
      !ownedAssetIds.has(asset.id) ||
      !isMissingIsinCandidate(asset) ||
      isClosedPosition(asset, netUnitsByAssetId)
    ) {
      continue;
    }

    const baseLabel =
      `"${asset.name}" no tiene ISIN: sin él un extracto no puede casar esta posición ` +
      "ni hereda su ficha de exposición. Añádelo en su ficha o márcalo como intencional.";
    signals.push({
      affected: { id: asset.id, label: asset.name, object: "holding" },
      category: "missing_configuration",
      code: MISSING_INVESTMENT_ISIN_CODE,
      fixable: true,
      label: signalLabelWithOverride(
        baseLabel,
        MISSING_INVESTMENT_ISIN_CODE,
        asset.id,
        overridden,
        true,
      ),
      naturalKey: signalNaturalKey(
        "missing_configuration",
        MISSING_INVESTMENT_ISIN_CODE,
        asset.id,
      ),
      severity: "low",
    });
  }

  return signals;
}

/**
 * The declared savings capacity against what the ledger measures (#1449) — the
 * counterweight to #1416's cut of the plan→FIRE derivation.
 *
 * The signal states the disagreement and shows all three figures (declared,
 * measured, gap). It deliberately does NOT decide which side is wrong: an
 * optimistic declaration, a stale spending figure, rents declared gross, and
 * savings that never reach an investment all produce the same shape, and only the
 * user knows which one it is. `medium`, like the other figure-shaping config
 * signals: nothing on screen is provably wrong, but the FIRE date is built on a
 * number that has now failed its only available check.
 *
 * Scopes with no FIRE config are silent here — `MISSING_FIRE_CONFIG` already
 * covers them, and there is no declared figure to disagree with.
 */
function savingsCoherenceSignals(
  scope: DataQualityScopeContext,
  workspace: Workspace,
  ownedAssetIds: Set<string>,
  fireConfigByScopeId: Readonly<Record<string, FireScopeConfig | undefined>>,
  investmentOperationsByAssetId: ReadonlyMap<string, readonly InvestmentOperation[]>,
  asOfDateKey: string,
): DataQualitySignal[] {
  const config = fireConfigByScopeId[scope.internalScopeId];
  if (config === undefined) {
    return [];
  }

  const coherence = scopeSavingsCoherence({
    asOfDateKey,
    config,
    currency: workspace.baseCurrency,
    operationsByAssetId: investmentOperationsByAssetId,
    ownedHoldingIds: ownedAssetIds,
  });

  if (coherence.state !== "diverged") {
    return [];
  }

  return [
    {
      affected: {
        id: scope.internalScopeId,
        label: scope.scopeLabel,
        object: "scope",
      },
      category: "savings_coherence",
      code: SAVINGS_DECLARED_VS_MEASURED_CODE,
      fixable: true,
      label: describeSavingsDivergence(coherence, workspace.baseCurrency),
      naturalKey: signalNaturalKey(
        "savings_coherence",
        SAVINGS_DECLARED_VS_MEASURED_CODE,
        scope.internalScopeId,
      ),
      severity: "medium",
    },
  ];
}

function historyCoverageSignals(
  scope: DataQualityScopeContext,
  snapshots: readonly NetWorthSnapshot[],
  snapshotIdsWithHoldings: ReadonlySet<string>,
  liabilities: readonly Liability[],
  debtModelByLiabilityId: ReadonlyMap<string, DebtModel | null>,
  amortizableStartByLiabilityId: ReadonlyMap<string, string>,
  snapshotHoldings: readonly DataQualitySnapshotHolding[],
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

  signals.push(
    ...debtMissingFromHistorySignals(
      liabilities,
      debtModelByLiabilityId,
      amortizableStartByLiabilityId,
      snapshotHoldings,
    ),
  );

  return signals;
}

/**
 * One signal per amortizable debt that is in NONE of the snapshots-with-holdings
 * dated on or after its start (#1438). Silent when that range has no holdings
 * rows at all — that is already `NO_SNAPSHOTS` / `SPARSE_SNAPSHOTS`.
 */
function debtMissingFromHistorySignals(
  liabilities: readonly Liability[],
  debtModelByLiabilityId: ReadonlyMap<string, DebtModel | null>,
  amortizableStartByLiabilityId: ReadonlyMap<string, string>,
  snapshotHoldings: readonly DataQualitySnapshotHolding[],
): DataQualitySignal[] {
  const signals: DataQualitySignal[] = [];
  for (const liability of liabilities) {
    if (debtModelByLiabilityId.get(liability.id) !== "amortizable") continue;
    const startDate = amortizableStartByLiabilityId.get(liability.id);
    if (startDate === undefined) continue;

    const inRange = snapshotHoldings.filter((row) => row.dateKey >= startDate);
    const datesWithHoldings = new Set(inRange.map((row) => row.dateKey));
    if (datesWithHoldings.size === 0) continue;

    const presentOn = new Set(
      inRange
        .filter((row) => row.kind === "liability" && row.holdingId === liability.id)
        .map((row) => row.dateKey),
    );
    if (presentOn.size > 0) continue;

    signals.push({
      affected: {
        id: liability.id,
        label: liability.name,
        object: "holding",
      },
      category: "history_coverage",
      code: DEBT_MISSING_FROM_HISTORY_CODE,
      fixable: true,
      label: `La deuda "${liability.name}" no aparece en ninguna captura histórica posterior a su inicio (${startDate}).`,
      naturalKey: signalNaturalKey(
        "history_coverage",
        DEBT_MISSING_FROM_HISTORY_CODE,
        liability.id,
      ),
      observedDate: startDate,
      severity: "high",
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
    if (!sourceIsInScope(source, ownedAssetIds)) {
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
