import type { LocalPersistenceStatus } from "@worthline/domain";
import type {
  BinanceHistoryCurve,
  CreateInvestmentOperationInput,
  CreateManualAssetInput,
  DecimalString,
  FireScopeConfig,
  ValuationCadence,
  WarningOverride,
} from "@worthline/domain";
import type { Client } from "@libsql/client";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { openDrizzle, openLibsqlClient } from "./libsql-client";

import {
  appSettings,
  assetOwnerships,
  assets,
  auditLog,
  liabilities,
  liabilityOwnerships,
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
  createAgentViewReadStore,
  type AgentViewReadStore,
  type AgentViewTrashedHolding,
} from "./agent-view-read-store";
import {
  createConnectedSourceStore,
  type ConnectedSourceStore,
  type SourcePositionInput,
} from "./connected-source-store";
import { migrate, type MigrateResult } from "./migrate";
import { createConnectedSourceSeams } from "./connected-source-seams";
import {
  createSnapshotOrchestrator,
  gapFillHistoricalSnapshots,
} from "./snapshot-orchestrator";
import {
  createDatedFactSeams,
  rippleHistoricalSnapshotsForDebt,
  rippleHousingAfterEdit,
} from "./dated-fact-seams";
import { buildHistoricalSnapshotDeps } from "./historical-snapshot-deps";

export { SCHEMA_VERSION } from "./migrate";
export { openLibsqlClient } from "./libsql-client";
export {
  ENCRYPTION_KEY_ENV,
  makeSecretCrypto,
  openSecret,
  sealSecret,
  type SecretCrypto,
} from "./crypto";
export {
  fingerprintExport,
  syncPull,
  syncPush,
  SyncStaleError,
  type PullResult,
  type PushResult,
  type SyncDeps,
} from "./sync-engine";
export {
  createControlPlaneStore,
  createInMemoryControlPlaneStore,
  type ControlPlaneStore,
  type ControlPlaneStoreOptions,
  type ControlPlaneUser,
  type ControlPlaneWorkspace,
  type ControlPlaneGrant,
} from "./control-plane";
export {
  provisionWorkspaceForUser,
  type TursoPort,
  type ProvisionDeps,
} from "./provisioner";
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
import { createGoalStore, type GoalStore } from "./goal-store";
import {
  createOperationsStore,
  type OperationsStore,
  type UpdateInvestmentOperationInput,
} from "./operations-store";
import { createSnapshotStore, type SnapshotStore } from "./snapshot-store";
import {
  createStoreContext,
  hardDeleteAssetTx,
  hardDeleteLiabilityTx,
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
  AgentViewConnectedSource,
  AgentViewPriceFreshness,
  AgentViewReadStore,
  AgentViewSourceFreshness,
  AgentViewTrashedHolding,
} from "./agent-view-read-store";
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

export interface WorthlineStoreOptions {
  databasePath?: string;
  dataDir?: string;
  url?: string;
  authToken?: string;
}

export interface BootstrapHealthcheckOptions extends WorthlineStoreOptions {
  now?: () => Date;
}

export type DatabaseTarget =
  | { kind: "path"; databasePath: string }
  | { kind: "url"; url: string; authToken?: string };

interface DatabaseTargetEnv extends Record<string, string | undefined> {
  WORTHLINE_DB_AUTH_TOKEN?: string;
  WORTHLINE_DB_PATH?: string;
  WORTHLINE_DB_URL?: string;
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
  /** Intermediate goals + their assigned holdings (PRD #421, #424). */
  goals: GoalStore;
  /** Narrow read-only port for the external agent-view API. */
  agentView: AgentViewReadStore;

  // ── Cross-cutting (no per-domain home) ──────────────────────────────────────

  close: () => void;
  acknowledgeWarning: (code: string, entityId: string) => Promise<number>;
  removeWarningOverride: (code: string, entityId: string) => Promise<void>;
  readWarningOverrides: () => Promise<WarningOverride[]>;
  readTrash: () => Promise<TrashView>;
  /** Hard-delete every trashed holding atomically. Returns how many of each kind were removed. */
  emptyTrash: () => Promise<{ assets: number; liabilities: number }>;
  readAuditLog: (filter?: { entityId?: string }) => Promise<AuditLogEntry[]>;
  readFireConfig: () => Promise<Record<string, FireScopeConfig>>;
  saveFireConfig: (scopeId: string, config: FireScopeConfig) => Promise<void>;
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
  ) => Promise<void>;
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
  }) => Promise<void>;
  /**
   * Historical-price backfill seam (#380, ADR 0033): freeze a provider's
   * historical unit prices onto ONE investment's monthly snapshots, atomically in
   * a single transaction. This is the ONLY path that rewrites historical
   * `unit_price` — explicit, auditable, never a refresh side effect. For each
   * monthly point (1st of the month from the first operation through `today`) where
   * the position existed and the source returned a price, it re-values ONLY that
   * asset's row (units × price) and preserves every OTHER frozen row verbatim
   * (ADR 0008/0012). A missing snapshot is generated; an existing one is updated in
   * place. Months without a price stay GAPS — never invented. Returns the counts,
   * the gaps, and the source used. `today` defaults to the current date.
   *
   * Pass `dryRun: true` to compute the SAME per-scope create/update counts the
   * apply would produce WITHOUT writing anything — the preview's single source of
   * truth, so the surfaced counts can never diverge from what confirm writes
   * (notably in household mode, where the asset spans multiple scopes).
   */
  backfillInvestmentPricesAndRipple: (params: {
    assetId: string;
    pricesByDate: ReadonlyMap<string, DecimalString>;
    source: string;
    today?: string;
    dryRun?: boolean;
  }) => Promise<{ created: number; updated: number; gaps: string[]; source: string }>;
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
  }) => Promise<{ assetId: string; executedAt: string } | null>;
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
  ) => Promise<void>;
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
  ) => Promise<number>;
  /**
   * Valuation dated-fact seam (ADR 0020): delete ONE valuation anchor AND ripple
   * the snapshots from its date, atomically. The from-date is the deleted anchor's
   * own date, captured behind the seam before the delete; a not-found delete
   * ripples nothing and a future date generates no history. Returns 1 if removed,
   * 0 if not found. Wraps `assets.deleteValuationAnchor` + the valuation ripple.
   */
  deleteValuationAnchorAndRipple: (
    anchorId: string,
    opts?: { today?: string },
  ) => Promise<number>;
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
  ) => Promise<void>;
  /**
   * Valuation-cadence parameter-edit seam (ADR 0020 / 0031, #394): persist a
   * housing asset's valuation cadence AND re-ripple that ONE asset's history,
   * atomically. A cadence change is a parameter edit (ADR 0012), so the whole
   * appreciation curve is recut from min(first past anchor, earliest existing
   * snapshot carrying this asset) — the `firstHousingEventDate` rule, skipped when
   * there is nothing to ripple or the from-date is in the future. `today` defaults
   * to the current date. Wraps `assets.setValuationCadence` + the housing ripple.
   */
  setHousingValuationCadenceAndRipple: (
    assetId: string,
    cadence: ValuationCadence | null,
    opts?: { today?: string },
  ) => Promise<void>;
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
  ) => Promise<void>;
  /**
   * Valuation dated-fact seam (ADR 0020): re-derive the housing snapshots after a
   * non-dated-fact metadata edit (editAsset). No dated fact is persisted here; the
   * from-date is derived behind the seam as the first anchor/snapshot date
   * (`firstHousingEventDate` rule). Skips when nothing exists to ripple.
   * `today` defaults to the current date.
   */
  rippleHousingAfterAssetEdit: (
    assetId: string,
    opts?: { today?: string },
  ) => Promise<void>;
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
  ) => Promise<void>;
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
  ) => Promise<void>;
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
  ) => Promise<void>;
  /**
   * Debt dated-fact seam (ADR 0020): create ONE amortization plan AND ripple the
   * per-cuota history it implies, atomically. The affected dates are derived
   * behind the seam from the plan's own schedule (the `amortizable-plan` kind);
   * `today` defaults to the current date. Wraps `liabilities.createAmortizationPlan`.
   */
  createAmortizationPlanAndRipple: (
    input: CreateAmortizationPlanInput,
    opts?: { today?: string },
  ) => Promise<void>;
  /**
   * Debt dated-fact seam (ADR 0020): patch ONE amortization plan AND re-ripple the
   * per-cuota history, atomically (the `amortizable-plan` kind). Returns 1 if
   * updated, 0 if not found. Wraps `liabilities.updateAmortizationPlan`.
   */
  updateAmortizationPlanAndRipple: (
    planId: string,
    input: UpdateAmortizationPlanInput,
    opts: { liabilityId: string; today?: string },
  ) => Promise<number>;
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
  }) => Promise<number>;
  /**
   * Debt dated-fact seam (ADR 0020): add ONE interest-rate revision AND recalculate
   * the snapshots from its date forward, atomically (the `amortizable-revision`
   * kind — a revision generates no new snapshot). The future guard rides the seam.
   * Wraps `liabilities.addInterestRateRevision`.
   */
  addInterestRateRevisionAndRipple: (
    input: AddInterestRateRevisionInput,
    opts: { liabilityId: string; today?: string },
  ) => Promise<void>;
  /**
   * Valuation-cadence parameter-edit seam (ADR 0020 / 0031, #393): persist a
   * liability's valuation cadence AND re-ripple that ONE debt's history,
   * atomically. A cadence change is a parameter edit (ADR 0012), so the whole
   * curve is recut: an amortizable debt re-ripples from its plan (every cuota
   * boundary, the `amortizable-plan` kind), a revolving debt with anchors from its
   * earliest anchor (the `anchor` kind). Informal debts (always a step) and a
   * model with no anchors need no ripple. `today` defaults to the current date.
   * Wraps `liabilities.setValuationCadence`.
   */
  setValuationCadenceAndRipple: (
    liabilityId: string,
    cadence: ValuationCadence | null,
    opts?: { today?: string },
  ) => Promise<void>;
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
  ) => Promise<number>;
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
  ) => Promise<number>;
  /**
   * Debt dated-fact seam (ADR 0020): add ONE early repayment AND generate/recalculate
   * snapshots from its date, atomically (the `amortizable-repayment` kind — a past
   * repayment is a dated fact that generates its own snapshot). The future guard
   * rides the seam. Wraps `liabilities.addEarlyRepayment`.
   */
  addEarlyRepaymentAndRipple: (
    input: AddEarlyRepaymentInput,
    opts: { liabilityId: string; today?: string },
  ) => Promise<void>;
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
  ) => Promise<number>;
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
  ) => Promise<number>;
  /**
   * Debt dated-fact seam (ADR 0020): add ONE balance anchor AND generate/recalculate
   * snapshots from its date, atomically (the `anchor` kind). The from-date is the
   * anchor's own date; a future anchor generates no history. Wraps
   * `liabilities.addBalanceAnchor`.
   */
  addBalanceAnchorAndRipple: (
    input: AddBalanceAnchorInput,
    opts?: { today?: string },
  ) => Promise<void>;
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
  ) => Promise<number>;
  /**
   * Debt dated-fact seam (ADR 0020 / 0025): delete ONE balance anchor AND
   * recalculate snapshots from its date forward, atomically (the `anchor` kind).
   * The seam reads the removed date + owning liability from the row it selects by
   * id inside the transaction; the future guard rides the seam. Returns 1 if
   * removed, 0 if not found. Wraps `liabilities.deleteBalanceAnchor`.
   */
  deleteBalanceAnchorAndRipple: (
    anchorId: string,
    opts?: { today?: string },
  ) => Promise<number>;
  /**
   * One-shot backfill (ADR 0012, PRD #107): generate a historical snapshot for
   * every past operation date that has no snapshot yet, across all scopes.
   * Existing snapshots are never recalculated — only gaps are filled. Idempotent.
   * `today` defaults to the current date; pass it to control the cut-off in tests.
   */
  backfillHistoricalSnapshots: (today?: string) => Promise<void>;
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
  }) => Promise<void>;
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
  }) => Promise<void>;
}

/**
 * Run the migration ladder, but skip the schema-version probe for a remote
 * (`libsql://`) database this process has already confirmed at-version (perf
 * #445). The ladder is idempotent and the schema only ever changes on a deploy
 * (a fresh lambda process), so re-reading `schema_meta` on every request to a
 * warm lambda is pure network round-trip overhead.
 *
 * Never memoized for `path` targets (`:memory:` / `file:`): those reuse a single
 * URL string across distinct databases (every `createInMemoryStore()` is a fresh
 * DB), so skipping their migration would be a correctness bug. Remote URLs are
 * unique per workspace and stable, so keying the skip on the URL is safe.
 */
const migratedRemoteUrls = new Set<string>();
async function migrateTarget(target: DatabaseTarget, client: Client) {
  if (target.kind === "url" && migratedRemoteUrls.has(target.url)) {
    return { ranV18Backfill: false, ranV33Backfill: false };
  }
  const result = await migrate(client);
  if (target.kind === "url") migratedRemoteUrls.add(target.url);
  return result;
}

export async function runBootstrapHealthcheck(
  options: BootstrapHealthcheckOptions = {},
): Promise<LocalPersistenceStatus> {
  const target = resolveDatabaseTarget(options);
  const client = openDatabaseTarget(target);
  try {
    await migrateTarget(target, client);

    const db = openDrizzle(client);
    const checkedAt = (options.now ?? (() => new Date()))().toISOString();

    await db
      .insert(appSettings)
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

    const row = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, bootstrapKey))
      .get();

    if (!row) {
      throw new Error("Database bootstrap check did not persist an app setting.");
    }

    return {
      status: "ok",
      checkKey: bootstrapKey,
      checkedAt,
      checkValue: row.value,
      databasePath: target.kind === "path" ? target.databasePath : target.url,
      displayPath:
        target.kind === "path" ? toDisplayPath(target.databasePath) : target.url,
    };
  } finally {
    client.close();
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
export async function createInMemoryStore(): Promise<WorthlineStore> {
  const client = openLibsqlClient(":memory:");
  const migrateResult = await migrate(client);
  return buildStore(client, migrateResult);
}

/**
 * Open an existing SQLite connection as a WorthlineStore, running the migration
 * ladder (and any post-migrate re-ripples) on it. Useful in tests that seed a
 * legacy-schema database and then need to verify the store behaves correctly
 * after migration — without going through the file-path lifecycle of
 * `createWorthlineStore`.
 */
export async function createStoreFromSqlite(client: Client): Promise<WorthlineStore> {
  const migrateResult = await migrate(client);
  return buildStore(client, migrateResult);
}

export async function createWorthlineStore(
  options: WorthlineStoreOptions = {},
): Promise<WorthlineStore> {
  const target = resolveDatabaseTarget(options);
  const client = openDatabaseTarget(target);
  const migrateResult = await migrateTarget(target, client);
  return buildStore(client, migrateResult);
}

function openDatabaseTarget(target: DatabaseTarget): Client {
  if (target.kind === "path") {
    mkdirSync(dirname(target.databasePath), { recursive: true });
    return openLibsqlClient(target.databasePath);
  }

  return openLibsqlClient(target);
}

async function buildStore(
  client: Client,
  migrateResult: MigrateResult,
): Promise<WorthlineStore> {
  // Shared substrate for the extracted *-Store slices (R1–R5, PRD #120): the
  // connection, id generation, transaction wrapping, audit logging, and the
  // per-unit-of-work workspace cache all live in one place.
  const ctx = createStoreContext(client, readWorkspace);
  const { writeAuditEntry } = ctx;
  const snapshotStore = createSnapshotStore(ctx);
  const assetStore = createAssetStore(ctx);
  const liabilityStore = createLiabilityStore(ctx);
  const operationsStore = createOperationsStore(ctx);
  const connectedSourceStore = createConnectedSourceStore(ctx);
  const goalStore = createGoalStore(ctx);
  const agentViewReadStore = createAgentViewReadStore(ctx, {
    listConnectedSources: connectedSourceStore.listSources,
    listSourceAssetIds: connectedSourceStore.listSourceAssetIds,
    readAmortizationPlan: liabilityStore.readAmortizationPlan,
    readAssets: assetStore.readAssets,
    readGoals: goalStore.readGoals,
    readBalanceAnchors: liabilityStore.readBalanceAnchors,
    readDebtModel: liabilityStore.readDebtModel,
    readEarlyRepayments: liabilityStore.readEarlyRepayments,
    readFireConfig: () => store.readFireConfig(),
    readInterestRateRevisions: liabilityStore.readInterestRateRevisions,
    readLiabilities: liabilityStore.readLiabilities,
    readOperations: operationsStore.readOperations,
    readPriceCache: async (assetId) => {
      const cache = await operationsStore.readPriceCache(assetId);
      if (!cache) {
        return null;
      }
      return {
        fetchedAt: cache.fetchedAt,
        freshnessState: cache.freshnessState,
        source: cache.source,
        ...(cache.staleReason === undefined ? {} : { staleReason: cache.staleReason }),
      };
    },
    readSnapshotHoldings: snapshotStore.readSnapshotHoldings,
    readSnapshots: (scopeId) => snapshotStore.readSnapshots(scopeId),
    readSourcePositions: connectedSourceStore.readPositions,
    readSourcePriceCache: async (assetId) => {
      const cache = await operationsStore.readPriceCache(assetId);
      if (!cache) {
        return null;
      }
      return {
        fetchedAt: cache.fetchedAt,
        freshnessState: cache.freshnessState,
        ...(cache.staleReason === undefined ? {} : { staleReason: cache.staleReason }),
      };
    },
    readTrashedHoldings: () => readTrashedHoldings(ctx.db),
    readValuationAnchors: assetStore.readValuationAnchors,
    readWarningOverrides: () => store.readWarningOverrides(),
  });
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

  const store: WorthlineStore = {
    snapshots: snapshotStore,
    assets: assetStore,
    liabilities: liabilityStore,
    operations: operationsStore,
    workspace: workspaceStore,
    connectedSources: connectedSourceStore,
    goals: goalStore,
    agentView: agentViewReadStore,
    // The connected-source cross-cutting seams (issue #487) — syncConnectedSource
    // and applyBinanceHistoryAndRipple — live in their own module; spread the
    // factory result onto the public store object here.
    ...createConnectedSourceSeams(ctx, {
      connectedSources: connectedSourceStore,
      snapshots: snapshotStore,
    }),
    // The snapshot-orchestration seams (issue #488) — backfillHistoricalSnapshots
    // and backfillInvestmentPricesAndRipple — live in their own module; spread the
    // factory result onto the public store object here.
    ...createSnapshotOrchestrator(ctx, { snapshots: snapshotStore }),
    close: () => {
      client.close();
    },
    readFireConfig: async () => {
      const { db } = ctx;
      const row = await db
        .select({ value: appSettings.value })
        .from(appSettings)
        .where(eq(appSettings.key, "fire.config"))
        .get();

      if (!row) {
        return {};
      }

      return JSON.parse(row.value) as Record<string, FireScopeConfig>;
    },
    saveFireConfig: async (scopeId, config) => {
      const { db } = ctx;
      const existing = await db
        .select({ value: appSettings.value })
        .from(appSettings)
        .where(eq(appSettings.key, "fire.config"))
        .get();

      const current: Record<string, FireScopeConfig> = existing
        ? (JSON.parse(existing.value) as Record<string, FireScopeConfig>)
        : {};
      const merged = { ...current, [scopeId]: config };
      const updatedAt = new Date().toISOString();

      await db
        .insert(appSettings)
        .values({ key: "fire.config", updatedAt, value: JSON.stringify(merged) })
        .onConflictDoUpdate({
          set: { updatedAt, value: JSON.stringify(merged) },
          target: appSettings.key,
        })
        .run();
    },
    acknowledgeWarning: async (code, entityId) => {
      const result = await ctx.db
        .insert(warningOverrides)
        .values({ code, entityId })
        .onConflictDoNothing({
          target: [warningOverrides.code, warningOverrides.entityId],
        })
        .run();
      if (result.rowsAffected > 0) {
        await writeAuditEntry("acknowledge_warning", "asset", entityId, { code });
      }
      return result.rowsAffected;
    },
    removeWarningOverride: async (code, entityId) => {
      await ctx.db
        .delete(warningOverrides)
        .where(
          and(eq(warningOverrides.code, code), eq(warningOverrides.entityId, entityId)),
        )
        .run();
      await writeAuditEntry("unacknowledge_warning", "asset", entityId, { code });
    },
    readWarningOverrides: () =>
      ctx.db
        .select({ code: warningOverrides.code, entityId: warningOverrides.entityId })
        .from(warningOverrides)
        .all(),
    readTrash: async () => ({
      assets: await ctx.db
        .select({ id: assets.id, name: assets.name })
        .from(assets)
        .where(isNotNull(assets.deletedAt))
        .orderBy(asc(assets.name))
        .all(),
      liabilities: await ctx.db
        .select({ id: liabilities.id, name: liabilities.name })
        .from(liabilities)
        .where(isNotNull(liabilities.deletedAt))
        .orderBy(asc(liabilities.name))
        .all(),
    }),
    emptyTrash: () =>
      ctx.transaction(async () => {
        const trashedAssets = await ctx.db
          .select({ id: assets.id })
          .from(assets)
          .where(isNotNull(assets.deletedAt))
          .all();
        const trashedLiabilities = await ctx.db
          .select({ id: liabilities.id })
          .from(liabilities)
          .where(isNotNull(liabilities.deletedAt))
          .all();

        let assetsRemoved = 0;
        let liabilitiesRemoved = 0;
        for (const row of trashedAssets)
          assetsRemoved += await hardDeleteAssetTx(ctx, row.id);
        for (const row of trashedLiabilities)
          liabilitiesRemoved += await hardDeleteLiabilityTx(ctx, row.id);

        return { assets: assetsRemoved, liabilities: liabilitiesRemoved };
      }),
    readAuditLog: async (filter) => {
      const { db } = ctx;
      const rows = filter?.entityId
        ? await db
            .select()
            .from(auditLog)
            .where(eq(auditLog.entityId, filter.entityId))
            .orderBy(asc(auditLog.createdAt))
            .all()
        : await db.select().from(auditLog).orderBy(asc(auditLog.createdAt)).all();

      return rows.map((row) => ({
        action: row.action,
        createdAt: row.createdAt,
        details: JSON.parse(row.detailsJson) as Record<string, unknown>,
        entityId: row.entityId,
        entityType: row.entityType,
        id: row.id,
      }));
    },
    // The dated-fact persist-and-ripple seams (issue #489) — the 25 *AndRipple
    // methods that persist ONE dated fact and ripple the snapshots it touches —
    // live in their own module; spread the factory result onto the public store
    // object here.
    ...createDatedFactSeams(ctx, {
      assets: assetStore,
      liabilities: liabilityStore,
      snapshots: snapshotStore,
      operations: operationsStore,
    }),
  };

  // ADR 0019 (#188): after the v18 backfill, re-ripple every amortizable debt
  // so historical snapshots are rewritten from the new two-date curve. For
  // day<=28 plans the new curve is byte-identical to the old single-date curve,
  // so re-ripple is a no-op for figures. For day>=29 plans the clamped
  // first_payment shifts the cadence (addMonths(addMonths(start,1),m-1) ≠
  // addMonths(start,m)), so frozen snapshots must be corrected now — atomically
  // at migration time — rather than drifting silently on the next curve touch.
  if (migrateResult.ranV18Backfill) {
    const workspace = await getWorkspace();
    if (workspace) {
      const today = new Date().toISOString().slice(0, 10);
      const deps = await buildHistoricalSnapshotDeps(ctx.db, workspace);
      for (const [liabilityId, curve] of deps.debtBalanceByLiability) {
        if (curve.debtModel === "amortizable" && curve.plan) {
          await rippleHistoricalSnapshotsForDebt(
            ctx,
            workspace,
            snapshotStore.saveSnapshot,
            {
              kind: "amortizable-plan",
              liabilityId,
              today,
            },
          );
        }
      }
    }
  }

  // v33 (ADR 0031, #393): the cadence column was just added to an existing DB, so
  // the modeled default flipped from interpolated to step (#390–392). Re-ripple
  // every modeled holding so stale interpolated daily-captures are rewritten as
  // steps. This fires ONLY on a genuine upgrade (ranV33Backfill), so fresh-DB
  // tests are unaffected. Mirrors the ranV18Backfill block's structure.
  if (migrateResult.ranV33Backfill) {
    const workspace = await getWorkspace();
    if (workspace) {
      const today = new Date().toISOString().slice(0, 10);
      const deps = await buildHistoricalSnapshotDeps(ctx.db, workspace);
      // Debts: amortizable plans re-ripple from their plan (every cuota boundary);
      // revolving with at least one anchor re-ripple from its earliest anchor.
      // Informal is already a step, and revolving with no anchors is flat — nothing
      // stale to correct in either, so both are skipped.
      for (const [liabilityId, curve] of deps.debtBalanceByLiability) {
        if (curve.debtModel === "amortizable" && curve.plan) {
          await rippleHistoricalSnapshotsForDebt(
            ctx,
            workspace,
            snapshotStore.saveSnapshot,
            {
              kind: "amortizable-plan",
              liabilityId,
              today,
            },
          );
        } else if (
          curve.debtModel === "revolving" &&
          curve.anchors &&
          curve.anchors.length > 0
        ) {
          const earliestAnchorDate = [...curve.anchors]
            .map((a) => a.anchorDate)
            .sort()[0]!;
          await rippleHistoricalSnapshotsForDebt(
            ctx,
            workspace,
            snapshotStore.saveSnapshot,
            {
              fromDateKey: earliestAnchorDate,
              kind: "anchor",
              liabilityId,
              today,
            },
          );
        }
      }
      // Housing: every appreciating asset re-ripples via the existing helper.
      for (const assetId of deps.housingValuationByAsset.keys()) {
        await rippleHousingAfterEdit(
          ctx,
          { assets: assetStore, snapshots: snapshotStore },
          assetId,
          today,
        );
      }
    }
  }

  return store;
}

/**
 * Read the trashed (soft-deleted) holdings for the agent view (#342): every
 * asset/liability WHERE `deleted_at IS NOT NULL`, with the stored value/balance,
 * instrument, deleted stamp, and owner member ids the trash listing needs. A pure
 * read — it never restores, hard-deletes, revalues, or writes an audit row, and it
 * never touches the live context (the live reads exclude trash). No derived /
 * investment valuation is computed here; the STORED current value/balance is
 * exposed as-is, mirroring the trash listing the rest of the app shows.
 */
async function readTrashedHoldings(db: StoreDb): Promise<AgentViewTrashedHolding[]> {
  const assetRows = await db
    .select({
      currentValueMinor: assets.currentValueMinor,
      deletedAt: assets.deletedAt,
      id: assets.id,
      instrument: assets.instrument,
      name: assets.name,
    })
    .from(assets)
    .where(isNotNull(assets.deletedAt))
    .all();

  const liabilityRows = await db
    .select({
      currentBalanceMinor: liabilities.currentBalanceMinor,
      deletedAt: liabilities.deletedAt,
      id: liabilities.id,
      instrument: liabilities.instrument,
      name: liabilities.name,
    })
    .from(liabilities)
    .where(isNotNull(liabilities.deletedAt))
    .all();

  const assetOwners = groupOwnerMemberIds(
    await db
      .select({
        holdingId: assetOwnerships.assetId,
        memberId: assetOwnerships.memberId,
      })
      .from(assetOwnerships)
      .all(),
  );
  const liabilityOwners = groupOwnerMemberIds(
    await db
      .select({
        holdingId: liabilityOwnerships.liabilityId,
        memberId: liabilityOwnerships.memberId,
      })
      .from(liabilityOwnerships)
      .all(),
  );

  return [
    ...assetRows.map((row) => ({
      deletedAt: row.deletedAt,
      id: row.id,
      instrument: row.instrument,
      kind: "asset" as const,
      name: row.name,
      ownerMemberIds: assetOwners.get(row.id) ?? [],
      valueMinor: row.currentValueMinor,
    })),
    ...liabilityRows.map((row) => ({
      deletedAt: row.deletedAt,
      id: row.id,
      instrument: row.instrument,
      kind: "liability" as const,
      name: row.name,
      ownerMemberIds: liabilityOwners.get(row.id) ?? [],
      valueMinor: row.currentBalanceMinor,
    })),
  ];
}

/** Group flat `{ holdingId, memberId }` ownership rows into member ids per holding. */
function groupOwnerMemberIds(
  rows: { holdingId: string; memberId: string }[],
): Map<string, string[]> {
  const byHolding = new Map<string, string[]>();
  for (const row of rows) {
    const existing = byHolding.get(row.holdingId);
    if (existing) {
      existing.push(row.memberId);
    } else {
      byHolding.set(row.holdingId, [row.memberId]);
    }
  }
  return byHolding;
}

/**
 * Run a unit of work against a freshly opened store and guarantee the SQLite
 * connection is closed afterwards — even if the callback throws. This is the one
 * home for the open/use/close lifecycle so callers never leak a connection.
 */
export async function withStore<T>(
  run: (store: WorthlineStore) => T | Promise<T>,
  options: WorthlineStoreOptions = {},
): Promise<T> {
  const store = await createWorthlineStore(options);

  try {
    return await run(store);
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

export function resolveDatabaseTarget(
  options: BootstrapHealthcheckOptions = {},
  env: DatabaseTargetEnv = process.env,
): DatabaseTarget {
  if (options.databasePath) {
    return { kind: "path", databasePath: resolveDatabasePath(options) };
  }

  if (options.url) {
    if (options.url.startsWith("libsql://") && !options.authToken) {
      throw new Error("authToken is required when opening a libsql:// URL directly.");
    }
    return {
      kind: "url",
      url: options.url,
      ...(options.authToken ? { authToken: options.authToken } : {}),
    };
  }

  if (env.WORTHLINE_DB_PATH) {
    return { kind: "path", databasePath: resolve(env.WORTHLINE_DB_PATH) };
  }

  if (!env.WORTHLINE_DB_URL) {
    return { kind: "path", databasePath: resolveDatabasePath(options) };
  }

  if (env.WORTHLINE_DB_URL.startsWith("libsql://") && !env.WORTHLINE_DB_AUTH_TOKEN) {
    throw new Error(
      "WORTHLINE_DB_AUTH_TOKEN is required when WORTHLINE_DB_URL is a libsql:// URL.",
    );
  }

  return {
    kind: "url",
    url: env.WORTHLINE_DB_URL,
    ...(env.WORTHLINE_DB_AUTH_TOKEN ? { authToken: env.WORTHLINE_DB_AUTH_TOKEN } : {}),
  };
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
