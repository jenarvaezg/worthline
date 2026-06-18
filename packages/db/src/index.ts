import type { LocalPersistenceStatus } from "@worthline/domain";
import type {
  BinanceHistoryCurve,
  CreateInvestmentOperationInput,
  CreateManualAssetInput,
  DebtBalanceCurveInputs,
  DebtModel,
  DecimalString,
  EarlyRepaymentMode,
  FireScopeConfig,
  FrozenIdentityCapture,
  HousingCurveInputs,
  InvestmentOperation,
  Liability,
  CoinPosition,
  ManualValuePoint,
  ManualAsset,
  OwnershipShare,
  SnapshotHoldingKind,
  WarningOverride,
  Workspace,
} from "@worthline/domain";
import {
  amortizationPaymentDatesUpTo,
  binanceCurveStartDate,
  binanceValueAtDate,
  buildSnapshotAtDate,
  coinValue,
  completedMonthEndDates,
  createNetWorthSnapshot,
  globalHoldingValueAtDate,
  historicalCapturedAt,
  housingAssetIdsOf,
  isHousingAsset,
  listScopeOptions,
  recalculateSnapshotForAsset,
  recalculateSnapshotForCoinAcquisition,
  recalculateSnapshotForConnectedValue,
  recalculateSnapshotForHousing,
  recalculateSnapshotForLiability,
  recalculateSnapshotForOwnership,
  resolveScopeMemberIds,
  selectInvestmentPrice,
} from "@worthline/domain";
import Database from "better-sqlite3";
import type { Database as DatabaseConnection } from "better-sqlite3";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  amortizationPlans,
  appSettings,
  assetOwnerships,
  assets,
  assetValuations,
  auditLog,
  connectedSources,
  earlyRepayments,
  interestRateRevisions,
  liabilities,
  liabilityBalanceAnchors,
  liabilityOwnerships,
  positions,
  snapshots,
  warningOverrides,
} from "./schema";
import {
  createAssetStore,
  type AddValuationAnchorInput,
  type AssetStore,
  type UpdateAssetInput,
  type UpdateValuationAnchorInput,
} from "./asset-store";
import {
  createConnectedSourceStore,
  mapPositionRow,
  type ConnectedSourceStore,
  type SourcePositionInput,
} from "./connected-source-store";
import { migrate, type MigrateResult } from "./migrate";

export { SCHEMA_VERSION } from "./migrate";
import {
  createLiabilityStore,
  type AddBalanceAnchorInput,
  type AddEarlyRepaymentInput,
  type AddInterestRateRevisionInput,
  type CreateAmortizationPlanInput,
  type LiabilityStore,
  type UpdateAmortizationPlanInput,
  type UpdateBalanceAnchorInput,
  type UpdateEarlyRepaymentInput,
  type UpdateInterestRateRevisionInput,
  type UpdateLiabilityInput,
} from "./liability-store";
import {
  createOperationsStore,
  type OperationsStore,
  type UpdateInvestmentOperationInput,
} from "./operations-store";
import {
  createSnapshotStore,
  readSnapshotHoldings,
  readSnapshots,
  type SaveSnapshotInput,
  type SnapshotHoldingRecord,
  type SnapshotStore,
} from "./snapshot-store";
import {
  createStoreContext,
  hardDeleteAssetTx,
  hardDeleteLiabilityTx,
  readAllOperations,
  readAllPriceCache,
  readAssets,
  readInvestmentMeta,
  readLiabilities,
  type StoreContext,
  type StoreDb,
} from "./store-context";
import {
  createWorkspaceStore,
  readWorkspace,
  type WorkspaceStore,
} from "./workspace-store";

export type {
  AddValuationAnchorInput,
  AssetStore,
  CreateInvestmentAssetInput,
  InvestmentAssetFull,
  InvestmentAssetMeta,
  UpdateAssetInput,
  UpdateInvestmentAssetInput,
  UpdateValuationAnchorInput,
  ValuationAnchorRecord,
} from "./asset-store";
export type {
  AddBalanceAnchorInput,
  AddEarlyRepaymentInput,
  AddInterestRateRevisionInput,
  AmortizationPlanRecord,
  BalanceAnchorRecord,
  CreateAmortizationPlanInput,
  EarlyRepaymentRecord,
  InterestRateRevisionRecord,
  LiabilityStore,
  UpdateAmortizationPlanInput,
  UpdateBalanceAnchorInput,
  UpdateEarlyRepaymentInput,
  UpdateInterestRateRevisionInput,
  UpdateLiabilityInput,
} from "./liability-store";
export type {
  ConnectSourceInput,
  ConnectedSourceRow,
  ConnectedSourceStore,
  PositionValuationUpdate,
  SourcePositionInput,
  ValuationFreshness,
} from "./connected-source-store";
export type {
  OperationsStore,
  UpdateInvestmentOperationInput,
  ValueUpdateCommand,
} from "./operations-store";
export type {
  PositionView,
  SaveSnapshotInput,
  ScopedPositionsWithDetails,
  SnapshotHoldingQuery,
  SnapshotHoldingRecord,
  SnapshotStore,
} from "./snapshot-store";
export type {
  ImportWorkspaceResult,
  InitializeWorkspaceInput,
  MemberOwnerships,
  WorkspaceStore,
} from "./workspace-store";

const bootstrapKey = "bootstrap.last_healthcheck_at";

export interface BootstrapHealthcheckOptions {
  databasePath?: string;
  dataDir?: string;
  now?: () => Date;
}

export interface WorthlineStoreOptions {
  databasePath?: string;
  dataDir?: string;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface TrashView {
  assets: Array<{ id: string; name: string }>;
  liabilities: Array<{ id: string; name: string }>;
}

/**
 * The full real_estate creation command for {@link WorthlineStore.createHousingHoldingAndRipple}.
 * The caller resolves the anchor ids (a determinism source — `createStableId`/seed
 * plumbing) and passes the acquisition anchor (and an optional initial valuation)
 * fully formed; the seam derives only the from-date (the acquisition date) and
 * `today`.
 */
export interface CreateHousingHoldingCommand {
  /** The asset row to create (must be `type: "real_estate"`). */
  asset: CreateManualAssetInput;
  /** The acquisition valuation anchor (carries its own resolved id). */
  acquisitionAnchor: AddValuationAnchorInput;
  /** The appreciation rate to set, or null to leave it unset. */
  annualAppreciationRate: DecimalString | null;
  /** An optional initial valuation anchor (carries its own resolved id). */
  initialValuation?: AddValuationAnchorInput;
}

/**
 * The WorthlineStore is a pure composite (Slice R6, PRD #120): the five focused
 * sub-stores expose every per-domain operation, and the store itself owns only
 * the cross-cutting concerns that span domains or have no natural home in a
 * single sub-store (the connection lifecycle, the papelera, warning overrides,
 * the audit log, FIRE config, and the cross-domain historical-snapshot
 * machinery). All per-domain work goes through `store.<domain>.<method>`.
 */
export interface WorthlineStore {
  /** Focused snapshot & position store (Slice R1). */
  snapshots: SnapshotStore;
  /** Focused asset store (Slice R2). */
  assets: AssetStore;
  /** Focused liability store (Slice R3). */
  liabilities: LiabilityStore;
  /** Focused operations & price-cache store (Slice R4). */
  operations: OperationsStore;
  /** Focused workspace lifecycle & member store (Slice R5). */
  workspace: WorkspaceStore;
  /** Connected-source persistence (PRD #160 / #163, ADR 0016/0017). */
  connectedSources: ConnectedSourceStore;

  // ── Cross-cutting (no per-domain home) ──────────────────────────────────────

  close: () => void;
  acknowledgeWarning: (code: string, entityId: string) => number;
  removeWarningOverride: (code: string, entityId: string) => void;
  readWarningOverrides: () => WarningOverride[];
  readTrash: () => TrashView;
  /** Hard-delete every trashed holding atomically. Returns how many of each kind were removed. */
  emptyTrash: () => { assets: number; liabilities: number };
  readAuditLog: (filter?: { entityId?: string }) => AuditLogEntry[];
  readFireConfig: () => Record<string, FireScopeConfig>;
  saveFireConfig: (scopeId: string, config: FireScopeConfig) => void;
  /**
   * Operation dated-fact seam (ADR 0020): persist ONE investment operation AND
   * ripple the snapshots it affects, atomically in a single transaction. The
   * caller no longer derives `today` nor makes a separate ripple call — both ride
   * this one method. `today` defaults to the current date; pass it to control the
   * cut-off in tests. Wraps `recordOperation` + the per-operation record ripple.
   */
  recordOperationAndRipple: (
    input: CreateInvestmentOperationInput,
    opts?: { today?: string },
  ) => void;
  /**
   * Batched operation dated-fact seam for a statement load (ADR 0020 / 0018):
   * persist every created and overwritten operation AND run ONE batched ripple
   * over all the dates they touch, atomically in a single transaction. The
   * affected from-date window is derived behind the seam from the persisted
   * operations themselves, never by the caller. `today` defaults to the current
   * date; pass it to control the cut-off in tests. Wraps `recordOperation` /
   * `updateOperation` + the batched operations ripple.
   */
  recordOperationsAndRipple: (params: {
    assetId: string;
    creates: CreateInvestmentOperationInput[];
    overwrites: UpdateInvestmentOperationInput[];
    today?: string;
  }) => void;
  /**
   * Operation dated-fact seam (ADR 0020): delete ONE investment operation AND
   * ripple the snapshots dated ≥ its date, atomically in a single transaction.
   * The asset id and from-date are derived behind the seam from the deleted row
   * itself — the caller passes only the operation id. Returns the deleted
   * operation's asset id and date, or null if not found (a not-found delete
   * ripples nothing). `today` defaults to the current date; pass it to control
   * the cut-off in tests. Wraps `deleteOperation` + the per-operation delete
   * ripple.
   */
  deleteOperationAndRipple: (params: {
    operationId: string;
    today?: string;
  }) => { assetId: string; executedAt: string } | null;
  /**
   * Valuation dated-fact seam (ADR 0020): persist ONE housing valuation anchor
   * AND ripple the snapshots from its date, atomically in one transaction. The
   * from-date is the anchor's own date, derived behind the seam; `today` defaults
   * to the current date (pass it to control the cut-off in tests). A future anchor
   * generates no history. Wraps `assets.addValuationAnchor` + the valuation ripple.
   */
  addValuationAnchorAndRipple: (
    input: AddValuationAnchorInput,
    opts?: { today?: string },
  ) => void;
  /**
   * Valuation dated-fact seam (ADR 0020): patch ONE valuation anchor AND ripple
   * the affected snapshots, atomically. The from-date is the earlier of the old
   * and new anchor dates, derived behind the seam from the row being edited; the
   * ripple is skipped when nothing changed or the from-date is in the future.
   * Returns 1 if updated, 0 if not found. Wraps `assets.updateValuationAnchor`.
   */
  updateValuationAnchorAndRipple: (
    anchorId: string,
    input: UpdateValuationAnchorInput,
    opts?: { today?: string },
  ) => number;
  /**
   * Valuation dated-fact seam (ADR 0020): delete ONE valuation anchor AND ripple
   * the snapshots from its date, atomically. The from-date is the deleted anchor's
   * own date, captured behind the seam before the delete; a not-found delete
   * ripples nothing and a future date generates no history. Returns 1 if removed,
   * 0 if not found. Wraps `assets.deleteValuationAnchor` + the valuation ripple.
   */
  deleteValuationAnchorAndRipple: (anchorId: string, opts?: { today?: string }) => number;
  /**
   * Valuation dated-fact seam (ADR 0020): set (or clear) the appreciation rate AND
   * ripple the rate-valued range, atomically. The earliest affected snapshot date
   * is derived behind the seam as min(first anchor date, earliest existing snapshot
   * carrying this asset) — covering the backward-compounding case (#184). The ripple
   * is skipped when there is nothing to ripple or the from-date is in the future.
   * `today` defaults to the current date. Wraps `assets.setAnnualAppreciationRate`
   * + the valuation ripple.
   */
  setAnnualAppreciationRateAndRipple: (
    assetId: string,
    rate: DecimalString | null,
    opts?: { today?: string },
  ) => void;
  /**
   * Valuation dated-fact seam (ADR 0020): persist the current housing value
   * (updateAssetValuation + upsert-today-market-anchor) AND ripple historical
   * snapshots, all atomically. The from-date is derived behind the seam as
   * min(first past anchor date, earliest existing snapshot) — the full
   * `firstHousingCurrentValueRippleDate` rule. `today` defaults to the current
   * date. The action passes only `(assetId, currentValue)`.
   */
  recordHousingValuationAndRipple: (
    assetId: string,
    currentValue: number,
    opts?: { today?: string },
  ) => void;
  /**
   * Valuation dated-fact seam (ADR 0020): re-derive the housing snapshots after a
   * non-dated-fact metadata edit (editAsset). No dated fact is persisted here; the
   * from-date is derived behind the seam as the first anchor/snapshot date
   * (`firstHousingEventDate` rule). Skips when nothing exists to ripple.
   * `today` defaults to the current date.
   */
  rippleHousingAfterAssetEdit: (assetId: string, opts?: { today?: string }) => void;
  /**
   * Ownership scope-axis seam (ADR 0020): patch ONE asset AND, if its ownership
   * split actually changed, re-derive history along the SCOPE axis, atomically.
   * The previous ownership and the did-it-change comparison are derived behind the
   * seam (the caller no longer reads `before` or compares splits). For a
   * `real_estate` asset the housing curve ripple is run instead — it already
   * re-weights every affected snapshot from the asset's new split — so a home
   * ownership edit folds into the same single seam call. `today` defaults to the
   * current date. Wraps `assets.updateAsset` + the ownership/housing ripple.
   */
  updateAssetAndRippleOwnership: (
    assetId: string,
    patch: UpdateAssetInput,
    opts?: { today?: string },
  ) => void;
  /**
   * Ownership scope-axis seam (ADR 0020): patch ONE liability AND, if its ownership
   * split actually changed, re-derive history along the SCOPE axis, atomically. The
   * previous ownership and the did-it-change comparison are derived behind the seam.
   * `today` defaults to the current date. Wraps `liabilities.updateLiability` + the
   * ownership ripple.
   */
  updateLiabilityAndRippleOwnership: (
    liabilityId: string,
    patch: UpdateLiabilityInput,
    opts?: { today?: string },
  ) => void;
  /**
   * Housing-creation dated-fact seam (ADR 0020): create ONE real_estate holding —
   * the asset row, its acquisition anchor, its appreciation rate, and an optional
   * initial valuation — AND ripple historical snapshots from the acquisition date,
   * all atomically. The from-date (the acquisition date) and `today` are derived
   * behind the seam; the caller resolves the anchor ids (a determinism source) and
   * passes them in the command. Wraps `assets.createManualAsset` +
   * `assets.addValuationAnchor` + `assets.setAnnualAppreciationRate` + the
   * valuation ripple.
   */
  createHousingHoldingAndRipple: (
    command: CreateHousingHoldingCommand,
    opts?: { today?: string },
  ) => void;
  /**
   * Debt dated-fact seam (ADR 0020): create ONE amortization plan AND ripple the
   * per-cuota history it implies, atomically. The affected dates are derived
   * behind the seam from the plan's own schedule (the `amortizable-plan` kind);
   * `today` defaults to the current date. Wraps `liabilities.createAmortizationPlan`.
   */
  createAmortizationPlanAndRipple: (
    input: CreateAmortizationPlanInput,
    opts?: { today?: string },
  ) => void;
  /**
   * Debt dated-fact seam (ADR 0020): patch ONE amortization plan AND re-ripple the
   * per-cuota history, atomically (the `amortizable-plan` kind). Returns 1 if
   * updated, 0 if not found. Wraps `liabilities.updateAmortizationPlan`.
   */
  updateAmortizationPlanAndRipple: (
    planId: string,
    input: UpdateAmortizationPlanInput,
    opts: { liabilityId: string; today?: string },
  ) => number;
  /**
   * Debt dated-fact seam (ADR 0020): delete ONE amortization plan AND ripple the
   * now-planless curve, atomically. The plan's disbursement date is captured behind
   * the seam before the delete and used as the recalc floor (the `amortizable-revision`
   * kind, which recalculates without generating — the curve falls back to
   * currentBalance, ADR 0019). Returns 1 if removed, 0 if not found. Wraps
   * `liabilities.deleteAmortizationPlan`.
   */
  deleteAmortizationPlanAndRipple: (opts: {
    liabilityId: string;
    today?: string;
  }) => number;
  /**
   * Debt dated-fact seam (ADR 0020): add ONE interest-rate revision AND recalculate
   * the snapshots from its date forward, atomically (the `amortizable-revision`
   * kind — a revision generates no new snapshot). The future guard rides the seam.
   * Wraps `liabilities.addInterestRateRevision`.
   */
  addInterestRateRevisionAndRipple: (
    input: AddInterestRateRevisionInput,
    opts: { liabilityId: string; today?: string },
  ) => void;
  /**
   * Debt dated-fact seam (ADR 0020 / 0025): patch ONE interest-rate revision AND
   * recalculate snapshots from the earlier of the old/new date, atomically. The
   * seam reads the OLD date + owning liability from the row it selects by id inside
   * the transaction, picks the earlier date, applies the future guard, and ripples.
   * Returns 1 if updated, 0 if not found. Wraps
   * `liabilities.updateInterestRateRevision`.
   */
  updateInterestRateRevisionAndRipple: (
    revisionId: string,
    input: UpdateInterestRateRevisionInput,
    opts?: { today?: string },
  ) => number;
  /**
   * Debt dated-fact seam (ADR 0020 / 0025): delete ONE interest-rate revision AND
   * recalculate snapshots from its date forward, atomically (the
   * `amortizable-revision` kind). The seam reads the removed date + owning liability
   * from the row it selects by id inside the transaction; the future guard rides the
   * seam. Returns 1 if removed, 0 if not found. Wraps
   * `liabilities.deleteInterestRateRevision`.
   */
  deleteInterestRateRevisionAndRipple: (
    revisionId: string,
    opts?: { today?: string },
  ) => number;
  /**
   * Debt dated-fact seam (ADR 0020): add ONE early repayment AND generate/recalculate
   * snapshots from its date, atomically (the `amortizable-repayment` kind — a past
   * repayment is a dated fact that generates its own snapshot). The future guard
   * rides the seam. Wraps `liabilities.addEarlyRepayment`.
   */
  addEarlyRepaymentAndRipple: (
    input: AddEarlyRepaymentInput,
    opts: { liabilityId: string; today?: string },
  ) => void;
  /**
   * Debt dated-fact seam (ADR 0020 / 0025): patch ONE early repayment AND ripple
   * from the earlier of the old/new date, atomically (the `amortizable-repayment`
   * kind). The seam reads the OLD date + owning liability from the row it selects by
   * id inside the transaction, picks the earlier date, applies the future guard, and
   * ripples. Returns 1 if updated, 0 if not found. Wraps
   * `liabilities.updateEarlyRepayment`.
   */
  updateEarlyRepaymentAndRipple: (
    repaymentId: string,
    input: UpdateEarlyRepaymentInput,
    opts?: { today?: string },
  ) => number;
  /**
   * Debt dated-fact seam (ADR 0020 / 0025): delete ONE early repayment AND
   * recalculate snapshots from its date forward, atomically. Deleting a dated fact
   * recalculates without generating, so it uses the `amortizable-revision` kind (the
   * curve no longer carries the repayment). The seam reads the removed date + owning
   * liability from the row it selects by id inside the transaction; the future guard
   * rides the seam. Returns 1 if removed, 0 if not found. Wraps
   * `liabilities.deleteEarlyRepayment`.
   */
  deleteEarlyRepaymentAndRipple: (
    repaymentId: string,
    opts?: { today?: string },
  ) => number;
  /**
   * Debt dated-fact seam (ADR 0020): add ONE balance anchor AND generate/recalculate
   * snapshots from its date, atomically (the `anchor` kind). The from-date is the
   * anchor's own date; a future anchor generates no history. Wraps
   * `liabilities.addBalanceAnchor`.
   */
  addBalanceAnchorAndRipple: (
    input: AddBalanceAnchorInput,
    opts?: { today?: string },
  ) => void;
  /**
   * Debt dated-fact seam (ADR 0020 / 0025): patch ONE balance anchor AND ripple
   * from the earlier of the old/new date, atomically (the `anchor` kind). The seam
   * reads the OLD date + owning liability from the row it selects by id inside the
   * transaction, picks the earlier date, applies the future guard, and ripples.
   * Returns 1 if updated, 0 if not found. Wraps `liabilities.updateBalanceAnchor`.
   */
  updateBalanceAnchorAndRipple: (
    anchorId: string,
    input: UpdateBalanceAnchorInput,
    opts?: { today?: string },
  ) => number;
  /**
   * Debt dated-fact seam (ADR 0020 / 0025): delete ONE balance anchor AND
   * recalculate snapshots from its date forward, atomically (the `anchor` kind).
   * The seam reads the removed date + owning liability from the row it selects by
   * id inside the transaction; the future guard rides the seam. Returns 1 if
   * removed, 0 if not found. Wraps `liabilities.deleteBalanceAnchor`.
   */
  deleteBalanceAnchorAndRipple: (anchorId: string, opts?: { today?: string }) => number;
  /**
   * One-shot backfill (ADR 0012, PRD #107): generate a historical snapshot for
   * every past operation date that has no snapshot yet, across all scopes.
   * Existing snapshots are never recalculated — only gaps are filled. Idempotent.
   * `today` defaults to the current date; pass it to control the cut-off in tests.
   */
  backfillHistoricalSnapshots: (today?: string) => void;
  /**
   * Sync a connected source's positions AND ripple coin purchase dates into
   * history (ADR 0017, S6 / #167). Replaces the source's positions wholesale and
   * re-rolls its live holding value (`connectedSources.syncPositions`), then for
   * every position seen for the FIRST time that records a purchase date, adds the
   * coin's value — frozen at this sync — to each existing snapshot dated on/after
   * that purchase date. A position already seen on a prior sync is never rippled
   * again (so a later price move never rewrites a past snapshot), and a position
   * that disappeared (sold on Numista) simply leaves the live holding while its
   * value stays frozen in the snapshots it was already rippled into. A coin with
   * no purchase date has no dated fact and is not rippled (it counts only in the
   * live holding and snapshots captured from now on).
   */
  syncConnectedSource: (params: {
    sourceId: string;
    positions: SourcePositionInput[];
    syncedAt: string;
  }) => void;
  /**
   * Backfill a connected Binance source's monthly value history into snapshots
   * (PRD #245 S5 / #250, ADR 0021). Values the reconstructed `BinanceHistoryCurve`
   * (balance step-function × that-day historical price) at every completed
   * month-end and every existing snapshot in the curve's window, FREEZING the
   * result into the market holding's row (SET, not additive). Append-only: a date
   * whose snapshot already carries the binance row is skipped (a re-sync only adds
   * newly-completed months, never rewrites a past value). A null curve start is a
   * no-op. `today` defaults to the current date; pass it to control the cut-off.
   */
  applyBinanceHistoryAndRipple: (params: {
    sourceId: string;
    curve: BinanceHistoryCurve;
    today?: string;
  }) => void;
}

export function runBootstrapHealthcheck(
  options: BootstrapHealthcheckOptions = {},
): LocalPersistenceStatus {
  const databasePath = resolveDatabasePath(options);
  mkdirSync(dirname(databasePath), { recursive: true });

  const sqlite = new Database(databasePath);
  try {
    migrate(sqlite);

    const db = drizzle(sqlite);
    const checkedAt = (options.now ?? (() => new Date()))().toISOString();

    db.insert(appSettings)
      .values({
        key: bootstrapKey,
        updatedAt: checkedAt,
        value: checkedAt,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: {
          updatedAt: checkedAt,
          value: checkedAt,
        },
      })
      .run();

    const row = db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, bootstrapKey))
      .get();

    if (!row) {
      throw new Error("SQLite bootstrap check did not persist an app setting.");
    }

    return {
      status: "ok",
      checkKey: bootstrapKey,
      checkedAt,
      checkValue: row.value,
      databasePath,
      displayPath: toDisplayPath(databasePath),
    };
  } finally {
    sqlite.close();
  }
}

/**
 * Create a throwaway WorthlineStore backed by an in-memory SQLite database.
 * The full schema and forward-migration ladder (ADR-0002) are applied on
 * construction, so the store is immediately usable for testing.
 *
 * Each call produces an independent, isolated database — parallel tests are
 * safe and no files are left behind.  Callers must call store.close() when done
 * (or use withStore with the store directly).
 */
export function createInMemoryStore(): WorthlineStore {
  const sqlite = new Database(":memory:");
  const migrateResult = migrate(sqlite);
  return buildStore(sqlite, migrateResult);
}

/**
 * Open an existing SQLite connection as a WorthlineStore, running the migration
 * ladder (and any post-migrate re-ripples) on it. Useful in tests that seed a
 * legacy-schema database and then need to verify the store behaves correctly
 * after migration — without going through the file-path lifecycle of
 * `createWorthlineStore`.
 */
export function createStoreFromSqlite(sqlite: DatabaseConnection): WorthlineStore {
  const migrateResult = migrate(sqlite);
  return buildStore(sqlite, migrateResult);
}

export function createWorthlineStore(
  options: WorthlineStoreOptions = {},
): WorthlineStore {
  const databasePath = resolveDatabasePath(options);
  mkdirSync(dirname(databasePath), { recursive: true });

  const sqlite = new Database(databasePath);
  const migrateResult = migrate(sqlite);
  return buildStore(sqlite, migrateResult);
}

/**
 * Whether two ownership splits differ — the signal that an edit must ripple the
 * scope axis (ADR 0020). A reorder of the same members/shares is NOT a change;
 * an added/removed member or a moved share IS. Lives behind the ownership seam so
 * the action layer no longer derives "did ownership change".
 */
function ownershipChanged(before: OwnershipShare[], after: OwnershipShare[]): boolean {
  if (before.length !== after.length) return true;
  const beforeByMember = new Map(before.map((share) => [share.memberId, share.shareBps]));
  return after.some((share) => beforeByMember.get(share.memberId) !== share.shareBps);
}

function buildStore(
  sqlite: DatabaseConnection,
  migrateResult: MigrateResult,
): WorthlineStore {
  // Shared substrate for the extracted *-Store slices (R1–R5, PRD #120): the
  // connection, id generation, transaction wrapping, audit logging, and the
  // per-unit-of-work workspace cache all live in one place.
  const ctx = createStoreContext(sqlite, readWorkspace);
  const { writeAuditEntry } = ctx;
  const snapshotStore = createSnapshotStore(ctx);
  const assetStore = createAssetStore(ctx);
  const liabilityStore = createLiabilityStore(ctx);
  const operationsStore = createOperationsStore(ctx);
  const connectedSourceStore = createConnectedSourceStore(ctx);
  // importWorkspace's post-import gap-fill spans every domain and the snapshot
  // save path, so it stays in the monolith and is injected into the workspace
  // store as a dependency. The arrow defers reading store.snapshots.saveSnapshot until
  // call-time, by which point store is fully constructed (same forward-
  // reference pattern as rippleHistoricalSnapshotsForOperation).
  const workspaceStore = createWorkspaceStore(ctx, {
    gapFillHistoricalSnapshots: (workspace, today) =>
      gapFillHistoricalSnapshots(ctx, workspace, store.snapshots.saveSnapshot, today),
  });

  const { getWorkspace } = ctx;

  /**
   * The earliest dateKey strictly before `today` of an existing snapshot that
   * carries this asset's row, or null. Used by the fully-behind-seam housing
   * methods to find the earliest snapshot a curve change could affect —
   * including ones dated before the first anchor (rate compounds backward, #184).
   */
  function housingEarliestSnapshotDate(assetId: string, today: string): string | null {
    return (
      snapshotStore
        .readSnapshotHoldings({ holdingId: assetId, kind: "asset" })
        .map((row) => row.dateKey)
        .filter((dateKey) => dateKey < today)
        .sort()[0] ?? null
    );
  }

  /**
   * Re-derive the housing snapshots after a non-dated-fact edit to a real_estate
   * asset (the `firstHousingEventDate` rule, ADR 0020): from-date = first
   * anchor/snapshot date ≤ today. Skips when nothing exists to ripple. Used by
   * both `rippleHousingAfterAssetEdit` (the editAsset ripple-only seam) and the
   * real_estate branch of `updateAssetAndRippleOwnership` (a home ownership edit
   * re-weights through the curve ripple, which honors the asset's new split). The
   * caller wraps it in the enclosing transaction.
   */
  function rippleHousingAfterEdit(assetId: string, today: string): void {
    const firstAnchorDate = assetStore
      .readValuationAnchors(assetId)
      .map((a) => a.valuationDate)
      .filter((d) => d <= today)
      .sort()[0];
    const fromDateKey =
      firstAnchorDate ??
      snapshotStore
        .readSnapshotHoldings({ holdingId: assetId, kind: "asset" })
        .map((r) => r.dateKey)
        .filter((d) => d <= today)
        .sort()[0] ??
      null;
    if (fromDateKey === null || fromDateKey > today) return;
    const workspace = getWorkspace();
    if (!workspace) return;
    rippleHistoricalSnapshotsForValuation(ctx, workspace, store.snapshots.saveSnapshot, {
      assetId,
      fromDateKey,
      today,
    });
  }

  const store: WorthlineStore = {
    snapshots: snapshotStore,
    assets: assetStore,
    liabilities: liabilityStore,
    operations: operationsStore,
    workspace: workspaceStore,
    connectedSources: connectedSourceStore,
    close: () => {
      sqlite.close();
    },
    readFireConfig: () => {
      const { db } = ctx;
      const row = db
        .select({ value: appSettings.value })
        .from(appSettings)
        .where(eq(appSettings.key, "fire.config"))
        .get();

      if (!row) {
        return {};
      }

      return JSON.parse(row.value) as Record<string, FireScopeConfig>;
    },
    saveFireConfig: (scopeId, config) => {
      const { db } = ctx;
      const existing = db
        .select({ value: appSettings.value })
        .from(appSettings)
        .where(eq(appSettings.key, "fire.config"))
        .get();

      const current: Record<string, FireScopeConfig> = existing
        ? (JSON.parse(existing.value) as Record<string, FireScopeConfig>)
        : {};
      const merged = { ...current, [scopeId]: config };
      const updatedAt = new Date().toISOString();

      db.insert(appSettings)
        .values({ key: "fire.config", updatedAt, value: JSON.stringify(merged) })
        .onConflictDoUpdate({
          set: { updatedAt, value: JSON.stringify(merged) },
          target: appSettings.key,
        })
        .run();
    },
    acknowledgeWarning: (code, entityId) => {
      const result = ctx.db
        .insert(warningOverrides)
        .values({ code, entityId })
        .onConflictDoNothing({
          target: [warningOverrides.code, warningOverrides.entityId],
        })
        .run();
      if (result.changes > 0) {
        writeAuditEntry("acknowledge_warning", "asset", entityId, { code });
      }
      return result.changes;
    },
    removeWarningOverride: (code, entityId) => {
      ctx.db
        .delete(warningOverrides)
        .where(
          and(eq(warningOverrides.code, code), eq(warningOverrides.entityId, entityId)),
        )
        .run();
      writeAuditEntry("unacknowledge_warning", "asset", entityId, { code });
    },
    readWarningOverrides: () =>
      ctx.db
        .select({ code: warningOverrides.code, entityId: warningOverrides.entityId })
        .from(warningOverrides)
        .all(),
    readTrash: () => ({
      assets: ctx.db
        .select({ id: assets.id, name: assets.name })
        .from(assets)
        .where(isNotNull(assets.deletedAt))
        .orderBy(asc(assets.name))
        .all(),
      liabilities: ctx.db
        .select({ id: liabilities.id, name: liabilities.name })
        .from(liabilities)
        .where(isNotNull(liabilities.deletedAt))
        .orderBy(asc(liabilities.name))
        .all(),
    }),
    emptyTrash: () =>
      ctx.transaction(() => {
        const trashedAssets = ctx.db
          .select({ id: assets.id })
          .from(assets)
          .where(isNotNull(assets.deletedAt))
          .all();
        const trashedLiabilities = ctx.db
          .select({ id: liabilities.id })
          .from(liabilities)
          .where(isNotNull(liabilities.deletedAt))
          .all();

        let assetsRemoved = 0;
        let liabilitiesRemoved = 0;
        for (const row of trashedAssets) assetsRemoved += hardDeleteAssetTx(ctx, row.id);
        for (const row of trashedLiabilities)
          liabilitiesRemoved += hardDeleteLiabilityTx(ctx, row.id);

        return { assets: assetsRemoved, liabilities: liabilitiesRemoved };
      }),
    readAuditLog: (filter) => {
      const { db } = ctx;
      const rows = filter?.entityId
        ? db
            .select()
            .from(auditLog)
            .where(eq(auditLog.entityId, filter.entityId))
            .orderBy(asc(auditLog.createdAt))
            .all()
        : db.select().from(auditLog).orderBy(asc(auditLog.createdAt)).all();

      return rows.map((row) => ({
        action: row.action,
        createdAt: row.createdAt,
        details: JSON.parse(row.detailsJson) as Record<string, unknown>,
        entityId: row.entityId,
        entityType: row.entityType,
        id: row.id,
      }));
    },
    recordOperationAndRipple: (input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // One transaction so the persist + ripple commit or roll back together —
      // the dated-fact contract is unrepresentable as "persisted, forgot to
      // ripple" (ADR 0020; better-sqlite3 nests via savepoints).
      ctx.transaction(() => {
        operationsStore.recordOperation(input);
        const workspace = getWorkspace();
        if (!workspace) return;
        rippleHistoricalSnapshots(ctx, workspace, store.snapshots.saveSnapshot, {
          assetId: input.assetId,
          mode: "record",
          operationDateKey: input.executedAt.slice(0, 10),
          today,
        });
      });
    },
    recordOperationsAndRipple: ({ assetId, creates, overwrites, today: todayOpt }) => {
      const today = todayOpt ?? new Date().toISOString().slice(0, 10);
      // One transaction so every create/overwrite + the single batched ripple
      // commit or roll back together (ADR 0020 / 0018). The affected from-date
      // window is derived here from the persisted operations, never by the caller.
      ctx.transaction(() => {
        const operationDateKeys: string[] = [];
        for (const input of creates) {
          operationsStore.recordOperation(input);
          operationDateKeys.push(input.executedAt.slice(0, 10));
        }
        for (const input of overwrites) {
          const result = operationsStore.updateOperation(input);
          if (result) operationDateKeys.push(result.executedAt.slice(0, 10));
        }
        const workspace = getWorkspace();
        if (!workspace) return;
        rippleHistoricalSnapshotsForOperations(
          ctx,
          workspace,
          store.snapshots.saveSnapshot,
          { assetId, operationDateKeys, today },
        );
      });
    },
    deleteOperationAndRipple: ({ operationId, today: todayOpt }) => {
      const today = todayOpt ?? new Date().toISOString().slice(0, 10);
      // One transaction so the delete + ripple commit or roll back together
      // (ADR 0020). The asset id and from-date come from the deleted row itself;
      // a not-found delete ripples nothing.
      return ctx.transaction(() => {
        const result = operationsStore.deleteOperation(operationId);
        if (!result) return null;
        const workspace = getWorkspace();
        if (workspace) {
          rippleHistoricalSnapshots(ctx, workspace, store.snapshots.saveSnapshot, {
            assetId: result.assetId,
            mode: "delete",
            operationDateKey: result.executedAt.slice(0, 10),
            today,
          });
        }
        return result;
      });
    },
    addValuationAnchorAndRipple: (input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // One transaction so the persist + ripple commit or roll back together
      // (ADR 0020). The from-date is the anchor's own date.
      ctx.transaction(() => {
        assetStore.addValuationAnchor(input);
        const workspace = getWorkspace();
        if (!workspace) return;
        rippleHistoricalSnapshotsForValuation(
          ctx,
          workspace,
          store.snapshots.saveSnapshot,
          {
            assetId: input.assetId,
            fromDateKey: input.valuationDate,
            today,
          },
        );
      });
    },
    updateValuationAnchorAndRipple: (anchorId, input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Atomic persist + ripple (ADR 0020). The new date may differ from the old
      // one; ripple from the earlier of the two so every affected snapshot is
      // recomputed. The previous row is read behind the seam before the patch.
      return ctx.transaction(() => {
        const previous = assetStore.readValuationAnchorById(anchorId);
        const changes = assetStore.updateValuationAnchor(anchorId, input);
        if (changes === 0 || !previous) return changes;
        const assetId = previous.assetId;
        const newDate = input.valuationDate ?? previous.valuationDate;
        const fromDateKey =
          previous.valuationDate < newDate ? previous.valuationDate : newDate;
        if (fromDateKey <= today) {
          const workspace = getWorkspace();
          if (workspace) {
            rippleHistoricalSnapshotsForValuation(
              ctx,
              workspace,
              store.snapshots.saveSnapshot,
              { assetId, fromDateKey, today },
            );
          }
        }
        return changes;
      });
    },
    deleteValuationAnchorAndRipple: (anchorId, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Atomic delete + ripple (ADR 0020). The asset id and from-date come from the
      // deleted row itself, captured before the delete; a future date generates no
      // history and a not-found delete ripples nothing.
      return ctx.transaction(() => {
        const removed = assetStore.readValuationAnchorById(anchorId);
        const changes = assetStore.deleteValuationAnchor(anchorId);
        if (changes === 0 || !removed) return changes;
        if (removed.valuationDate <= today) {
          const workspace = getWorkspace();
          if (workspace) {
            rippleHistoricalSnapshotsForValuation(
              ctx,
              workspace,
              store.snapshots.saveSnapshot,
              { assetId: removed.assetId, fromDateKey: removed.valuationDate, today },
            );
          }
        }
        return changes;
      });
    },
    setAnnualAppreciationRateAndRipple: (assetId, rate, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Atomic persist + ripple (ADR 0020). The earliest affected snapshot date is
      // derived behind the seam: min(first anchor date, earliest existing snapshot
      // carrying this asset) — covers the backward-compounding case (#184).
      ctx.transaction(() => {
        assetStore.setAnnualAppreciationRate(assetId, rate);
        const firstAnchorDate =
          assetStore.readValuationAnchors(assetId)[0]?.valuationDate;
        const earliestSnapshotDate = housingEarliestSnapshotDate(assetId, today);
        const fromDateKey =
          [firstAnchorDate, earliestSnapshotDate]
            .filter((d): d is string => d != null)
            .sort()[0] ?? null;
        if (fromDateKey === null || fromDateKey > today) return;
        const workspace = getWorkspace();
        if (!workspace) return;
        rippleHistoricalSnapshotsForValuation(
          ctx,
          workspace,
          store.snapshots.saveSnapshot,
          {
            assetId,
            fromDateKey,
            today,
          },
        );
      });
    },
    recordHousingValuationAndRipple: (assetId, currentValue, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Full persist + upsert-today-anchor + ripple, all atomic (ADR 0020).
      // The from-date is min(first past anchor, earliest snapshot) — same rule as
      // firstHousingCurrentValueRippleDate in the old action layer.
      ctx.transaction(() => {
        assetStore.updateAssetValuation(assetId, currentValue);
        // Upsert a today-dated market anchor (adjustsPriorCurve: true).
        const existing = assetStore
          .readValuationAnchors(assetId)
          .find((a) => a.valuationDate === today);
        if (existing) {
          assetStore.updateValuationAnchor(existing.id, {
            adjustsPriorCurve: true,
            valueMinor: currentValue,
          });
        } else {
          assetStore.addValuationAnchor({
            adjustsPriorCurve: true,
            assetId,
            id: ctx.newId(),
            valuationDate: today,
            valueMinor: currentValue,
          });
        }
        // Derive from-date: first past anchor, else earliest snapshot (see #184).
        const firstPastAnchorDate = assetStore
          .readValuationAnchors(assetId)
          .map((a) => a.valuationDate)
          .filter((d) => d < today)
          .sort()[0];
        const fromDateKey =
          firstPastAnchorDate ?? housingEarliestSnapshotDate(assetId, today);
        if (fromDateKey === null || fromDateKey > today) return;
        const workspace = getWorkspace();
        if (!workspace) return;
        rippleHistoricalSnapshotsForValuation(
          ctx,
          workspace,
          store.snapshots.saveSnapshot,
          {
            assetId,
            fromDateKey,
            today,
          },
        );
      });
    },
    rippleHousingAfterAssetEdit: (assetId, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Ripple-only seam for editAsset (ADR 0020): no dated fact persisted here.
      ctx.transaction(() => {
        rippleHousingAfterEdit(assetId, today);
      });
    },
    updateAssetAndRippleOwnership: (assetId, patch, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // One transaction so the patch + the scope-axis ripple commit or roll back
      // together (ADR 0020). The previous ownership and the did-it-change
      // comparison are read behind the seam, not at the call site.
      ctx.transaction(() => {
        const before = assetStore.readAssets().find((a) => a.id === assetId) ?? null;
        assetStore.updateAsset(assetId, patch);
        // A real_estate asset re-weights through the housing curve ripple — it
        // already re-derives every affected snapshot from the asset's new split,
        // so it covers an ownership edit too (and a from-date in the future is
        // guarded inside the helper).
        const type = patch.type ?? before?.type;
        if (type === "real_estate") {
          rippleHousingAfterEdit(assetId, today);
          return;
        }
        // A non-real_estate ownership-split change rides the scope-axis ripple;
        // a cosmetic edit (same split) ripples nothing.
        if (
          before &&
          patch.ownership &&
          ownershipChanged(before.ownership, patch.ownership)
        ) {
          const workspace = getWorkspace();
          if (workspace) {
            rippleHistoricalSnapshotsForOwnership(
              ctx,
              workspace,
              store.snapshots.saveSnapshot,
              {
                holdingId: assetId,
                kind: "asset",
                previousOwnership: before.ownership,
              },
            );
          }
        }
      });
    },
    updateLiabilityAndRippleOwnership: (liabilityId, patch) => {
      // An ownership edit has no time axis, so the liability seam takes no `today`
      // (the uniform `opts` is accepted at the type level for symmetry with the
      // asset seam, but unused here).
      // One transaction so the patch + the scope-axis ripple commit or roll back
      // together (ADR 0020). The previous ownership and the did-it-change
      // comparison are read behind the seam.
      ctx.transaction(() => {
        const before =
          liabilityStore.readLiabilities().find((l) => l.id === liabilityId) ?? null;
        liabilityStore.updateLiability(liabilityId, patch);
        if (
          before &&
          patch.ownership &&
          ownershipChanged(before.ownership, patch.ownership)
        ) {
          const workspace = getWorkspace();
          if (workspace) {
            rippleHistoricalSnapshotsForOwnership(
              ctx,
              workspace,
              store.snapshots.saveSnapshot,
              {
                holdingId: liabilityId,
                kind: "liability",
                previousOwnership: before.ownership,
              },
            );
          }
        }
      });
    },
    createHousingHoldingAndRipple: (command, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // One transaction so the create + anchor/rate seeding + ripple commit or
      // roll back together (ADR 0020). The from-date is the acquisition date,
      // derived behind the seam from the command's own acquisition anchor.
      ctx.transaction(() => {
        assetStore.createManualAsset(command.asset);
        assetStore.addValuationAnchor(command.acquisitionAnchor);
        assetStore.setAnnualAppreciationRate(
          command.asset.id,
          command.annualAppreciationRate,
        );
        if (command.initialValuation) {
          assetStore.addValuationAnchor(command.initialValuation);
        }
        const workspace = getWorkspace();
        if (!workspace) return;
        rippleHistoricalSnapshotsForValuation(
          ctx,
          workspace,
          store.snapshots.saveSnapshot,
          {
            assetId: command.asset.id,
            fromDateKey: command.acquisitionAnchor.valuationDate,
            today,
          },
        );
      });
    },
    createAmortizationPlanAndRipple: (input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Atomic persist + ripple (ADR 0020). The plan ripple derives its per-cuota
      // date series internally from the plan's own schedule.
      ctx.transaction(() => {
        liabilityStore.createAmortizationPlan(input);
        const workspace = getWorkspace();
        if (!workspace) return;
        rippleHistoricalSnapshotsForDebt(ctx, workspace, store.snapshots.saveSnapshot, {
          kind: "amortizable-plan",
          liabilityId: input.liabilityId,
          today,
        });
      });
    },
    updateAmortizationPlanAndRipple: (planId, input, opts) => {
      const today = opts.today ?? new Date().toISOString().slice(0, 10);
      return ctx.transaction(() => {
        const changes = liabilityStore.updateAmortizationPlan(planId, input);
        if (changes === 0) return 0;
        const workspace = getWorkspace();
        if (workspace) {
          rippleHistoricalSnapshotsForDebt(ctx, workspace, store.snapshots.saveSnapshot, {
            kind: "amortizable-plan",
            liabilityId: opts.liabilityId,
            today,
          });
        }
        return changes;
      });
    },
    deleteAmortizationPlanAndRipple: (opts) => {
      const today = opts.today ?? new Date().toISOString().slice(0, 10);
      // Capture the disbursement date BEFORE deleting — the earliest date the debt
      // existed (ADR 0019), the recalc floor for the now-planless curve. The
      // "amortizable-revision" kind recalculates without generating, so the curve
      // falls back to currentBalance (the "amortizable-plan" kind early-returns
      // when curve.plan is null and cannot be used here). The liability owns
      // exactly one plan (1:1), so it is resolved from the liability id.
      return ctx.transaction(() => {
        const plan = liabilityStore.readAmortizationPlan(opts.liabilityId);
        if (!plan) return 0;
        const startDate = plan.disbursementDate;
        const changes = liabilityStore.deleteAmortizationPlan(plan.id);
        if (changes === 0) return changes;
        if (startDate <= today) {
          const workspace = getWorkspace();
          if (workspace) {
            rippleHistoricalSnapshotsForDebt(
              ctx,
              workspace,
              store.snapshots.saveSnapshot,
              {
                fromDateKey: startDate,
                kind: "amortizable-revision",
                liabilityId: opts.liabilityId,
                today,
              },
            );
          }
        }
        return changes;
      });
    },
    addInterestRateRevisionAndRipple: (input, opts) => {
      const today = opts.today ?? new Date().toISOString().slice(0, 10);
      ctx.transaction(() => {
        liabilityStore.addInterestRateRevision(input);
        if (input.revisionDate > today) return;
        const workspace = getWorkspace();
        if (!workspace) return;
        rippleHistoricalSnapshotsForDebt(ctx, workspace, store.snapshots.saveSnapshot, {
          fromDateKey: input.revisionDate,
          kind: "amortizable-revision",
          liabilityId: opts.liabilityId,
          today,
        });
      });
    },
    updateInterestRateRevisionAndRipple: (revisionId, input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Ripple from the earlier of the old/new date so every affected snapshot
      // recomputes. The seam reads the OLD date itself (ADR 0025).
      return ctx.transaction(() => {
        // The seam reads the OLD date + owning liability from the row by id inside
        // the transaction (ADR 0025): the caller no longer pre-reads them.
        const {
          changes,
          revisionDate: previousRevisionDate,
          liabilityId,
        } = liabilityStore.updateInterestRateRevision(revisionId, input);
        if (
          changes === 0 ||
          previousRevisionDate === undefined ||
          liabilityId === undefined
        )
          return 0;
        const newDate = input.revisionDate ?? previousRevisionDate;
        // From-date math unchanged: the earlier of the old/new date.
        const fromDateKey =
          previousRevisionDate < newDate ? previousRevisionDate : newDate;
        if (fromDateKey <= today) {
          const workspace = getWorkspace();
          if (workspace) {
            rippleHistoricalSnapshotsForDebt(
              ctx,
              workspace,
              store.snapshots.saveSnapshot,
              {
                fromDateKey,
                kind: "amortizable-revision",
                liabilityId,
                today,
              },
            );
          }
        }
        return changes;
      });
    },
    deleteInterestRateRevisionAndRipple: (revisionId, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      return ctx.transaction(() => {
        // The seam reads the removed date + owning liability from the row by id
        // inside the transaction (ADR 0025): the caller no longer pre-reads them.
        const {
          changes,
          revisionDate: previousRevisionDate,
          liabilityId,
        } = liabilityStore.deleteInterestRateRevision(revisionId);
        if (
          changes === 0 ||
          previousRevisionDate === undefined ||
          liabilityId === undefined
        )
          return 0;
        // From-date unchanged: the removed revision's own date.
        if (previousRevisionDate <= today) {
          const workspace = getWorkspace();
          if (workspace) {
            rippleHistoricalSnapshotsForDebt(
              ctx,
              workspace,
              store.snapshots.saveSnapshot,
              {
                fromDateKey: previousRevisionDate,
                kind: "amortizable-revision",
                liabilityId,
                today,
              },
            );
          }
        }
        return changes;
      });
    },
    addEarlyRepaymentAndRipple: (input, opts) => {
      const today = opts.today ?? new Date().toISOString().slice(0, 10);
      // A past repayment is a dated fact: generate the snapshot at its date and
      // recalculate the ones after it (the "amortizable-repayment" kind).
      ctx.transaction(() => {
        liabilityStore.addEarlyRepayment(input);
        if (input.repaymentDate > today) return;
        const workspace = getWorkspace();
        if (!workspace) return;
        rippleHistoricalSnapshotsForDebt(ctx, workspace, store.snapshots.saveSnapshot, {
          fromDateKey: input.repaymentDate,
          kind: "amortizable-repayment",
          liabilityId: opts.liabilityId,
          today,
        });
      });
    },
    updateEarlyRepaymentAndRipple: (repaymentId, input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      return ctx.transaction(() => {
        // The seam reads the OLD date + owning liability from the row by id inside
        // the transaction (ADR 0025): the caller no longer pre-reads them.
        const {
          changes,
          repaymentDate: previousRepaymentDate,
          liabilityId,
        } = liabilityStore.updateEarlyRepayment(repaymentId, input);
        if (
          changes === 0 ||
          previousRepaymentDate === undefined ||
          liabilityId === undefined
        )
          return 0;
        const newDate = input.repaymentDate ?? previousRepaymentDate;
        // From-date math unchanged: the earlier of the old/new date.
        const fromDateKey =
          previousRepaymentDate < newDate ? previousRepaymentDate : newDate;
        if (fromDateKey <= today) {
          const workspace = getWorkspace();
          if (workspace) {
            rippleHistoricalSnapshotsForDebt(
              ctx,
              workspace,
              store.snapshots.saveSnapshot,
              {
                fromDateKey,
                kind: "amortizable-repayment",
                liabilityId,
                today,
              },
            );
          }
        }
        return changes;
      });
    },
    deleteEarlyRepaymentAndRipple: (repaymentId, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Deleting a dated fact recalculates from its date forward without generating
      // — the "amortizable-revision" kind, since the curve no longer carries it.
      return ctx.transaction(() => {
        // The seam reads the removed date + owning liability from the row by id
        // inside the transaction (ADR 0025): the caller no longer pre-reads them.
        const {
          changes,
          repaymentDate: previousRepaymentDate,
          liabilityId,
        } = liabilityStore.deleteEarlyRepayment(repaymentId);
        if (
          changes === 0 ||
          previousRepaymentDate === undefined ||
          liabilityId === undefined
        )
          return 0;
        // From-date unchanged: the removed repayment's own date.
        if (previousRepaymentDate <= today) {
          const workspace = getWorkspace();
          if (workspace) {
            rippleHistoricalSnapshotsForDebt(
              ctx,
              workspace,
              store.snapshots.saveSnapshot,
              {
                fromDateKey: previousRepaymentDate,
                kind: "amortizable-revision",
                liabilityId,
                today,
              },
            );
          }
        }
        return changes;
      });
    },
    addBalanceAnchorAndRipple: (input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Atomic persist + ripple (ADR 0020). The from-date is the anchor's own date.
      ctx.transaction(() => {
        liabilityStore.addBalanceAnchor(input);
        const workspace = getWorkspace();
        if (!workspace) return;
        rippleHistoricalSnapshotsForDebt(ctx, workspace, store.snapshots.saveSnapshot, {
          fromDateKey: input.anchorDate,
          kind: "anchor",
          liabilityId: input.liabilityId,
          today,
        });
      });
    },
    updateBalanceAnchorAndRipple: (anchorId, input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      return ctx.transaction(() => {
        // The seam reads the OLD date + owning liability from the row by id inside
        // the transaction (ADR 0025): the caller no longer pre-reads them.
        const {
          changes,
          anchorDate: previousAnchorDate,
          liabilityId,
        } = liabilityStore.updateBalanceAnchor(anchorId, input);
        if (
          changes === 0 ||
          previousAnchorDate === undefined ||
          liabilityId === undefined
        )
          return 0;
        const newDate = input.anchorDate ?? previousAnchorDate;
        // From-date math unchanged: the earlier of the old/new date.
        const fromDateKey = previousAnchorDate < newDate ? previousAnchorDate : newDate;
        if (fromDateKey <= today) {
          const workspace = getWorkspace();
          if (workspace) {
            rippleHistoricalSnapshotsForDebt(
              ctx,
              workspace,
              store.snapshots.saveSnapshot,
              {
                fromDateKey,
                kind: "anchor",
                liabilityId,
                today,
              },
            );
          }
        }
        return changes;
      });
    },
    deleteBalanceAnchorAndRipple: (anchorId, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      return ctx.transaction(() => {
        // The seam reads the removed date + owning liability from the row by id
        // inside the transaction (ADR 0025): the caller no longer pre-reads them.
        const {
          changes,
          anchorDate: previousAnchorDate,
          liabilityId,
        } = liabilityStore.deleteBalanceAnchor(anchorId);
        if (
          changes === 0 ||
          previousAnchorDate === undefined ||
          liabilityId === undefined
        )
          return 0;
        // From-date unchanged: the removed anchor's own date.
        if (previousAnchorDate <= today) {
          const workspace = getWorkspace();
          if (workspace) {
            rippleHistoricalSnapshotsForDebt(
              ctx,
              workspace,
              store.snapshots.saveSnapshot,
              {
                fromDateKey: previousAnchorDate,
                kind: "anchor",
                liabilityId,
                today,
              },
            );
          }
        }
        return changes;
      });
    },
    backfillHistoricalSnapshots: (today) => {
      const workspace = getWorkspace();
      if (!workspace) return;
      // Atomic: the whole backfill is one transaction (#185), so a mid-run
      // failure rolls every generated snapshot back rather than leaving a
      // partially filled history with no signal.
      gapFillHistoricalSnapshots(
        ctx,
        workspace,
        store.snapshots.saveSnapshot,
        today ?? new Date().toISOString().slice(0, 10),
        { atomic: true },
      );
    },
    syncConnectedSource: (params) => {
      const workspace = getWorkspace();
      // One transaction so the wholesale replace + every coin ripple commit or
      // roll back together (better-sqlite3 nests via savepoints).
      ctx.transaction(() => {
        // Diff BEFORE the wholesale replace reassigns ids: the set of external
        // ids already mirrored — the coins already on the timeline.
        const knownExternalIds = new Set(
          store.connectedSources
            .readPositions(params.sourceId)
            .map((position) => position.externalId),
        );

        store.connectedSources.syncPositions(
          params.sourceId,
          params.positions,
          params.syncedAt,
        );

        if (!workspace) return; // no workspace → no scopes, no history to ripple

        const source = store.connectedSources.readSource(params.sourceId);
        if (!source) return;

        // A genuinely new trade carrying a purchase date is the only dated fact to
        // ripple (ADR 0017): a coin seen before is frozen, a coin with no date has
        // no past fact (it counts from the live holding forward).
        const newDatedTrades = store.connectedSources
          .readPositions(params.sourceId)
          .filter(
            (position): position is CoinPosition =>
              position.kind === "coin" &&
              !knownExternalIds.has(position.externalId) &&
              position.purchaseDate !== null,
          );
        if (newDatedTrades.length === 0) return;

        rippleHistoricalSnapshotsForCoinAcquisition(
          ctx,
          workspace,
          store.snapshots.saveSnapshot,
          { assetId: source.assetId, newTrades: newDatedTrades },
        );
      });
    },
    applyBinanceHistoryAndRipple: (params) => {
      const workspace = getWorkspace();
      if (!workspace) return; // no workspace → no scopes, no history to backfill

      const source = store.connectedSources.readSource(params.sourceId);
      if (!source) return;

      backfillBinanceHistoricalSnapshots(ctx, workspace, store.snapshots.saveSnapshot, {
        assetId: source.assetId,
        curve: params.curve,
        today: params.today ?? new Date().toISOString().slice(0, 10),
      });
    },
  };

  // ADR 0019 (#188): after the v18 backfill, re-ripple every amortizable debt
  // so historical snapshots are rewritten from the new two-date curve. For
  // day<=28 plans the new curve is byte-identical to the old single-date curve,
  // so re-ripple is a no-op for figures. For day>=29 plans the clamped
  // first_payment shifts the cadence (addMonths(addMonths(start,1),m-1) ≠
  // addMonths(start,m)), so frozen snapshots must be corrected now — atomically
  // at migration time — rather than drifting silently on the next curve touch.
  if (migrateResult.ranV18Backfill) {
    const workspace = getWorkspace();
    if (workspace) {
      const today = new Date().toISOString().slice(0, 10);
      const deps = buildHistoricalSnapshotDeps(ctx.db, workspace);
      for (const [liabilityId, curve] of deps.debtBalanceByLiability) {
        if (curve.debtModel === "amortizable" && curve.plan) {
          rippleHistoricalSnapshotsForDebt(ctx, workspace, store.snapshots.saveSnapshot, {
            kind: "amortizable-plan",
            liabilityId,
            today,
          });
        }
      }
    }
  }

  return store;
}

// ── Historical snapshots (ADR 0012, PRD #107) ────────────────────────────────

/** Inputs shared by every historical-snapshot reconstruction for a workspace. */
interface HistoricalSnapshotDeps {
  scopes: ReturnType<typeof listScopeOptions>;
  assets: ManualAsset[];
  liabilities: Liability[];
  operationsByAsset: Map<string, InvestmentOperation[]>;
  manualValueHistory: Map<string, ManualValuePoint[]>;
  /** Curve inputs (anchors + rate + current value) of every real-estate asset (PRD #108). */
  housingValuationByAsset: Map<string, HousingCurveInputs>;
  /** Debt-balance curve inputs of every liability with a debt model (PRD #109). */
  debtBalanceByLiability: Map<string, DebtBalanceCurveInputs>;
  /**
   * Positions of every connected coin-collection asset, keyed by the materialized
   * asset id (ADR 0017, #167). Lets fresh generation value a coin collection by
   * purchase-date accretion instead of its full current value.
   */
  coinPositionsByAsset: Map<string, CoinPosition[]>;
  /**
   * Investment asset ids with no provider/manual price — valued at COST BASIS in
   * fresh generation, mirroring live capture's ADR-0006 fallback, so a generated
   * snapshot never shows a units × last-operation-price figure it could not have
   * shown that day (#183).
   */
  costBasisAssetIds: Set<string>;
}

/**
 * The investment asset ids that currently have no provider/manual price — the
 * ones live capture values at cost basis (ADR 0006). Used so fresh historical
 * generation values them at cost basis too, not at the latest operation price
 * (#183). A priced investment is absent from the set and keeps its price-based
 * valuation. Historical reconstruction has no contemporaneous price store, so
 * "has a price today" is the only signal available — the same one live capture
 * reads through `selectInvestmentPrice`.
 */
function readCostBasisAssetIds(db: StoreDb, assets: readonly ManualAsset[]): Set<string> {
  const ids = new Set<string>();
  const hasInvestments = assets.some((asset) => asset.type === "investment");
  if (!hasInvestments) return ids;

  const metaByAsset = readInvestmentMeta(db);
  const priceCacheByAsset = readAllPriceCache(db);

  for (const asset of assets) {
    if (asset.type !== "investment") continue;
    const selected = selectInvestmentPrice({
      cachedPrice: priceCacheByAsset.get(asset.id)?.price,
      manualPrice: metaByAsset.get(asset.id)?.manualPricePerUnit,
    });
    if (selected === undefined) ids.add(asset.id);
  }

  return ids;
}

function buildHistoricalSnapshotDeps(
  db: StoreDb,
  workspace: Workspace,
): HistoricalSnapshotDeps {
  const reconstructedAssets = readAssets(db, workspace);
  const reconstructedLiabilities = readLiabilities(db, workspace);
  return {
    assets: reconstructedAssets,
    coinPositionsByAsset: readCoinPositionsByAsset(db),
    costBasisAssetIds: readCostBasisAssetIds(db, reconstructedAssets),
    debtBalanceByLiability: readDebtBalanceInputs(db, reconstructedLiabilities),
    housingValuationByAsset: readHousingCurveInputs(db, reconstructedAssets),
    liabilities: reconstructedLiabilities,
    manualValueHistory: readManualValueHistory(db),
    operationsByAsset: readAllOperations(db),
    scopes: listScopeOptions(workspace),
  };
}

/**
 * Positions of every connected coin-collection asset, keyed by the materialized
 * asset id (ADR 0017, #167). Used so fresh historical generation values a coin
 * collection by purchase-date accretion (Σ coinValue of coins acquired ≤ date)
 * rather than its full current value. Reads positions including those whose
 * source's asset was later trashed — the asset existed on the snapshot dates.
 */
function readCoinPositionsByAsset(db: StoreDb): Map<string, CoinPosition[]> {
  const byAsset = new Map<string, CoinPosition[]>();
  const assetBySource = new Map<string, string>();
  for (const source of db
    .select({ id: connectedSources.id, assetId: connectedSources.assetId })
    .from(connectedSources)
    .all()) {
    assetBySource.set(source.id, source.assetId);
  }
  if (assetBySource.size === 0) return byAsset;

  for (const row of db.select().from(positions).all()) {
    const assetId = assetBySource.get(row.sourceId);
    if (assetId === undefined) continue;
    // Purchase-date accretion is a coin-only history path (ADR 0017); a Binance
    // token's history is the monthly builder (ADR 0021, S5), not this map.
    const position = mapPositionRow(row);
    if (position.kind !== "coin") continue;
    const list = byAsset.get(assetId) ?? [];
    list.push(position);
    byAsset.set(assetId, list);
  }
  return byAsset;
}

/**
 * Read the housing valuation curve inputs for every live real-estate asset
 * (PRD #108): its anchors, its annual appreciation rate, and its current value.
 * Keyed by asset id; only housing assets are included, and the domain decides
 * (via the anchors/rate presence) whether to value from the curve or fall back
 * to the last-known-value basis. `currentValue` comes from the already-read
 * assets so the curve uses the same value the live read derived.
 */
function readHousingCurveInputs(
  db: StoreDb,
  liveAssets: readonly ManualAsset[],
): Map<string, HousingCurveInputs> {
  const housingAssets = liveAssets.filter((asset) => isHousingAsset(asset));
  const inputs = new Map<string, HousingCurveInputs>();
  if (housingAssets.length === 0) return inputs;

  const valuationRows = db.select().from(assetValuations).all();
  const anchorsByAsset = new Map<string, HousingCurveInputs["anchors"][number][]>();
  for (const row of valuationRows) {
    const list = anchorsByAsset.get(row.assetId) ?? [];
    list.push({
      adjustsPriorCurve: row.adjustsPriorCurve === 1,
      valuationDate: row.valuationDate,
      valueMinor: row.valueMinor,
    });
    anchorsByAsset.set(row.assetId, list);
  }

  const rateRows = db
    .select({ id: assets.id, rate: assets.annualAppreciationRate })
    .from(assets)
    .all();
  const rateByAsset = new Map<string, DecimalString | null>();
  for (const row of rateRows) rateByAsset.set(row.id, row.rate);

  for (const asset of housingAssets) {
    inputs.set(asset.id, {
      anchors: anchorsByAsset.get(asset.id) ?? [],
      annualAppreciationRate: rateByAsset.get(asset.id) ?? null,
      currentValueMinor: asset.currentValue.amountMinor,
    });
  }

  return inputs;
}

/**
 * Read the debt-balance curve inputs for every live liability that carries a
 * debt model (PRD #109): its model, its balance anchors (revolving/informal),
 * its amortization plan + rate revisions (amortizable), and its current balance.
 * Keyed by liability id; only liabilities with a non-null model are included, so
 * a liability without a model keeps the last-known-value basis (no regression).
 * `currentBalance` comes from the already-read liabilities so the curve uses the
 * same fallback the live read derived.
 */
function readDebtBalanceInputs(
  db: StoreDb,
  liveLiabilities: readonly Liability[],
): Map<string, DebtBalanceCurveInputs> {
  const inputs = new Map<string, DebtBalanceCurveInputs>();
  if (liveLiabilities.length === 0) return inputs;

  const modelRows = db
    .select({ id: liabilities.id, debtModel: liabilities.debtModel })
    .from(liabilities)
    .all();
  const modelById = new Map<string, DebtModel | null>();
  for (const row of modelRows) modelById.set(row.id, row.debtModel ?? null);

  // Anchors (revolving/informal), grouped by liability.
  const anchorRows = db.select().from(liabilityBalanceAnchors).all();
  const anchorsByLiability = new Map<
    string,
    { anchorDate: string; balanceMinor: number }[]
  >();
  for (const row of anchorRows) {
    const list = anchorsByLiability.get(row.liabilityId) ?? [];
    list.push({ anchorDate: row.anchorDate, balanceMinor: row.balanceMinor });
    anchorsByLiability.set(row.liabilityId, list);
  }

  // Amortization plans, keyed by liability, plus revisions keyed by plan id.
  const planRows = db.select().from(amortizationPlans).all();
  const planByLiability = new Map<string, (typeof planRows)[number]>();
  for (const row of planRows) planByLiability.set(row.liabilityId, row);

  const revisionRows = db.select().from(interestRateRevisions).all();
  const revisionsByPlan = new Map<
    string,
    { revisionDate: string; newAnnualInterestRate: DecimalString }[]
  >();
  for (const row of revisionRows) {
    const list = revisionsByPlan.get(row.planId) ?? [];
    list.push({
      newAnnualInterestRate: row.newAnnualInterestRate,
      revisionDate: row.revisionDate,
    });
    revisionsByPlan.set(row.planId, list);
  }

  const repaymentRows = db.select().from(earlyRepayments).all();
  const repaymentsByPlan = new Map<
    string,
    { repaymentDate: string; amountMinor: number; mode: EarlyRepaymentMode }[]
  >();
  for (const row of repaymentRows) {
    const list = repaymentsByPlan.get(row.planId) ?? [];
    list.push({
      amountMinor: row.amountMinor,
      mode: row.mode,
      repaymentDate: row.repaymentDate,
    });
    repaymentsByPlan.set(row.planId, list);
  }

  for (const liability of liveLiabilities) {
    const debtModel = modelById.get(liability.id) ?? null;
    if (debtModel === null) continue; // no model → last-known-value basis

    const currentBalanceMinor = liability.currentBalance.amountMinor;

    if (debtModel === "amortizable") {
      const plan = planByLiability.get(liability.id);
      inputs.set(liability.id, {
        currentBalanceMinor,
        debtModel,
        ...(plan
          ? {
              earlyRepayments: repaymentsByPlan.get(plan.id) ?? [],
              plan: {
                annualInterestRate: plan.annualInterestRate,
                disbursementDate: plan.disbursementDate,
                firstPaymentDate: plan.firstPaymentDate,
                initialCapitalMinor: plan.initialCapitalMinor,
                termMonths: plan.termMonths,
              },
              revisions: revisionsByPlan.get(plan.id) ?? [],
            }
          : {}),
      });
      continue;
    }

    inputs.set(liability.id, {
      anchors: anchorsByLiability.get(liability.id) ?? [],
      currentBalanceMinor,
      debtModel,
    });
  }

  return inputs;
}

/**
 * Reconstruct the audit history of manual values/balances, keyed by holding id.
 *
 * The "last known value" basis for cash/housing/debts in a historical snapshot
 * (PRD #107): each `update_valuation` / `update_balance` audit entry is a dated
 * value point. The entry's `created_at` date is when the value became known.
 */
function readManualValueHistory(db: StoreDb): Map<string, ManualValuePoint[]> {
  const rows = db.select().from(auditLog).orderBy(asc(auditLog.createdAt)).all();

  const history = new Map<string, ManualValuePoint[]>();

  for (const row of rows) {
    if (row.action !== "update_valuation" && row.action !== "update_balance") {
      continue;
    }

    let details: Record<string, unknown>;
    try {
      details = JSON.parse(row.detailsJson) as Record<string, unknown>;
    } catch {
      continue; // a single malformed audit row must not abort the whole ripple
    }
    const value =
      row.action === "update_valuation"
        ? details["currentValueMinor"]
        : details["balanceMinor"];

    if (typeof value !== "number") continue;

    const dateKey = (row.createdAt ?? "").slice(0, 10);
    if (!dateKey) continue;

    const points = history.get(row.entityId) ?? [];
    points.push({ dateKey, valueMinor: value });
    history.set(row.entityId, points);
  }

  return history;
}

/**
 * Group a scope's batched frozen-holding read by snapshot date (#205). The input
 * is the result of a single `readSnapshotHoldings({ scopeId, from })` call —
 * already ordered (dateKey, scopeId, kind, label, holdingId) — so iterating it in
 * order and appending into each date's bucket preserves, per date, the exact row
 * order the old one-query-per-snapshot read produced. The ripple then looks each
 * snapshot's rows up by date instead of re-querying the store for every snapshot.
 */
function groupFrozenHoldingsByDate(
  records: readonly SnapshotHoldingRecord[],
): Map<string, SnapshotHoldingRecord[]> {
  const byDate = new Map<string, SnapshotHoldingRecord[]>();
  for (const record of records) {
    const bucket = byDate.get(record.dateKey);
    if (bucket) {
      bucket.push(record);
    } else {
      byDate.set(record.dateKey, [record]);
    }
  }
  return byDate;
}

/**
 * Read ONE holding's frozen classification captures across every existing
 * snapshot (#242) — the basis the domain's frozen-vs-live seam recovers a
 * holding's CONTEMPORANEOUS tier / housing-ness from when a ripple must generate
 * a brand-new row at a date/scope that never carried one. Uses the targeted
 * `(holding_id, kind)` index read (#207) so it never scans the whole table, and
 * collapses to one capture per dateKey (a holding's classification is frozen
 * identically across the scopes captured on a date until a reclassification, so
 * the first row seen for a date is representative). Empty when the holding has
 * never been captured — the seam then falls back to live (no recovery basis).
 */
function readFrozenIdentityCaptures(
  db: StoreDb,
  holdingId: string,
  kind: SnapshotHoldingKind,
): FrozenIdentityCapture[] {
  const byDate = new Map<string, FrozenIdentityCapture>();
  for (const record of readSnapshotHoldings(db, { holdingId, kind })) {
    if (byDate.has(record.dateKey)) continue;
    byDate.set(record.dateKey, {
      countsAsHousing: record.countsAsHousing,
      dateKey: record.dateKey,
      liquidityTier: record.liquidityTier,
      securesHousing: record.securesHousing,
    });
  }
  return [...byDate.values()];
}

/**
 * Ripple effect (ADR 0012): a backdated operation change regenerates the
 * snapshot at its date and recalculates the existing snapshots it affects.
 *
 * - record(D), D in the past: generate the snapshot at D if none exists, or
 *   overwrite it in place if one does (the new operation supplies its own best
 *   price), and recalculate every existing snapshot dated ≥ D. The affected
 *   range is ≥ D, not > D: an existing snapshot at D is overwritten in place,
 *   not skipped.
 * - delete(D): recalculate existing snapshots dated ≥ D (the snapshot at D was
 *   itself derived from the operation that just disappeared).
 *
 * Operations dated today or in the future never generate history — the daily
 * capture covers today and the future is not history. Recalculations honor the
 * unit price each snapshot already captured for an asset; only an asset absent
 * from a snapshot falls back to the last known operation price ≤ its date.
 */
function rippleHistoricalSnapshots(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => void,
  params: {
    assetId: string;
    mode: "record" | "delete";
    operationDateKey: string;
    today: string;
  },
): void {
  const { db } = ctx;
  const { assetId, mode, operationDateKey, today } = params;

  // The operated asset's identity — read including trashed, since it existed on
  // the snapshot dates even if it was trashed afterwards (ADR 0012).
  const asset = readInvestmentIdentity(db, assetId);
  if (!asset) return;
  const operations = readAllOperations(db).get(assetId) ?? [];

  // The asset's frozen classification captures across every snapshot (#242),
  // read ONCE before any recalc mutates rows — the basis the domain seam recovers
  // a newly-appearing row's CONTEMPORANEOUS frozen tier from instead of the live.
  const frozenIdentity = readFrozenIdentityCaptures(db, assetId, "asset");

  ctx.transaction(() => {
    for (const scope of listScopeOptions(workspace)) {
      const existing = readSnapshots(db, scope.id);
      const existingByDate = new Map(existing.map((snap) => [snap.dateKey, snap]));

      // Generate a fresh whole-portfolio snapshot at the operation date when
      // recording into the past and none exists yet there.
      if (
        mode === "record" &&
        operationDateKey < today &&
        !existingByDate.has(operationDateKey)
      ) {
        const deps = buildHistoricalSnapshotDeps(db, workspace);
        const built = buildSnapshotAtDate({
          assets: deps.assets,
          capturedAt: historicalCapturedAt(operationDateKey),
          coinPositionsByAsset: deps.coinPositionsByAsset,
          costBasisAssetIds: deps.costBasisAssetIds,
          debtBalanceByLiability: deps.debtBalanceByLiability,
          housingValuationByAsset: deps.housingValuationByAsset,
          id: `histsnap_${scope.id}_${operationDateKey}`,
          liabilities: deps.liabilities,
          manualValueHistory: deps.manualValueHistory,
          operationsByAsset: deps.operationsByAsset,
          scopeId: scope.id,
          scopeLabel: scope.label,
          targetDate: operationDateKey,
          today,
          workspace,
        });
        if (built) {
          saveSnapshot({
            holdings: built.holdings,
            replace: false,
            snapshot: built.snapshot,
          });
        }
      }

      // Read the affected scope's frozen rows in ONE batched query for the whole
      // ≥ operation-date range (#205), then group them by snapshot date in memory
      // — instead of one query per snapshot date. The batched read uses the same
      // ordering as the single-date read it replaces (dateKey, scopeId, kind,
      // label, holdingId), so each snapshot's grouped rows arrive in the byte-
      // identical order recalculateSnapshotForAsset saw before, preserving ADR
      // 0012 behavior exactly. A date absent from the map had no frozen rows (a
      // legacy capture predating holdings, ADR 0008) and is left untouched.
      const frozenByDate = groupFrozenHoldingsByDate(
        readSnapshotHoldings(db, { scopeId: scope.id, from: operationDateKey }),
      );

      // Recalculate every affected existing snapshot — only the operated
      // asset's row changes; all other frozen rows are preserved. (Both modes
      // recalculate ≥ D: record relies on the generate branch above for a
      // brand-new D, and recalculates an existing D in place here.)
      for (const snap of existing) {
        if (snap.dateKey < operationDateKey) continue;

        const frozenHoldings = frozenByDate.get(snap.dateKey) ?? [];

        // A legacy capture predating holdings (ADR 0008) has no rows to
        // recompute against — leave its frozen figures untouched.
        if (frozenHoldings.length === 0) continue;

        const recalculated = recalculateSnapshotForAsset({
          asset,
          frozenHoldings,
          frozenIdentity,
          operations,
          snapshot: snap,
          workspace,
        });

        if (recalculated) {
          saveSnapshot({
            holdings: recalculated.holdings,
            replace: true,
            snapshot: recalculated.snapshot,
          });
        } else {
          // No holdings remain (e.g. the deleted operation was the only basis):
          // drop the snapshot rather than leave it showing stale values.
          db.delete(snapshots).where(eq(snapshots.id, snap.id)).run();
        }
      }
    }
  });
}

/**
 * Batched ripple for a statement load (ADR 0018, #174). Mirrors the
 * amortization-plan exception in `rippleHistoricalSnapshotsForDebt`: generate a
 * fresh whole-portfolio snapshot at each affected past operation date that has
 * none yet, then run ONE forward recalculation of every existing snapshot dated
 * ≥ the earliest affected date — re-evaluating only the operated asset's row.
 *
 * This replaces calling the per-operation ripple once per created operation
 * (which would re-derive history N times — the #158 O(N×snapshots) cliff): deps
 * are built once, the frozen rows are read in one batched query per scope, and a
 * single forward pass folds the asset across the band regardless of how many
 * operation dates the load carried. Dates today or in the future generate no
 * history (the daily capture owns today). Legacy captures with no holding rows
 * are skipped (ADR 0008). A no-op when the asset is unknown or no dates given.
 */
function rippleHistoricalSnapshotsForOperations(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => void,
  params: {
    assetId: string;
    operationDateKeys: string[];
    today: string;
  },
): void {
  const { db } = ctx;
  const { assetId, operationDateKeys, today } = params;
  if (operationDateKeys.length === 0) return;

  // The operated asset's identity — read including trashed, since it existed on
  // the snapshot dates even if it was trashed afterwards (ADR 0012).
  const asset = readInvestmentIdentity(db, assetId);
  if (!asset) return;
  const operations = readAllOperations(db).get(assetId) ?? [];

  // The asset's frozen classification captures across every snapshot (#242), read
  // ONCE before any recalc mutates rows (see rippleHistoricalSnapshots).
  const frozenIdentity = readFrozenIdentityCaptures(db, assetId, "asset");

  // Unique affected dates, and the earliest from which existing snapshots recalc.
  const generateDates = [...new Set(operationDateKeys)];
  const recalcFrom = generateDates.reduce(
    (min, date) => (date < min ? date : min),
    generateDates[0]!,
  );

  // Build deps once — the same for every scope (lesson from #114).
  const deps = buildHistoricalSnapshotDeps(db, workspace);

  ctx.transaction(() => {
    for (const scope of listScopeOptions(workspace)) {
      const existing = readSnapshots(db, scope.id);
      const existingByDate = new Map(existing.map((snap) => [snap.dateKey, snap]));

      // Generate a fresh whole-portfolio snapshot at each affected past date that
      // has none yet (ADR 0012). The single forward recalc below then folds the
      // operated asset across every existing snapshot ≥ the earliest date.
      for (const dateKey of generateDates) {
        if (dateKey >= today || existingByDate.has(dateKey)) continue;
        const built = buildSnapshotAtDate({
          assets: deps.assets,
          capturedAt: historicalCapturedAt(dateKey),
          coinPositionsByAsset: deps.coinPositionsByAsset,
          costBasisAssetIds: deps.costBasisAssetIds,
          debtBalanceByLiability: deps.debtBalanceByLiability,
          housingValuationByAsset: deps.housingValuationByAsset,
          id: `histsnap_${scope.id}_${dateKey}`,
          liabilities: deps.liabilities,
          manualValueHistory: deps.manualValueHistory,
          operationsByAsset: deps.operationsByAsset,
          scopeId: scope.id,
          scopeLabel: scope.label,
          targetDate: dateKey,
          today,
          workspace,
        });
        if (built) {
          saveSnapshot({
            holdings: built.holdings,
            replace: false,
            snapshot: built.snapshot,
          });
        }
      }

      // Read the affected scope's frozen rows in ONE batched query for the whole
      // ≥ recalc-from range (#205), then group them by snapshot date in memory —
      // one read per scope, not one per rippled snapshot nor one per operation.
      const frozenByDate = groupFrozenHoldingsByDate(
        readSnapshotHoldings(db, { scopeId: scope.id, from: recalcFrom }),
      );

      // Recalculate every existing snapshot ≥ the earliest affected date by
      // re-folding only the operated asset's row from its operations.
      for (const snap of existing) {
        if (snap.dateKey < recalcFrom) continue;

        const frozenHoldings = frozenByDate.get(snap.dateKey) ?? [];

        // A legacy capture predating holdings (ADR 0008) has nothing to recompute.
        if (frozenHoldings.length === 0) continue;

        const recalculated = recalculateSnapshotForAsset({
          asset,
          frozenHoldings,
          frozenIdentity,
          operations,
          snapshot: snap,
          workspace,
        });

        if (recalculated) {
          saveSnapshot({
            holdings: recalculated.holdings,
            replace: true,
            snapshot: recalculated.snapshot,
          });
        } else {
          db.delete(snapshots).where(eq(snapshots.id, snap.id)).run();
        }
      }
    }
  });
}

/**
 * Ripple effect for housing valuation curves (PRD #108): declaring, editing, or
 * deleting a valuation anchor — or changing the appreciation rate — regenerates
 * the snapshot at the change date and recalculates the existing snapshots it
 * affects.
 *
 * - `fromDateKey` in the past: generate/overwrite the snapshot at that date
 *   (valuing the housing asset from its now-current curve), then recalculate
 *   every existing snapshot dated > fromDateKey by re-evaluating only the
 *   housing asset's row from the curve.
 * - For a rate change, pass the first anchor's date as `fromDateKey` so every
 *   snapshot after it is recalculated (the rate only affects extrapolation
 *   before the first / after the last appraisal).
 * - `fromDateKey` today or in the future never generates history — the daily
 *   capture owns today and the future is not history. Future anchors thus
 *   produce no snapshot.
 *
 * Only the housing asset's row in each snapshot is recomputed; every other
 * frozen row is preserved, and legacy captures with no holding rows are skipped.
 */
function rippleHistoricalSnapshotsForValuation(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => void,
  params: {
    assetId: string;
    fromDateKey: string;
    today: string;
  },
): void {
  const { db } = ctx;
  const { assetId, fromDateKey, today } = params;

  // The housing asset's identity — read including trashed, since it existed on
  // the snapshot dates even if it was trashed afterwards.
  const asset = readInvestmentIdentity(db, assetId);
  if (!asset || !isHousingAsset(asset)) return;

  // Build deps once — they are the same for every scope (Fix 2: was per-scope).
  const deps = buildHistoricalSnapshotDeps(db, workspace);
  const curve = deps.housingValuationByAsset.get(assetId);
  // No map entry means the asset is not housing or has been trashed with no
  // remaining live record — nothing to ripple.
  if (!curve) return;

  // The asset's frozen classification captures across every snapshot (#242), read
  // ONCE before any recalc mutates rows (see rippleHistoricalSnapshots).
  const frozenIdentity = readFrozenIdentityCaptures(db, assetId, "asset");

  ctx.transaction(() => {
    for (const scope of listScopeOptions(workspace)) {
      const existing = readSnapshots(db, scope.id);
      const existingByDate = new Map(existing.map((snap) => [snap.dateKey, snap]));

      // Generate a fresh whole-portfolio snapshot at the change date when it is
      // in the past and none exists there yet.
      if (fromDateKey < today && !existingByDate.has(fromDateKey)) {
        const built = buildSnapshotAtDate({
          assets: deps.assets,
          capturedAt: historicalCapturedAt(fromDateKey),
          coinPositionsByAsset: deps.coinPositionsByAsset,
          costBasisAssetIds: deps.costBasisAssetIds,
          debtBalanceByLiability: deps.debtBalanceByLiability,
          housingValuationByAsset: deps.housingValuationByAsset,
          id: `histsnap_${scope.id}_${fromDateKey}`,
          liabilities: deps.liabilities,
          manualValueHistory: deps.manualValueHistory,
          operationsByAsset: deps.operationsByAsset,
          scopeId: scope.id,
          scopeLabel: scope.label,
          targetDate: fromDateKey,
          today,
          workspace,
        });
        if (built) {
          saveSnapshot({
            holdings: built.holdings,
            replace: false,
            snapshot: built.snapshot,
          });
        }
      }

      // Recalculate every existing snapshot on or after the change date by
      // re-evaluating only the housing asset's row from the curve (or
      // last-known-value when the curve is now empty — Fix 1).
      for (const snap of existing) {
        if (snap.dateKey < fromDateKey) continue;

        const frozenHoldings = readSnapshotHoldings(db, {
          scopeId: scope.id,
          from: snap.dateKey,
          to: snap.dateKey,
        });

        // A legacy capture predating holdings (ADR 0008) has nothing to recompute.
        if (frozenHoldings.length === 0) continue;

        const recalculated = recalculateSnapshotForHousing({
          asset,
          curve,
          frozenHoldings,
          frozenIdentity,
          manualValueHistory: deps.manualValueHistory,
          snapshot: snap,
          today,
          workspace,
        });

        if (recalculated) {
          saveSnapshot({
            holdings: recalculated.holdings,
            replace: true,
            snapshot: recalculated.snapshot,
          });
        } else {
          db.delete(snapshots).where(eq(snapshots.id, snap.id)).run();
        }
      }
    }
  });
}

/**
 * Ripple effect for debt-balance curves (PRD #109, slice 9): declaring,
 * editing, or deleting an amortization plan, a balance anchor, or a rate
 * revision regenerates / recalculates the snapshots the change affects. The
 * liability is valued from its debt curve (`debtBalanceAtDate`) on each date.
 *
 * Affected-date selection by `kind`:
 * - "amortizable-plan": generate at every past payment-boundary date (start +
 *   m months, m∈[0..term], strictly before today) that has no snapshot yet —
 *   the "one snapshot per past cuota" density (the deliberate ADR-0012
 *   exception of PRD #109) — then recalculate every existing snapshot dated ≥
 *   the loan start.
 * - "amortizable-revision": recalculate every existing snapshot dated ≥
 *   `fromDateKey` (the revision date). No generation: the revision only changes
 *   balances on existing dates after it.
 * - "anchor": generate at `fromDateKey` when in the past and none exists, then
 *   recalculate every existing snapshot dated ≥ it.
 *
 * Deps are built ONCE outside the scope loop (lesson from #114). Only the
 * liability's row in each snapshot is recomputed; every other frozen row is
 * preserved, and legacy captures with no holding rows are skipped. A no-op when
 * the liability has no debt model / curve.
 */
function rippleHistoricalSnapshotsForDebt(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => void,
  params:
    | { liabilityId: string; kind: "amortizable-plan"; today: string }
    | {
        liabilityId: string;
        kind: "amortizable-revision" | "anchor" | "amortizable-repayment";
        fromDateKey: string;
        today: string;
      },
): void {
  const { db } = ctx;
  const { liabilityId, today } = params;

  // The liability's identity — including trashed, since it existed on the
  // snapshot dates even if it was trashed afterwards.
  const liability = readLiabilityIdentity(db, liabilityId);
  if (!liability) return;

  // Build deps once — the same for every scope (lesson from #114).
  const deps = buildHistoricalSnapshotDeps(db, workspace);
  const curve = deps.debtBalanceByLiability.get(liabilityId);
  if (!curve || curve.debtModel === null) return; // no model → nothing to ripple

  // Housing assets — a debt securing one nets historical housing equity (ADR 0013).
  const housingAssetIds = housingAssetIdsOf(deps.assets);

  // The set of dates to generate fresh snapshots at, and the earliest date from
  // which existing snapshots are recalculated.
  let generateDates: string[];
  let recalcFrom: string;
  if (params.kind === "amortizable-plan") {
    if (!curve.plan) return;
    generateDates = amortizationPaymentDatesUpTo(curve.plan, today);
    // The debt appears at the disbursement date (ADR 0019), the earliest boundary.
    recalcFrom = curve.plan.disbursementDate;
  } else {
    const { fromDateKey } = params;
    // A revision never generates new dates; an anchor and an early repayment are
    // dated facts that generate the snapshot at their own date when in the past
    // (ADR 0012), then recalculate from it forward.
    generateDates =
      (params.kind === "anchor" || params.kind === "amortizable-repayment") &&
      fromDateKey < today
        ? [fromDateKey]
        : [];
    recalcFrom = fromDateKey;
  }

  ctx.transaction(() => {
    for (const scope of listScopeOptions(workspace)) {
      const existing = readSnapshots(db, scope.id);
      const existingByDate = new Map(existing.map((snap) => [snap.dateKey, snap]));

      // Generate a fresh whole-portfolio snapshot at each affected past date
      // that has none yet.
      for (const dateKey of generateDates) {
        if (dateKey >= today || existingByDate.has(dateKey)) continue;
        const built = buildSnapshotAtDate({
          assets: deps.assets,
          capturedAt: historicalCapturedAt(dateKey),
          coinPositionsByAsset: deps.coinPositionsByAsset,
          costBasisAssetIds: deps.costBasisAssetIds,
          debtBalanceByLiability: deps.debtBalanceByLiability,
          housingValuationByAsset: deps.housingValuationByAsset,
          id: `histsnap_${scope.id}_${dateKey}`,
          liabilities: deps.liabilities,
          manualValueHistory: deps.manualValueHistory,
          operationsByAsset: deps.operationsByAsset,
          scopeId: scope.id,
          scopeLabel: scope.label,
          targetDate: dateKey,
          today,
          workspace,
        });
        if (built) {
          saveSnapshot({
            holdings: built.holdings,
            replace: false,
            snapshot: built.snapshot,
          });
        }
      }

      // Read the affected scope's frozen rows in ONE batched query for the whole
      // ≥ recalc-from range (#206), then group them by snapshot date in memory —
      // instead of one query per recalculated snapshot. The batched read uses the
      // same ordering as the single-date read it replaces (dateKey, scopeId,
      // kind, label, holdingId), so each snapshot's grouped rows arrive in the
      // byte-identical order recalculateSnapshotForLiability saw before,
      // preserving ADR 0012 / ADR 0019 behavior exactly. A date absent from the
      // map had no frozen rows (a legacy capture predating holdings, ADR 0008)
      // and is left untouched.
      const frozenByDate = groupFrozenHoldingsByDate(
        readSnapshotHoldings(db, { scopeId: scope.id, from: recalcFrom }),
      );

      // Recalculate every existing snapshot on or after the change date by
      // re-valuing only this liability's row from the curve.
      for (const snap of existing) {
        if (snap.dateKey < recalcFrom) continue;

        const frozenHoldings = frozenByDate.get(snap.dateKey) ?? [];

        // A legacy capture predating holdings (ADR 0008) has nothing to recompute.
        if (frozenHoldings.length === 0) continue;

        const recalculated = recalculateSnapshotForLiability({
          curve,
          frozenHoldings,
          housingAssetIds,
          liability,
          snapshot: snap,
          workspace,
        });

        if (recalculated) {
          saveSnapshot({
            holdings: recalculated.holdings,
            replace: true,
            snapshot: recalculated.snapshot,
          });
        } else {
          db.delete(snapshots).where(eq(snapshots.id, snap.id)).run();
        }
      }
    }
  });
}

/**
 * Re-derive one asset's GLOBAL (100%) value on a date from the lossless deps,
 * honoring the frozen household row's captured unit price / cost-basis flag so an
 * investment's re-valued global matches the price the snapshot showed (#187).
 */
function globalAssetValue(
  asset: ManualAsset,
  deps: HistoricalSnapshotDeps,
  householdRow: SnapshotHoldingRecord,
  dateKey: string,
): number | null {
  const housingCurve = deps.housingValuationByAsset.get(asset.id);
  const manualValueHistory = deps.manualValueHistory.get(asset.id);
  return globalHoldingValueAtDate(
    {
      atCostBasis:
        householdRow.units !== undefined && householdRow.unitPrice === undefined,
      holding: { asset, kind: "asset" },
      operations: deps.operationsByAsset.get(asset.id) ?? [],
      ...(householdRow.unitPrice !== undefined
        ? { capturedUnitPrice: householdRow.unitPrice }
        : {}),
      ...(housingCurve !== undefined ? { housingCurve } : {}),
      ...(manualValueHistory !== undefined ? { manualValueHistory } : {}),
    },
    dateKey,
  );
}

/** Re-derive one liability's GLOBAL (100%) outstanding balance on a date (#187). */
function globalLiabilityValue(
  liability: Liability,
  deps: HistoricalSnapshotDeps,
  dateKey: string,
): number | null {
  const debtCurve = deps.debtBalanceByLiability.get(liability.id);
  const manualValueHistory = deps.manualValueHistory.get(liability.id);
  return globalHoldingValueAtDate(
    {
      holding: { kind: "liability", liability },
      ...(debtCurve !== undefined ? { debtCurve } : {}),
      ...(manualValueHistory !== undefined ? { manualValueHistory } : {}),
    },
    dateKey,
  );
}

/**
 * Ripple effect for an ownership-split edit (#172): re-weight the edited
 * holding's row in every existing scope snapshot using its new split. Unlike the
 * value ripples this generates NO snapshot dates — an ownership split has no date
 * dimension. The whole-holding (global, 100%) value at each date is RE-DERIVED
 * losslessly from the holding's curve / operations / stored basis — the same
 * source `buildSnapshotAtDate` values it from (#187) — never recovered by
 * dividing the rounded household snapshot row, which cannot invert allocation
 * rounding and drifts ±1–2 minor units for a holding co-owned with a non-member
 * (the household combined share < 100%). The set of dates re-weighted is exactly
 * the household snapshots that carry the holding (an ownership edit moves no other
 * dates). Every scope — including the household — is then re-weighted from that
 * global value, so a holding fully owned within the household leaves the household
 * figure unchanged while a co-owned holding's household figure moves with the
 * members' combined share. Only the edited holding's row moves; every other
 * frozen row is preserved, the reconciliation invariant holds (ADR 0008), and
 * legacy captures with no holding rows are skipped. A no-op when the household
 * held no stake before, or no household snapshot carries the holding.
 */
function rippleHistoricalSnapshotsForOwnership(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => void,
  params: {
    holdingId: string;
    kind: "asset" | "liability";
    previousOwnership: OwnershipShare[];
  },
): void {
  const { db } = ctx;
  const { holdingId, kind, previousOwnership } = params;

  // The edited holding's identity, carrying its NEW ownership split — read
  // including trashed, since it existed on the snapshot dates regardless.
  const asset = kind === "asset" ? readInvestmentIdentity(db, holdingId) : null;
  const liability = kind === "liability" ? readLiabilityIdentity(db, holdingId) : null;
  if (!asset && !liability) return;

  // The combined stake the household held under the PREVIOUS split. Zero means the
  // household held nothing before this edit → nothing to re-weight, no-op.
  const householdMemberIds = new Set(resolveScopeMemberIds(workspace, "household"));
  const previousHouseholdBps = previousOwnership
    .filter((share) => householdMemberIds.has(share.memberId))
    .reduce((sum, share) => sum + share.shareBps, 0);
  if (previousHouseholdBps <= 0) return;

  // The valuation deps `buildSnapshotAtDate` uses (operations, curves, manual
  // history): the lossless source the global value is RE-DERIVED from (#187),
  // never the rounded household row.
  const deps = buildHistoricalSnapshotDeps(db, workspace);
  // A liability that secures the home nets housing equity (ADR 0013).
  const housingAssetIds =
    liability !== null ? housingAssetIdsOf(deps.assets) : new Set<string>();

  // The holding's frozen classification captures across every snapshot (#242),
  // read ONCE before any recalc mutates rows. A member gaining a stake gets a
  // brand-new row whose frozen housing-ness/tier the seam recovers from these
  // captures (e.g. the household scope's), not from the live identity.
  const frozenIdentity = readFrozenIdentityCaptures(db, holdingId, kind);

  ctx.transaction(() => {
    // The dates to re-weight: exactly the household snapshots carrying the holding
    // (an ownership edit moves no other dates), each mapped to the LOSSLESS global
    // value re-derived from the holding's curve / operations / stored basis. The
    // household row's frozen unit price / cost-basis flag is honored so an
    // investment's re-valued global matches the price the snapshot captured.
    const globalByDate = new Map<string, number>();
    for (const snap of readSnapshots(db, "household")) {
      const row = readSnapshotHoldings(db, {
        from: snap.dateKey,
        scopeId: "household",
        to: snap.dateKey,
      }).find((r) => r.holdingId === holdingId && r.kind === kind);
      if (!row) continue;

      const globalValueMinor = asset
        ? globalAssetValue(asset, deps, row, snap.dateKey)
        : globalLiabilityValue(liability!, deps, snap.dateKey);
      // A household row exists for this date, so the holding WAS captured then.
      // Re-valuation returns null only when the live ledger no longer holds it on
      // that date (e.g. operations deleted since the freeze) — a data mismatch the
      // frozen row alone records faithfully. SKIP re-weighting that date: dividing
      // the already-allocated household row back to a global would re-introduce the
      // lossy-magnitude error #187 removed (#212). Leaving the date out of
      // globalByDate makes the downstream loop skip it, so the frozen row is left
      // untouched as the only faithful record of that date.
      if (globalValueMinor !== null) {
        globalByDate.set(snap.dateKey, globalValueMinor);
      }
    }
    if (globalByDate.size === 0) return; // no household basis → nothing to re-weight

    for (const scope of listScopeOptions(workspace)) {
      for (const snap of readSnapshots(db, scope.id)) {
        const globalValueMinor = globalByDate.get(snap.dateKey);
        if (globalValueMinor === undefined) continue;

        const frozenHoldings = readSnapshotHoldings(db, {
          from: snap.dateKey,
          scopeId: scope.id,
          to: snap.dateKey,
        });
        // A legacy capture predating holdings (ADR 0008) has nothing to recompute.
        if (frozenHoldings.length === 0) continue;

        const recalculated = recalculateSnapshotForOwnership({
          frozenHoldings,
          frozenIdentity,
          globalValueMinor,
          holding: asset
            ? { asset, kind: "asset" }
            : { housingAssetIds, kind: "liability", liability: liability! },
          snapshot: snap,
          workspace,
        });

        if (recalculated) {
          saveSnapshot({
            holdings: recalculated.holdings,
            replace: true,
            snapshot: recalculated.snapshot,
          });
        } else {
          db.delete(snapshots).where(eq(snapshots.id, snap.id)).run();
        }
      }
    }
  });
}

/**
 * Ripple newly-mirrored coin purchase dates into snapshot history (ADR 0017, S6
 * / #167). Unlike the operation/curve ripples — which RE-DERIVE one holding's
 * whole value from its ledger on each affected date — a coin acquisition is
 * ADDITIVE and ONE-SHOT: each new trade's value is captured at this sync and
 * added to the coin-collection row of every existing snapshot dated on/after its
 * purchase date. A trade already mirrored on a prior sync is never passed here
 * again, so a later price move never rewrites a past snapshot (frozen), and a
 * sold trade is never subtracted, so it stays in the snapshots it was rippled
 * into while leaving the live holding. No new snapshot dates are generated — only
 * existing snapshots are touched (the literal S6 scope).
 *
 * For each scope/snapshot the per-snapshot delta is the SUM of every new trade
 * acquired on/before that date, applied in a single recalculation so the row and
 * the five figures reconcile in one pass (ADR 0008). Legacy captures with no
 * holding rows are skipped, like the sibling ripples.
 */
function rippleHistoricalSnapshotsForCoinAcquisition(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => void,
  params: { assetId: string; newTrades: readonly CoinPosition[] },
): void {
  const { db } = ctx;

  // The coin-collection holding's identity (ownership, illiquid tier) — read
  // including trashed, since it existed on the snapshot dates regardless.
  const asset = readInvestmentIdentity(db, params.assetId);
  if (!asset) return;

  // The collection's frozen classification captures across every snapshot (#242),
  // read ONCE before any recalc mutates rows (see rippleHistoricalSnapshots).
  const frozenIdentity = readFrozenIdentityCaptures(db, params.assetId, "asset");

  // Each new trade reduced to its frozen GLOBAL value + the date it enters the
  // timeline. A zero-value coin adds nothing, so it never forces a recalculation.
  const trades = params.newTrades
    .filter((position) => position.purchaseDate !== null)
    .map((position) => ({
      purchaseDate: position.purchaseDate as string,
      valueMinor: coinValue(position).minor,
    }))
    .filter((trade) => trade.valueMinor > 0);
  if (trades.length === 0) return;

  for (const scope of listScopeOptions(workspace)) {
    for (const snap of readSnapshots(db, scope.id)) {
      // The combined value of every new coin acquired on/before this snapshot —
      // each trade ripples only from its OWN purchase date forward.
      const globalDeltaMinor = trades
        .filter((trade) => trade.purchaseDate <= snap.dateKey)
        .reduce((sum, trade) => sum + trade.valueMinor, 0);
      if (globalDeltaMinor === 0) continue;

      const frozenHoldings = readSnapshotHoldings(db, {
        from: snap.dateKey,
        scopeId: scope.id,
        to: snap.dateKey,
      });
      // A legacy capture predating holdings (ADR 0008) has nothing to recompute.
      if (frozenHoldings.length === 0) continue;

      const recalculated = recalculateSnapshotForCoinAcquisition({
        asset,
        frozenHoldings,
        frozenIdentity,
        globalDeltaMinor,
        snapshot: snap,
        workspace,
      });

      if (recalculated) {
        saveSnapshot({
          holdings: recalculated.holdings,
          replace: true,
          snapshot: recalculated.snapshot,
        });
      }
    }
  }
}

/**
 * Read one liability's identity (ownership, currency, type, name, associated
 * asset), including trashed liabilities — historical reconstruction needs the
 * identity of debts that existed on past dates even if they were trashed since.
 */
function readLiabilityIdentity(db: StoreDb, liabilityId: string): Liability | null {
  const row = db
    .select({
      id: liabilities.id,
      name: liabilities.name,
      type: liabilities.type,
      currency: liabilities.currency,
      currentBalanceMinor: liabilities.currentBalanceMinor,
      associatedAssetId: liabilities.associatedAssetId,
    })
    .from(liabilities)
    .where(eq(liabilities.id, liabilityId))
    .get();

  if (!row) return null;

  const ownership = db
    .select({
      memberId: liabilityOwnerships.memberId,
      shareBps: liabilityOwnerships.shareBps,
    })
    .from(liabilityOwnerships)
    .where(eq(liabilityOwnerships.liabilityId, liabilityId))
    .all();

  return {
    currency: row.currency,
    currentBalance: { amountMinor: row.currentBalanceMinor, currency: row.currency },
    id: row.id,
    name: row.name,
    ownership,
    type: row.type,
    ...(row.associatedAssetId ? { associatedAssetId: row.associatedAssetId } : {}),
  };
}

/**
 * Read one investment asset's identity (ownership, currency, tier, name),
 * including trashed assets — historical reconstruction needs the identity of
 * holdings that existed on past dates even if they were trashed since.
 */
function readInvestmentIdentity(db: StoreDb, assetId: string): ManualAsset | null {
  const row = db
    .select({
      id: assets.id,
      name: assets.name,
      type: assets.type,
      currency: assets.currency,
      liquidityTier: assets.liquidityTier,
      isPrimaryResidence: assets.isPrimaryResidence,
      instrument: assets.instrument,
    })
    .from(assets)
    .where(eq(assets.id, assetId))
    .get();

  if (!row) return null;

  const ownership = db
    .select({ memberId: assetOwnerships.memberId, shareBps: assetOwnerships.shareBps })
    .from(assetOwnerships)
    .where(eq(assetOwnerships.assetId, assetId))
    .all();

  return {
    currency: row.currency,
    currentValue: { amountMinor: 0, currency: row.currency },
    id: row.id,
    isPrimaryResidence: row.isPrimaryResidence === 1,
    liquidityTier: row.liquidityTier,
    name: row.name,
    ownership,
    type: row.type,
    ...(row.instrument ? { instrument: row.instrument } : {}),
  };
}

/**
 * Backfill a connected Binance source's monthly value history into snapshots
 * (PRD #245 S5 / #250, ADR 0021). The reconstructed `BinanceHistoryCurve` is
 * valued at every completed month-end (and every existing snapshot in the curve's
 * window) and the result is FROZEN into the market holding's row — SET, not
 * additive — generating the base whole-portfolio snapshot when none exists.
 * Append-only/frozen: a date whose snapshot already carries the binance row is
 * left exactly as captured (a re-sync only adds newly-completed months).
 *
 * Atomic (one transaction). A null curve start is a no-op. Binance only — no
 * coins/Numista interaction.
 */
function backfillBinanceHistoricalSnapshots(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => void,
  params: { assetId: string; curve: BinanceHistoryCurve; today: string },
): void {
  const { db } = ctx;
  const { assetId, curve, today } = params;

  // The market asset's identity — read including trashed, since it existed on the
  // snapshot dates regardless (ADR 0012).
  const asset = readInvestmentIdentity(db, assetId);
  if (!asset) return;

  // The curve's earliest valuable date; below it nothing is valued (ADR 0021).
  const start = binanceCurveStartDate(curve);
  if (start === null) return;

  // The asset's frozen classification captures across every snapshot (#242), read
  // ONCE before any recalc mutates rows (see rippleHistoricalSnapshots).
  const frozenIdentity = readFrozenIdentityCaptures(db, assetId, "asset");

  // Every completed month-end (never the current partial month) — the same anchors
  // across every scope (the curve is portfolio-wide). Built once.
  const monthEnds = completedMonthEndDates(curve, today);

  // Build deps once — the same for every scope (lesson from #114).
  const deps = buildHistoricalSnapshotDeps(db, workspace);

  ctx.transaction(() => {
    for (const scope of listScopeOptions(workspace)) {
      const existing = readSnapshots(db, scope.id);
      const existingByDate = new Map(existing.map((snap) => [snap.dateKey, snap]));

      // Affected dates = the UNION of the completed month-ends and every existing
      // snapshot date in [start, today) — ascending, deduped. An existing snapshot
      // in the window gets the binance value added even if it is not a month-end.
      // Month-ends are lower-bounded by `start` too: a month-end below the curve's
      // first valuable day values to 0, so anchoring there would only materialize a
      // spurious zero-valued snapshot and drag the UI's "Datos desde" before the
      // real curve start (#250 review).
      const affected = new Set<string>(monthEnds.filter((d) => d >= start && d < today));
      for (const snap of existing) {
        if (snap.dateKey >= start && snap.dateKey < today) affected.add(snap.dateKey);
      }
      const dates = [...affected].sort();

      // Read the scope's frozen rows for the whole [start, today) band in ONE
      // batched query (#205), grouped by date in memory (one read per scope).
      const frozenByDate = groupFrozenHoldingsByDate(
        readSnapshotHoldings(db, { scopeId: scope.id, from: start }),
      );

      for (const dateKey of dates) {
        const frozenHoldings = frozenByDate.get(dateKey) ?? [];

        // Append-only/frozen: a date whose snapshot already carries the binance
        // asset's frozen row is left exactly as captured (never rewritten).
        const alreadyHasBinanceRow = frozenHoldings.some(
          (row) => row.holdingId === assetId && row.kind === "asset",
        );
        if (alreadyHasBinanceRow) continue;

        const valueMinor = binanceValueAtDate(curve, dateKey);
        const snap = existingByDate.get(dateKey);

        if (snap !== undefined) {
          // An existing snapshot at this date → SET the binance row to the
          // reconstructed value. A legacy capture predating holdings (ADR 0008)
          // has nothing to reconcile against — leave it frozen.
          if (frozenHoldings.length === 0) continue;
          const recalculated = recalculateSnapshotForConnectedValue({
            asset,
            frozenHoldings,
            frozenIdentity,
            globalValueMinor: valueMinor,
            snapshot: snap,
            workspace,
          });
          if (recalculated) {
            saveSnapshot({
              holdings: recalculated.holdings,
              replace: true,
              snapshot: recalculated.snapshot,
            });
          }
          continue;
        }

        // No snapshot at this date → generate the base whole-portfolio snapshot
        // (mirror the `rippleHistoricalSnapshots` generate branch), then OVERRIDE
        // its binance row to the reconstructed value: the base values the holding
        // at its stored/live basis (wrong for the past) — the SET corrects it.
        const built = buildSnapshotAtDate({
          assets: deps.assets,
          capturedAt: historicalCapturedAt(dateKey),
          coinPositionsByAsset: deps.coinPositionsByAsset,
          costBasisAssetIds: deps.costBasisAssetIds,
          debtBalanceByLiability: deps.debtBalanceByLiability,
          housingValuationByAsset: deps.housingValuationByAsset,
          id: `histsnap_${scope.id}_${dateKey}`,
          liabilities: deps.liabilities,
          manualValueHistory: deps.manualValueHistory,
          operationsByAsset: deps.operationsByAsset,
          scopeId: scope.id,
          scopeLabel: scope.label,
          targetDate: dateKey,
          today,
          workspace,
        });

        // The base built nothing AND the binance value is 0 → an entirely empty
        // snapshot. Skip it (the portfolio held nothing valuable that day).
        if (!built && valueMinor === 0) continue;

        const base = built ?? {
          holdings: [],
          snapshot: createNetWorthSnapshot({
            capturedAt: historicalCapturedAt(dateKey),
            id: `histsnap_${scope.id}_${dateKey}`,
            isMonthlyClose: false,
            scopeId: scope.id,
            scopeLabel: scope.label,
            summary: {
              debts: { amountMinor: 0, currency: workspace.baseCurrency },
              grossAssets: { amountMinor: 0, currency: workspace.baseCurrency },
              housingEquity: { amountMinor: 0, currency: workspace.baseCurrency },
              liquidNetWorth: { amountMinor: 0, currency: workspace.baseCurrency },
              scopeId: scope.id,
              totalNetWorth: { amountMinor: 0, currency: workspace.baseCurrency },
            },
            warnings: [],
          }),
        };

        const overridden = recalculateSnapshotForConnectedValue({
          asset,
          frozenHoldings: base.holdings,
          frozenIdentity,
          globalValueMinor: valueMinor,
          snapshot: base.snapshot,
          workspace,
        });
        if (overridden) {
          saveSnapshot({
            holdings: overridden.holdings,
            replace: false,
            snapshot: overridden.snapshot,
          });
        }
      }
    }

    ctx.writeAuditEntry("backfill_binance_history", "asset", assetId, {
      monthEnds: monthEnds.length,
      start,
    });
  });
}

/** Options for {@link gapFillHistoricalSnapshots}. */
interface GapFillOptions {
  /**
   * Wrap the whole fill in one transaction so a mid-run failure rolls every
   * generated snapshot back (#185). The standalone backfill sets this — it owns
   * no enclosing transaction, so without it a throw partway leaves a partially
   * filled history with no signal. The post-import path leaves it off: the
   * import already committed (ADR 0010) and the gap-fill is a best-effort
   * post-step whose failure is surfaced to the caller, not rolled back.
   */
  atomic?: boolean;
}

/**
 * Fill historical-snapshot gaps after an import (ADR 0012, Slice 3 / #112):
 * generate a snapshot for each past operation date that has no snapshot in the
 * imported file. Imported snapshots are never touched. One pass, no per-
 * operation ripple — each date is reconstructed once from all operations ≤ it.
 *
 * The standalone backfill passes `atomic` so the whole run rolls back on any
 * failure (#185); the post-import path runs best-effort and lets its caller
 * surface a thrown error instead of leaving silent partial history.
 */
function gapFillHistoricalSnapshots(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => void,
  today: string,
  options: GapFillOptions = {},
): void {
  const deps = buildHistoricalSnapshotDeps(ctx.db, workspace);

  const eventDates = new Set<string>();
  for (const operations of deps.operationsByAsset.values()) {
    for (const operation of operations) {
      const dateKey = operation.executedAt.slice(0, 10);
      if (dateKey < today) eventDates.add(dateKey);
    }
  }
  const sortedDates = [...eventDates].sort();

  const fill = (): void => {
    for (const scope of deps.scopes) {
      const existingDates = new Set(
        readSnapshots(ctx.db, scope.id).map((snap) => snap.dateKey),
      );

      for (const dateKey of sortedDates) {
        if (existingDates.has(dateKey)) continue; // imported snapshot stays intact

        const built = buildSnapshotAtDate({
          assets: deps.assets,
          capturedAt: historicalCapturedAt(dateKey),
          coinPositionsByAsset: deps.coinPositionsByAsset,
          costBasisAssetIds: deps.costBasisAssetIds,
          debtBalanceByLiability: deps.debtBalanceByLiability,
          housingValuationByAsset: deps.housingValuationByAsset,
          id: `histsnap_${scope.id}_${dateKey}`,
          liabilities: deps.liabilities,
          manualValueHistory: deps.manualValueHistory,
          operationsByAsset: deps.operationsByAsset,
          scopeId: scope.id,
          scopeLabel: scope.label,
          targetDate: dateKey,
          today,
          workspace,
        });

        if (built) {
          saveSnapshot({
            holdings: built.holdings,
            replace: false,
            snapshot: built.snapshot,
          });
        }
      }
    }
  };

  // Atomic standalone backfill: one transaction over the whole fill, so a
  // mid-run throw rolls every generated snapshot back. saveSnapshot opens its
  // own (now nested, savepoint-backed) transaction per date — the inner ones
  // commit into this outer one, which is the unit that survives or rolls back.
  if (options.atomic) {
    ctx.transaction(fill);
  } else {
    fill();
  }
}

/**
 * Run a unit of work against a freshly opened store and guarantee the SQLite
 * connection is closed afterwards — even if the callback throws. This is the one
 * home for the open/use/close lifecycle so callers never leak a connection.
 */
export function withStore<T>(
  run: (store: WorthlineStore) => T,
  options: WorthlineStoreOptions = {},
): T {
  const store = createWorthlineStore(options);

  try {
    return run(store);
  } finally {
    store.close();
  }
}

export function resolveDatabasePath(options: BootstrapHealthcheckOptions = {}): string {
  if (options.databasePath) {
    return resolve(options.databasePath);
  }

  if (process.env.WORTHLINE_DB_PATH) {
    return resolve(process.env.WORTHLINE_DB_PATH);
  }

  return join(resolveDataDir(options), "worthline.sqlite");
}

export function resolveDataDir(options: BootstrapHealthcheckOptions = {}): string {
  if (options.dataDir) {
    return resolve(options.dataDir);
  }

  if (process.env.WORTHLINE_DATA_DIR) {
    return resolve(process.env.WORTHLINE_DATA_DIR);
  }

  return join(findWorkspaceRoot(), ".local", "worthline");
}

function toDisplayPath(databasePath: string): string {
  const workspaceRoot = findWorkspaceRoot();
  const relativePath = relative(workspaceRoot, databasePath);

  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath;
  }

  return databasePath;
}

function findWorkspaceRoot(startAt = process.cwd()): string {
  let current = resolve(startAt);

  while (true) {
    const manifestPath = join(current, "package.json");

    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        workspaces?: unknown;
      };

      if (manifest.workspaces) {
        return current;
      }
    }

    const parent = dirname(current);

    if (parent === current) {
      return resolve(startAt);
    }

    current = parent;
  }
}
