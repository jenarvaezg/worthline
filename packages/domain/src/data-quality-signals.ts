/**
 * Data-quality signal collection (PRD #654 S1, #328) — pure domain facade.
 *
 * A REGISTRY of collectors, not an engine: each family of signal lives in its own
 * module, owns its rule and declares the slice of input it reads. This file
 * resolves what every family shares (scope ownership, acknowledgements), runs the
 * registry in order, and concatenates. Adding a family means adding a module and
 * one line to the registry — never a field to a bag here.
 *
 * Consumers (agent view, home alert zone) wrap the result with public ids,
 * pagination, and fix-surface hrefs. Reads persisted inputs only — surfacing a
 * warning never writes an override (ADR 0023).
 */

import {
  type DataQualityCollector,
  type DataQualityOverrideInput,
  type DataQualityScopeContext,
  type DataQualityScopeFacts,
  type DataQualitySignal,
  overriddenSignalKeys,
} from "./data-quality-collector";
import type { DataQualitySourceHealthInput } from "./data-quality-connected-source";
import {
  COST_BASIS_VALUE_ONLY_CODE,
  collectCostBasisSignals,
  type DataQualityCostBasisInput,
} from "./data-quality-cost-basis";
import {
  collectHistoryCoverageSignals,
  type DataQualityHistoryCoverageInput,
} from "./data-quality-history-coverage";
import {
  collectInstrumentIdentitySignals,
  type DataQualityInstrumentIdentityInput,
  MISSING_INVESTMENT_ISIN_CODE,
} from "./data-quality-instrument-identity";
import {
  collectManualValueFreshnessSignals,
  type DataQualityManualValueFreshnessInput,
  STALE_MANUAL_VALUE_CODE,
} from "./data-quality-manual-value-freshness";
import {
  collectMissingConfigurationSignals,
  type DataQualityMissingConfigurationInput,
} from "./data-quality-missing-configuration";
import {
  collectPersistentSyncFailureSignals,
  type DataQualityPersistentSyncFailureInput,
} from "./data-quality-persistent-sync-failure";
import {
  collectPortfolioReconciliationSignals,
  type DataQualityPortfolioReconciliationInput,
} from "./data-quality-portfolio-reconciliation";
import {
  collectPriceFreshnessSignals,
  type DataQualityPriceFreshnessInput,
} from "./data-quality-price-freshness";
import {
  collectProjectionGapSignals,
  type DataQualityProjectionGapInput,
} from "./data-quality-projection-gap";
import {
  collectSavingsCoherenceSignals,
  type DataQualitySavingsCoherenceInput,
} from "./data-quality-savings-coherence";
import { collectSourceFreshnessSignals } from "./data-quality-source-freshness";
import {
  collectSpendingDebtServiceSignals,
  type DataQualitySpendingDebtServiceInput,
} from "./data-quality-spending-debt-service";
import {
  collectTransferIntegritySignals,
  type DataQualityTransferIntegrityInput,
} from "./data-quality-transfer-integrity";
import {
  collectTrashedBalanceSignals,
  type DataQualityTrashedBalanceInput,
} from "./data-quality-trashed-balance";
import {
  collectWarningSignals,
  type DataQualityWarningInput,
} from "./data-quality-warning-signals";
import { resolveScopeMemberIds, type ScopeOption } from "./scope";
import { scopeOwnedHoldingIds } from "./scope-holdings";
import type { Liability, ManualAsset, Workspace } from "./workspace-types";

export type {
  DataQualityAffectedObject,
  DataQualityAffectedRef,
  DataQualityCategory,
  DataQualityScopeContext,
  DataQualitySeverity,
  DataQualitySignal,
} from "./data-quality-collector";
export {
  compareDataQualitySignals,
  DATA_QUALITY_CATEGORY_ORDER,
  dataQualitySignalSortKey,
} from "./data-quality-collector";
export type {
  DataQualityConnectedSource,
  DataQualitySourceFreshness,
} from "./data-quality-connected-source";
export { sourceFreshnessStatus } from "./data-quality-connected-source";
export { COST_BASIS_VALUE_ONLY_CODE } from "./data-quality-cost-basis";
export type { DataQualitySnapshotHolding } from "./data-quality-history-coverage";
export {
  DEBT_MISSING_FROM_HISTORY_CODE,
  SPARSE_SNAPSHOT_THRESHOLD,
} from "./data-quality-history-coverage";
export { MISSING_INVESTMENT_ISIN_CODE } from "./data-quality-instrument-identity";
export {
  STALE_MANUAL_VALUE_CODE,
  STALE_MANUAL_VALUE_THRESHOLD_DAYS,
} from "./data-quality-manual-value-freshness";
export type { DataQualitySyncAttempt } from "./data-quality-persistent-sync-failure";
export {
  PERSISTENT_SYNC_FAILURE_CODE,
  PERSISTENT_SYNC_FAILURE_THRESHOLD,
} from "./data-quality-persistent-sync-failure";
export { PORTFOLIO_DECLARED_VS_DERIVED_CODE } from "./data-quality-portfolio-reconciliation";
export type { DataQualityPriceFreshness } from "./data-quality-price-freshness";
export { SAVINGS_DECLARED_VS_MEASURED_CODE } from "./data-quality-savings-coherence";
export { SPENDING_VS_DEBT_SERVICE_CODE } from "./data-quality-spending-debt-service";
export { TRANSFER_PAIR_BROKEN_CODE } from "./data-quality-transfer-integrity";
export type { DataQualityTrashedHolding } from "./data-quality-trashed-balance";
export { TRASHED_WITH_BALANCE_CODE } from "./data-quality-trashed-balance";

/**
 * What the facade itself needs to decide who belongs to the scope, before any
 * family runs.
 */
interface DataQualityScopeInput {
  scope: DataQualityScopeContext;
  workspace: Workspace;
  scopeOption: ScopeOption;
  assets: readonly ManualAsset[];
  liabilities: readonly Liability[];
}

/**
 * The collection input: the union of what the registered families declare.
 *
 * Every field is documented in the module that READS it. This interface only
 * composes them, so a new family widens the input by extending this list rather
 * than by growing a hand-maintained bag — and if two families ever disagree about
 * the shape of a shared field, this is where the compiler says so.
 */
export interface CollectDataQualitySignalsInput
  extends DataQualityScopeInput,
    DataQualityOverrideInput,
    DataQualitySourceHealthInput,
    DataQualityWarningInput,
    DataQualityTrashedBalanceInput,
    DataQualityManualValueFreshnessInput,
    DataQualityPriceFreshnessInput,
    DataQualityPersistentSyncFailureInput,
    DataQualityMissingConfigurationInput,
    DataQualityInstrumentIdentityInput,
    DataQualityCostBasisInput,
    DataQualitySavingsCoherenceInput,
    DataQualitySpendingDebtServiceInput,
    DataQualityPortfolioReconciliationInput,
    DataQualityTransferIntegrityInput,
    DataQualityHistoryCoverageInput,
    DataQualityProjectionGapInput {}

/**
 * The registry, in the order its signals are concatenated. Category order is a
 * separate decision (`DATA_QUALITY_CATEGORY_ORDER`, applied by
 * `compareDataQualitySignals`); this order only fixes what a caller that does NOT
 * sort sees, so it stays stable.
 */
const DATA_QUALITY_COLLECTORS: readonly DataQualityCollector<CollectDataQualitySignalsInput>[] =
  [
    collectWarningSignals,
    collectTrashedBalanceSignals,
    collectManualValueFreshnessSignals,
    collectPriceFreshnessSignals,
    collectSourceFreshnessSignals,
    collectPersistentSyncFailureSignals,
    collectMissingConfigurationSignals,
    collectInstrumentIdentitySignals,
    collectCostBasisSignals,
    collectSavingsCoherenceSignals,
    collectSpendingDebtServiceSignals,
    collectPortfolioReconciliationSignals,
    collectTransferIntegritySignals,
    collectHistoryCoverageSignals,
    collectProjectionGapSignals,
  ];

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
  // «No sé lo que costó» is a permanent answer for a plan opened in 2014 (#1505):
  // the user says so once instead of being asked on every pass.
  COST_BASIS_VALUE_ONLY_CODE,
]);

export function isOverrideableSignalCode(code: string): boolean {
  return OVERRIDEABLE_SIGNAL_CODES.has(code);
}

/**
 * Collect every data-quality signal relevant to a scope, in a deterministic order.
 * Asset/liability-level signals are filtered to holdings the scope owns; scope-
 * level signals (FIRE config, history coverage) use the internal scope id.
 *
 * It concatenates in registry order and does NOT sort: presentation order is the
 * consumer's call (`compareDataQualitySignals`), because the home hero and the
 * agent view paginate and truncate differently. Sorting here would silently
 * reorder what a caller that does not sort already shows.
 */
export function collectDataQualitySignals(
  input: CollectDataQualitySignalsInput,
): DataQualitySignal[] {
  const context: CollectDataQualitySignalsInput & DataQualityScopeFacts = {
    ...input,
    ...scopeFacts(input),
  };

  return DATA_QUALITY_COLLECTORS.flatMap((collect) => collect(context));
}

/** Resolved once, for every family — see `DataQualityScopeFacts`. */
function scopeFacts(input: CollectDataQualitySignalsInput): DataQualityScopeFacts {
  return {
    overriddenKeys: overriddenSignalKeys(input.warningOverrides),
    ownedAssetIds: scopeOwnedHoldingIds({
      assets: input.assets,
      liabilities: input.liabilities,
      scopeOption: input.scopeOption,
      workspace: input.workspace,
    }),
    scopeMemberIds: new Set(
      resolveScopeMemberIds(input.workspace, input.scope.internalScopeId),
    ),
  };
}
