import type { LocalPersistenceStatus } from "@worthline/domain";
import type {
  BinanceHistoryCurve,
  CreateInvestmentOperationInput,
  CreateManualAssetInput,
  DecimalString,
  FireScopeConfig,
  Liability,
  ManualAsset,
  NetWorthSnapshot,
  OwnershipShare,
  ValuationCadence,
  WarningOverride,
  Workspace,
} from "@worthline/domain";
import {
  amortizationPaymentDatesUpTo,
  buildSnapshotAtDate,
  globalHoldingValueAtDate,
  historicalCapturedAt,
  housingAssetIdsOf,
  isHousingAsset,
  listScopeOptions,
  recalculateSnapshotForAsset,
  recalculateSnapshotForHousing,
  recalculateSnapshotForLiability,
  recalculateSnapshotForOwnership,
  resolveScopeMemberIds,
} from "@worthline/domain";
import type { Client } from "@libsql/client";
import { and, asc, eq, isNotNull, like } from "drizzle-orm";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { openDrizzle, openLibsqlClient } from "./libsql-client";

import {
  amortizationPlans,
  appSettings,
  assetOperations,
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
  BACKFILL_SNAPSHOT_ID_PREFIX,
  buildHistoricalSnapshotDeps,
  groupFrozenHoldingsByDate,
  readFrozenIdentityCaptures,
  readInvestmentIdentity,
  type HistoricalSnapshotDeps,
} from "./historical-snapshot-deps";

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

  /**
   * The earliest dateKey strictly before `today` of an existing snapshot that
   * carries this asset's row, or null. Used by the fully-behind-seam housing
   * methods to find the earliest snapshot a curve change could affect —
   * including ones dated before the first anchor (rate compounds backward, #184).
   */
  async function housingEarliestSnapshotDate(
    assetId: string,
    today: string,
  ): Promise<string | null> {
    const rows = await snapshotStore.readSnapshotHoldings({
      holdingId: assetId,
      kind: "asset",
    });
    return (
      rows
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
  async function rippleHousingAfterEdit(assetId: string, today: string): Promise<void> {
    const anchors = await assetStore.readValuationAnchors(assetId);
    const firstAnchorDate = anchors
      .map((a) => a.valuationDate)
      .filter((d) => d <= today)
      .sort()[0];
    const snapshotHoldings = await snapshotStore.readSnapshotHoldings({
      holdingId: assetId,
      kind: "asset",
    });
    const fromDateKey =
      firstAnchorDate ??
      snapshotHoldings
        .map((r) => r.dateKey)
        .filter((d) => d <= today)
        .sort()[0] ??
      null;
    if (fromDateKey === null || fromDateKey > today) return;
    const workspace = await getWorkspace();
    if (!workspace) return;
    await rippleHistoricalSnapshotsForValuation(
      ctx,
      workspace,
      store.snapshots.saveSnapshot,
      {
        assetId,
        fromDateKey,
        today,
      },
    );
  }

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
    recordOperationAndRipple: async (input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // One transaction so the persist + ripple commit or roll back together —
      // the dated-fact contract is unrepresentable as "persisted, forgot to
      // ripple" (ADR 0020).
      await ctx.transaction(async () => {
        await operationsStore.recordOperation(input);
        const workspace = await getWorkspace();
        if (!workspace) return;
        await rippleHistoricalSnapshots(ctx, workspace, store.snapshots.saveSnapshot, {
          assetId: input.assetId,
          mode: "record",
          operationDateKey: input.executedAt.slice(0, 10),
          today,
        });
      });
    },
    recordOperationsAndRipple: async ({
      assetId,
      creates,
      overwrites,
      today: todayOpt,
    }) => {
      const today = todayOpt ?? new Date().toISOString().slice(0, 10);
      // One transaction so every create/overwrite + the single batched ripple
      // commit or roll back together (ADR 0020 / 0018). The affected from-date
      // window is derived here from the persisted operations, never by the caller.
      await ctx.transaction(async () => {
        const operationDateKeys: string[] = [];
        for (const input of creates) {
          await operationsStore.recordOperation(input);
          operationDateKeys.push(input.executedAt.slice(0, 10));
        }
        for (const input of overwrites) {
          const result = await operationsStore.updateOperation(input);
          if (result) operationDateKeys.push(result.executedAt.slice(0, 10));
        }
        const workspace = await getWorkspace();
        if (!workspace) return;
        await rippleHistoricalSnapshotsForOperations(
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
      return ctx.transaction(async () => {
        const result = await operationsStore.deleteOperation(operationId);
        if (!result) return null;
        const workspace = await getWorkspace();
        if (workspace) {
          await rippleHistoricalSnapshots(ctx, workspace, store.snapshots.saveSnapshot, {
            assetId: result.assetId,
            mode: "delete",
            operationDateKey: result.executedAt.slice(0, 10),
            today,
          });
        }
        return result;
      });
    },
    addValuationAnchorAndRipple: async (input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // One transaction so the persist + ripple commit or roll back together
      // (ADR 0020). The from-date is the anchor's own date.
      await ctx.transaction(async () => {
        await assetStore.addValuationAnchor(input);
        const workspace = await getWorkspace();
        if (!workspace) return;
        await rippleHistoricalSnapshotsForValuation(
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
      return ctx.transaction(async () => {
        const previous = await assetStore.readValuationAnchorById(anchorId);
        const changes = await assetStore.updateValuationAnchor(anchorId, input);
        if (changes === 0 || !previous) return changes;
        const assetId = previous.assetId;
        const newDate = input.valuationDate ?? previous.valuationDate;
        const fromDateKey =
          previous.valuationDate < newDate ? previous.valuationDate : newDate;
        if (fromDateKey <= today) {
          const workspace = await getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForValuation(
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
      return ctx.transaction(async () => {
        const removed = await assetStore.readValuationAnchorById(anchorId);
        const changes = await assetStore.deleteValuationAnchor(anchorId);
        if (changes === 0 || !removed) return changes;
        if (removed.valuationDate <= today) {
          const workspace = await getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForValuation(
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
    setAnnualAppreciationRateAndRipple: async (assetId, rate, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Atomic persist + ripple (ADR 0020). The earliest affected snapshot date is
      // derived behind the seam: min(first anchor date, earliest existing snapshot
      // carrying this asset) — covers the backward-compounding case (#184).
      await ctx.transaction(async () => {
        await assetStore.setAnnualAppreciationRate(assetId, rate);
        const firstAnchorDate = (await assetStore.readValuationAnchors(assetId))[0]
          ?.valuationDate;
        const earliestSnapshotDate = await housingEarliestSnapshotDate(assetId, today);
        const fromDateKey =
          [firstAnchorDate, earliestSnapshotDate]
            .filter((d): d is string => d != null)
            .sort()[0] ?? null;
        if (fromDateKey === null || fromDateKey > today) return;
        const workspace = await getWorkspace();
        if (!workspace) return;
        await rippleHistoricalSnapshotsForValuation(
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
    setHousingValuationCadenceAndRipple: async (assetId, cadence, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Atomic persist + ripple (ADR 0020 / 0031): a cadence change is a parameter
      // edit (ADR 0012), so the whole appreciation curve is recut. The from-date is
      // derived behind the seam (first past anchor / earliest snapshot) by the
      // shared housing-edit ripple — guarded against an empty range or a future
      // from-date inside it. Mirrors setAnnualAppreciationRateAndRipple.
      await ctx.transaction(async () => {
        await assetStore.setValuationCadence(assetId, cadence);
        await rippleHousingAfterEdit(assetId, today);
      });
    },
    recordHousingValuationAndRipple: async (assetId, currentValue, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Full persist + upsert-today-anchor + ripple, all atomic (ADR 0020).
      // The from-date is min(first past anchor, earliest snapshot) — same rule as
      // firstHousingCurrentValueRippleDate in the old action layer.
      await ctx.transaction(async () => {
        await assetStore.updateAssetValuation(assetId, currentValue);
        // Upsert a today-dated market anchor (adjustsPriorCurve: true).
        const existing = (await assetStore.readValuationAnchors(assetId)).find(
          (a) => a.valuationDate === today,
        );
        if (existing) {
          await assetStore.updateValuationAnchor(existing.id, {
            adjustsPriorCurve: true,
            valueMinor: currentValue,
          });
        } else {
          await assetStore.addValuationAnchor({
            adjustsPriorCurve: true,
            assetId,
            id: ctx.newId(),
            valuationDate: today,
            valueMinor: currentValue,
          });
        }
        // Derive from-date: first past anchor, else earliest snapshot (see #184).
        const firstPastAnchorDate = (await assetStore.readValuationAnchors(assetId))
          .map((a) => a.valuationDate)
          .filter((d) => d < today)
          .sort()[0];
        const fromDateKey =
          firstPastAnchorDate ?? (await housingEarliestSnapshotDate(assetId, today));
        if (fromDateKey === null || fromDateKey > today) return;
        const workspace = await getWorkspace();
        if (!workspace) return;
        await rippleHistoricalSnapshotsForValuation(
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
    rippleHousingAfterAssetEdit: async (assetId, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Ripple-only seam for editAsset (ADR 0020): no dated fact persisted here.
      await ctx.transaction(async () => {
        await rippleHousingAfterEdit(assetId, today);
      });
    },
    updateAssetAndRippleOwnership: async (assetId, patch, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // One transaction so the patch + the scope-axis ripple commit or roll back
      // together (ADR 0020). The previous ownership and the did-it-change
      // comparison are read behind the seam, not at the call site.
      await ctx.transaction(async () => {
        const before =
          (await assetStore.readAssets()).find((a) => a.id === assetId) ?? null;
        await assetStore.updateAsset(assetId, patch);
        // A real_estate asset re-weights through the housing curve ripple — it
        // already re-derives every affected snapshot from the asset's new split,
        // so it covers an ownership edit too (and a from-date in the future is
        // guarded inside the helper).
        const type = patch.type ?? before?.type;
        if (type === "real_estate") {
          await rippleHousingAfterEdit(assetId, today);
          return;
        }
        // A non-real_estate ownership-split change rides the scope-axis ripple;
        // a cosmetic edit (same split) ripples nothing.
        if (
          before &&
          patch.ownership &&
          ownershipChanged(before.ownership, patch.ownership)
        ) {
          const workspace = await getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForOwnership(
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
      return ctx.transaction(async () => {
        const before =
          (await liabilityStore.readLiabilities()).find((l) => l.id === liabilityId) ??
          null;
        await liabilityStore.updateLiability(liabilityId, patch);
        if (
          before &&
          patch.ownership &&
          ownershipChanged(before.ownership, patch.ownership)
        ) {
          const workspace = await getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForOwnership(
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
    createHousingHoldingAndRipple: async (command, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // One transaction so the create + anchor/rate seeding + ripple commit or
      // roll back together (ADR 0020). The from-date is the acquisition date,
      // derived behind the seam from the command's own acquisition anchor.
      await ctx.transaction(async () => {
        await assetStore.createManualAsset(command.asset);
        await assetStore.addValuationAnchor(command.acquisitionAnchor);
        await assetStore.setAnnualAppreciationRate(
          command.asset.id,
          command.annualAppreciationRate,
        );
        if (command.initialValuation) {
          await assetStore.addValuationAnchor(command.initialValuation);
        }
        const workspace = await getWorkspace();
        if (!workspace) return;
        await rippleHistoricalSnapshotsForValuation(
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
    createAmortizationPlanAndRipple: async (input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Atomic persist + ripple (ADR 0020). The plan ripple derives its per-cuota
      // date series internally from the plan's own schedule.
      await ctx.transaction(async () => {
        await liabilityStore.createAmortizationPlan(input);
        const workspace = await getWorkspace();
        if (!workspace) return;
        await rippleHistoricalSnapshotsForDebt(
          ctx,
          workspace,
          store.snapshots.saveSnapshot,
          {
            kind: "amortizable-plan",
            liabilityId: input.liabilityId,
            today,
          },
        );
      });
    },
    updateAmortizationPlanAndRipple: (planId, input, opts) => {
      const today = opts.today ?? new Date().toISOString().slice(0, 10);
      return ctx.transaction(async () => {
        const changes = await liabilityStore.updateAmortizationPlan(planId, input);
        if (changes === 0) return 0;
        const workspace = await getWorkspace();
        if (workspace) {
          await rippleHistoricalSnapshotsForDebt(
            ctx,
            workspace,
            store.snapshots.saveSnapshot,
            {
              kind: "amortizable-plan",
              liabilityId: opts.liabilityId,
              today,
            },
          );
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
      return ctx.transaction(async () => {
        const plan = await liabilityStore.readAmortizationPlan(opts.liabilityId);
        if (!plan) return 0;
        const startDate = plan.disbursementDate;
        const changes = await liabilityStore.deleteAmortizationPlan(plan.id);
        if (changes === 0) return changes;
        if (startDate <= today) {
          const workspace = await getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForDebt(
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
    addInterestRateRevisionAndRipple: async (input, opts) => {
      const today = opts.today ?? new Date().toISOString().slice(0, 10);
      await ctx.transaction(async () => {
        await liabilityStore.addInterestRateRevision(input);
        if (input.revisionDate > today) return;
        const workspace = await getWorkspace();
        if (!workspace) return;
        await rippleHistoricalSnapshotsForDebt(
          ctx,
          workspace,
          store.snapshots.saveSnapshot,
          {
            fromDateKey: input.revisionDate,
            kind: "amortizable-revision",
            liabilityId: opts.liabilityId,
            today,
          },
        );
      });
    },
    setValuationCadenceAndRipple: async (liabilityId, cadence, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      await ctx.transaction(async () => {
        await liabilityStore.setValuationCadence(liabilityId, cadence);
        const workspace = await getWorkspace();
        if (!workspace) return;
        // A cadence change recuts the whole modeled curve (a parameter edit, ADR
        // 0012). Re-ripple the affected debt by its model: amortizable from its
        // plan (every past cuota boundary), revolving from its earliest anchor.
        // Informal (always a step) and a model with no anchors have no between-event
        // movement the cadence could change, so they need no ripple.
        const debtModel = await liabilityStore.readDebtModel(liabilityId);
        if (debtModel === "amortizable") {
          await rippleHistoricalSnapshotsForDebt(
            ctx,
            workspace,
            store.snapshots.saveSnapshot,
            { kind: "amortizable-plan", liabilityId, today },
          );
        } else if (debtModel === "revolving") {
          const anchors = await liabilityStore.readBalanceAnchors(liabilityId);
          const earliestAnchorDate = anchors.map((a) => a.anchorDate).sort()[0];
          if (earliestAnchorDate !== undefined && earliestAnchorDate <= today) {
            await rippleHistoricalSnapshotsForDebt(
              ctx,
              workspace,
              store.snapshots.saveSnapshot,
              { fromDateKey: earliestAnchorDate, kind: "anchor", liabilityId, today },
            );
          }
        }
      });
    },
    updateInterestRateRevisionAndRipple: (revisionId, input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Ripple from the earlier of the old/new date so every affected snapshot
      // recomputes. The seam reads the OLD date itself (ADR 0025).
      return ctx.transaction(async () => {
        // The seam reads the OLD date + owning liability from the row by id inside
        // the transaction (ADR 0025): the caller no longer pre-reads them.
        const {
          changes,
          revisionDate: previousRevisionDate,
          liabilityId,
        } = await liabilityStore.updateInterestRateRevision(revisionId, input);
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
          const workspace = await getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForDebt(
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
      return ctx.transaction(async () => {
        // The seam reads the removed date + owning liability from the row by id
        // inside the transaction (ADR 0025): the caller no longer pre-reads them.
        const {
          changes,
          revisionDate: previousRevisionDate,
          liabilityId,
        } = await liabilityStore.deleteInterestRateRevision(revisionId);
        if (
          changes === 0 ||
          previousRevisionDate === undefined ||
          liabilityId === undefined
        )
          return 0;
        // From-date unchanged: the removed revision's own date.
        if (previousRevisionDate <= today) {
          const workspace = await getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForDebt(
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
    addEarlyRepaymentAndRipple: async (input, opts) => {
      const today = opts.today ?? new Date().toISOString().slice(0, 10);
      // A past repayment is a dated fact: generate the snapshot at its date and
      // recalculate the ones after it (the "amortizable-repayment" kind).
      await ctx.transaction(async () => {
        await liabilityStore.addEarlyRepayment(input);
        if (input.repaymentDate > today) return;
        const workspace = await getWorkspace();
        if (!workspace) return;
        await rippleHistoricalSnapshotsForDebt(
          ctx,
          workspace,
          store.snapshots.saveSnapshot,
          {
            fromDateKey: input.repaymentDate,
            kind: "amortizable-repayment",
            liabilityId: opts.liabilityId,
            today,
          },
        );
      });
    },
    updateEarlyRepaymentAndRipple: (repaymentId, input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      return ctx.transaction(async () => {
        // The seam reads the OLD date + owning liability from the row by id inside
        // the transaction (ADR 0025): the caller no longer pre-reads them.
        const {
          changes,
          repaymentDate: previousRepaymentDate,
          liabilityId,
        } = await liabilityStore.updateEarlyRepayment(repaymentId, input);
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
          const workspace = await getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForDebt(
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
      return ctx.transaction(async () => {
        // The seam reads the removed date + owning liability from the row by id
        // inside the transaction (ADR 0025): the caller no longer pre-reads them.
        const {
          changes,
          repaymentDate: previousRepaymentDate,
          liabilityId,
        } = await liabilityStore.deleteEarlyRepayment(repaymentId);
        if (
          changes === 0 ||
          previousRepaymentDate === undefined ||
          liabilityId === undefined
        )
          return 0;
        // From-date unchanged: the removed repayment's own date.
        if (previousRepaymentDate <= today) {
          const workspace = await getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForDebt(
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
    addBalanceAnchorAndRipple: async (input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Atomic persist + ripple (ADR 0020). The from-date is the anchor's own date.
      await ctx.transaction(async () => {
        await liabilityStore.addBalanceAnchor(input);
        const workspace = await getWorkspace();
        if (!workspace) return;
        await rippleHistoricalSnapshotsForDebt(
          ctx,
          workspace,
          store.snapshots.saveSnapshot,
          {
            fromDateKey: input.anchorDate,
            kind: "anchor",
            liabilityId: input.liabilityId,
            today,
          },
        );
      });
    },
    updateBalanceAnchorAndRipple: (anchorId, input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      return ctx.transaction(async () => {
        // The seam reads the OLD date + owning liability from the row by id inside
        // the transaction (ADR 0025): the caller no longer pre-reads them.
        const {
          changes,
          anchorDate: previousAnchorDate,
          liabilityId,
        } = await liabilityStore.updateBalanceAnchor(anchorId, input);
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
          const workspace = await getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForDebt(
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
      return ctx.transaction(async () => {
        // The seam reads the removed date + owning liability from the row by id
        // inside the transaction (ADR 0025): the caller no longer pre-reads them.
        const {
          changes,
          anchorDate: previousAnchorDate,
          liabilityId,
        } = await liabilityStore.deleteBalanceAnchor(anchorId);
        if (
          changes === 0 ||
          previousAnchorDate === undefined ||
          liabilityId === undefined
        )
          return 0;
        // From-date unchanged: the removed anchor's own date.
        if (previousAnchorDate <= today) {
          const workspace = await getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForDebt(
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
            store.snapshots.saveSnapshot,
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
            store.snapshots.saveSnapshot,
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
            store.snapshots.saveSnapshot,
            {
              fromDateKey: earliestAnchorDate,
              kind: "anchor",
              liabilityId,
              today,
            },
          );
        }
      }
      // Housing: every appreciating asset re-ripples via the existing closure.
      for (const assetId of deps.housingValuationByAsset.keys()) {
        await rippleHousingAfterEdit(assetId, today);
      }
    }
  }

  return store;
}

// ── Historical snapshots (ADR 0012, PRD #107) ────────────────────────────────
//
// The reader primitives and the `buildHistoricalSnapshotDeps` aggregator now live
// in `./historical-snapshot-deps` (the neutral shared substrate the ripple/seam
// modules import, keeping the dependency graph acyclic).

/**
 * Is `dateKey` still an event date for ANY dated fact that mints a `histsnap_`
 * snapshot — not just an investment operation (#305, PR #326 review)? A backfilled
 * snapshot exists on a date only because SOME dated fact fell on it (ADR 0012);
 * the prune may drop it only when NONE remains. The fix is comprehensive: every
 * `histsnap_`-minting ripple in this file is covered, mapped to its date source —
 *
 *  - Investment operations (rippleHistoricalSnapshots ~2111/2258, gap-fill ~3164):
 *    `asset_operations.executed_at` (ISO date or timestamp) LIKE `${dateKey}%` —
 *    the same `slice(0, 10)` basis every ripple keys on.
 *  - Housing valuation anchors (rippleHistoricalSnapshotsForValuation ~2381):
 *    `asset_valuations.valuation_date = dateKey`.
 *  - Balance anchors — revolving/informal debt (rippleHistoricalSnapshotsForDebt
 *    "anchor" ~2530): `liability_balance_anchors.anchor_date = dateKey`.
 *  - Interest-rate revisions (debt "amortizable-revision" — recalc only, but the
 *    revision date stays an event date): `interest_rate_revisions.revision_date`.
 *  - Early repayments (debt "amortizable-repayment" ~2530):
 *    `early_repayments.repayment_date = dateKey`.
 *  - Connected-source coin acquisitions — Numista (rippleHistoricalSnapshotsFor-
 *    CoinAcquisition ~2820): `positions.purchase_date = dateKey` for a coin row.
 *  - Amortization payment boundaries — amortized debt (debt "amortizable-plan"
 *    ~2530): the date is COMPUTED, not stored (disbursement, or `firstPaymentDate
 *    + (m−1) months`). Reuse the domain helper `amortizationPaymentDatesUpTo` to
 *    rebuild each live plan's boundary set and test membership of `dateKey`.
 *  - Binance / connected-value history (backfillBinanceHistoricalSnapshots
 *    ~3047/3066): its dates are month-ends of a curve RECONSTRUCTED LIVE at sync
 *    from the Binance + CoinGecko APIs — they are NOT persisted in any table, so
 *    they cannot be recomputed here. Conservative fallback (data loss is the
 *    failure mode to avoid): if ANY `binance` connected source exists, treat the
 *    date as justified and KEEP the snapshot. The prune then never deletes a
 *    snapshot a Binance history might justify.
 *
 * Conservative by construction: any uncertainty resolves to "justified" (keep).
 */
async function dateHasJustifyingFact(db: StoreDb, dateKey: string): Promise<boolean> {
  // Investment operations: executed_at as a date or timestamp → match the prefix.
  const storedFact = await db
    .select({ marker: assetOperations.id })
    .from(assetOperations)
    .where(like(assetOperations.executedAt, `${dateKey}%`))
    .limit(1)
    .get();
  if (storedFact !== undefined) return true;

  const valuationAnchor = await db
    .select({ marker: assetValuations.id })
    .from(assetValuations)
    .where(eq(assetValuations.valuationDate, dateKey))
    .limit(1)
    .get();
  if (valuationAnchor !== undefined) return true;

  const balanceAnchor = await db
    .select({ marker: liabilityBalanceAnchors.id })
    .from(liabilityBalanceAnchors)
    .where(eq(liabilityBalanceAnchors.anchorDate, dateKey))
    .limit(1)
    .get();
  if (balanceAnchor !== undefined) return true;

  const revision = await db
    .select({ marker: interestRateRevisions.id })
    .from(interestRateRevisions)
    .where(eq(interestRateRevisions.revisionDate, dateKey))
    .limit(1)
    .get();
  if (revision !== undefined) return true;

  const repayment = await db
    .select({ marker: earlyRepayments.id })
    .from(earlyRepayments)
    .where(eq(earlyRepayments.repaymentDate, dateKey))
    .limit(1)
    .get();
  if (repayment !== undefined) return true;

  const coinAcquisition = await db
    .select({ marker: positions.id })
    .from(positions)
    .where(and(eq(positions.kind, "coin"), eq(positions.purchaseDate, dateKey)))
    .limit(1)
    .get();
  if (coinAcquisition !== undefined) return true;

  // Computed amortization payment boundaries: rebuild each live plan's boundary
  // set up to the day AFTER `dateKey` (the helper excludes dates ≥ its target),
  // so a boundary EQUAL to `dateKey` is included, and test membership.
  const targetAfterDate = dayAfter(dateKey);
  for (const plan of await db.select().from(amortizationPlans).all()) {
    const boundaries = amortizationPaymentDatesUpTo(
      {
        annualInterestRate: plan.annualInterestRate,
        disbursementDate: plan.disbursementDate,
        firstPaymentDate: plan.firstPaymentDate,
        initialCapitalMinor: plan.initialCapitalMinor,
        termMonths: plan.termMonths,
      },
      targetAfterDate,
    );
    if (boundaries.includes(dateKey)) return true;
  }

  // Binance history: month-ends of a live-reconstructed curve, not stored. Cannot
  // recompute → keep when any binance source exists (conservative, #326).
  const binanceSource = await db
    .select({ marker: connectedSources.id })
    .from(connectedSources)
    .where(eq(connectedSources.adapter, "binance"))
    .limit(1)
    .get();
  if (binanceSource !== undefined) return true;

  return false;
}

/** The YYYY-MM-DD calendar day immediately after `dateKey` (handles month/year
 *  rollover; used only to make `amortizationPaymentDatesUpTo` include a boundary
 *  EQUAL to `dateKey`, since the helper excludes dates ≥ its target). */
function dayAfter(dateKey: string): string {
  const next = new Date(`${dateKey}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/**
 * Prune a now-orphaned backfilled snapshot (#305): when deleting an operation
 * leaves a `histsnap_` snapshot on a date no operation justifies any more — and
 * it is not a real daily capture — drop the snapshot. Its frozen holding rows go
 * with it via the `snapshot_holdings.snapshot_id` ON DELETE cascade (ADR 0008),
 * for whichever scope's snapshot this is; the caller iterates every scope. Runs
 * in the caller's transaction so the prune commits or rolls back with the ripple.
 * Conservative by construction: returns true (pruned) ONLY for a backfilled id on
 * a date NO remaining dated fact justifies (`dateHasJustifyingFact` covers every
 * `histsnap_`-minting source, #326); in every other case it leaves the snapshot
 * untouched.
 */
async function pruneOrphanedBackfillSnapshot(
  db: StoreDb,
  snapshot: NetWorthSnapshot,
): Promise<boolean> {
  if (!snapshot.id.startsWith(BACKFILL_SNAPSHOT_ID_PREFIX)) return false;
  if (await dateHasJustifyingFact(db, snapshot.dateKey)) return false;
  await db.delete(snapshots).where(eq(snapshots.id, snapshot.id)).run();
  return true;
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
 *   itself derived from the operation that just disappeared). A backfilled
 *   snapshot whose date no operation justifies any more is pruned outright,
 *   frozen rows and all, for every scope (#305) — a daily capture never is.
 *
 * Operations dated today or in the future never generate history — the daily
 * capture covers today and the future is not history. Recalculations honor the
 * unit price each snapshot already captured for an asset; only an asset absent
 * from a snapshot falls back to the last known operation price ≤ its date.
 */
async function rippleHistoricalSnapshots(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => Promise<void>,
  params: {
    assetId: string;
    mode: "record" | "delete";
    operationDateKey: string;
    today: string;
  },
): Promise<void> {
  const { db } = ctx;
  const { assetId, mode, operationDateKey, today } = params;

  // The operated asset's identity — read including trashed, since it existed on
  // the snapshot dates even if it was trashed afterwards (ADR 0012).
  const asset = await readInvestmentIdentity(db, assetId);
  if (!asset) return;
  const operations = (await readAllOperations(db)).get(assetId) ?? [];

  // The asset's frozen classification captures across every snapshot (#242),
  // read ONCE before any recalc mutates rows — the basis the domain seam recovers
  // a newly-appearing row's CONTEMPORANEOUS frozen tier from instead of the live.
  const frozenIdentity = await readFrozenIdentityCaptures(db, assetId, "asset");

  await ctx.transaction(async () => {
    for (const scope of listScopeOptions(workspace)) {
      const existing = await readSnapshots(db, scope.id);
      const existingByDate = new Map(existing.map((snap) => [snap.dateKey, snap]));

      // Generate a fresh whole-portfolio snapshot at the operation date when
      // recording into the past and none exists yet there.
      if (
        mode === "record" &&
        operationDateKey < today &&
        !existingByDate.has(operationDateKey)
      ) {
        const deps = await buildHistoricalSnapshotDeps(db, workspace);
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
          await saveSnapshot({
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
        await readSnapshotHoldings(db, { scopeId: scope.id, from: operationDateKey }),
      );

      // Recalculate every affected existing snapshot — only the operated
      // asset's row changes; all other frozen rows are preserved. (Both modes
      // recalculate ≥ D: record relies on the generate branch above for a
      // brand-new D, and recalculates an existing D in place here.)
      for (const snap of existing) {
        if (snap.dateKey < operationDateKey) continue;

        // Prune an orphaned backfill snapshot (#305, PR #326): deleting ONE
        // operation at date D can only newly-orphan date D ITSELF — every other
        // date keeps its own independent justification — so only the snapshot
        // dated exactly D is a prune candidate (Part A: was over-reaching to every
        // date ≥ D). Deleting the last fact that made D an event date leaves a
        // `histsnap_` fossil frozen with stale holdings, which the /historico
        // per-day bridge misreads as a phantom dip. Drop it (rows cascade) BEFORE
        // recalculating, so a still-present unrelated holding does not keep the
        // orphan alive. A daily capture, or a date ANY remaining dated fact still
        // justifies — an operation, balance/valuation anchor, amortization cuota,
        // rate revision, early repayment, coin acquisition, or a Binance history
        // (conservatively) — is never pruned (guarded inside the helper).
        if (
          mode === "delete" &&
          snap.dateKey === operationDateKey &&
          (await pruneOrphanedBackfillSnapshot(db, snap))
        ) {
          continue;
        }

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
          await saveSnapshot({
            holdings: recalculated.holdings,
            replace: true,
            snapshot: recalculated.snapshot,
          });
        } else {
          // No holdings remain (e.g. the deleted operation was the only basis):
          // drop the snapshot rather than leave it showing stale values.
          await db.delete(snapshots).where(eq(snapshots.id, snap.id)).run();
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
async function rippleHistoricalSnapshotsForOperations(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => Promise<void>,
  params: {
    assetId: string;
    operationDateKeys: string[];
    today: string;
  },
): Promise<void> {
  const { db } = ctx;
  const { assetId, operationDateKeys, today } = params;
  if (operationDateKeys.length === 0) return;

  // The operated asset's identity — read including trashed, since it existed on
  // the snapshot dates even if it was trashed afterwards (ADR 0012).
  const asset = await readInvestmentIdentity(db, assetId);
  if (!asset) return;
  const operations = (await readAllOperations(db)).get(assetId) ?? [];

  // The asset's frozen classification captures across every snapshot (#242), read
  // ONCE before any recalc mutates rows (see rippleHistoricalSnapshots).
  const frozenIdentity = await readFrozenIdentityCaptures(db, assetId, "asset");

  // Unique affected dates, and the earliest from which existing snapshots recalc.
  const generateDates = [...new Set(operationDateKeys)];
  const recalcFrom = generateDates.reduce(
    (min, date) => (date < min ? date : min),
    generateDates[0]!,
  );

  // Build deps once — the same for every scope (lesson from #114).
  const deps = await buildHistoricalSnapshotDeps(db, workspace);

  await ctx.transaction(async () => {
    for (const scope of listScopeOptions(workspace)) {
      const existing = await readSnapshots(db, scope.id);
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
          await saveSnapshot({
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
        await readSnapshotHoldings(db, { scopeId: scope.id, from: recalcFrom }),
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
          await saveSnapshot({
            holdings: recalculated.holdings,
            replace: true,
            snapshot: recalculated.snapshot,
          });
        } else {
          await db.delete(snapshots).where(eq(snapshots.id, snap.id)).run();
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
async function rippleHistoricalSnapshotsForValuation(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => Promise<void>,
  params: {
    assetId: string;
    fromDateKey: string;
    today: string;
  },
): Promise<void> {
  const { db } = ctx;
  const { assetId, fromDateKey, today } = params;

  // The housing asset's identity — read including trashed, since it existed on
  // the snapshot dates even if it was trashed afterwards.
  const asset = await readInvestmentIdentity(db, assetId);
  if (!asset || !isHousingAsset(asset)) return;

  // Build deps once — they are the same for every scope (Fix 2: was per-scope).
  const deps = await buildHistoricalSnapshotDeps(db, workspace);
  const curve = deps.housingValuationByAsset.get(assetId);
  // No map entry means the asset is not housing or has been trashed with no
  // remaining live record — nothing to ripple.
  if (!curve) return;

  // The asset's frozen classification captures across every snapshot (#242), read
  // ONCE before any recalc mutates rows (see rippleHistoricalSnapshots).
  const frozenIdentity = await readFrozenIdentityCaptures(db, assetId, "asset");

  await ctx.transaction(async () => {
    for (const scope of listScopeOptions(workspace)) {
      const existing = await readSnapshots(db, scope.id);
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
          await saveSnapshot({
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

        const frozenHoldings = await readSnapshotHoldings(db, {
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
          await saveSnapshot({
            holdings: recalculated.holdings,
            replace: true,
            snapshot: recalculated.snapshot,
          });
        } else {
          await db.delete(snapshots).where(eq(snapshots.id, snap.id)).run();
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
async function rippleHistoricalSnapshotsForDebt(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => Promise<void>,
  params:
    | { liabilityId: string; kind: "amortizable-plan"; today: string }
    | {
        liabilityId: string;
        kind: "amortizable-revision" | "anchor" | "amortizable-repayment";
        fromDateKey: string;
        today: string;
      },
): Promise<void> {
  const { db } = ctx;
  const { liabilityId, today } = params;

  // The liability's identity — including trashed, since it existed on the
  // snapshot dates even if it was trashed afterwards.
  const liability = await readLiabilityIdentity(db, liabilityId);
  if (!liability) return;

  // Build deps once — the same for every scope (lesson from #114).
  const deps = await buildHistoricalSnapshotDeps(db, workspace);
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

  await ctx.transaction(async () => {
    for (const scope of listScopeOptions(workspace)) {
      const existing = await readSnapshots(db, scope.id);
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
          await saveSnapshot({
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
        await readSnapshotHoldings(db, { scopeId: scope.id, from: recalcFrom }),
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
          await saveSnapshot({
            holdings: recalculated.holdings,
            replace: true,
            snapshot: recalculated.snapshot,
          });
        } else {
          await db.delete(snapshots).where(eq(snapshots.id, snap.id)).run();
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
async function rippleHistoricalSnapshotsForOwnership(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => Promise<void>,
  params: {
    holdingId: string;
    kind: "asset" | "liability";
    previousOwnership: OwnershipShare[];
  },
): Promise<void> {
  const { db } = ctx;
  const { holdingId, kind, previousOwnership } = params;

  // The edited holding's identity, carrying its NEW ownership split — read
  // including trashed, since it existed on the snapshot dates regardless.
  const asset = kind === "asset" ? await readInvestmentIdentity(db, holdingId) : null;
  const liability =
    kind === "liability" ? await readLiabilityIdentity(db, holdingId) : null;
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
  const deps = await buildHistoricalSnapshotDeps(db, workspace);
  // A liability that secures the home nets housing equity (ADR 0013).
  const housingAssetIds =
    liability !== null ? housingAssetIdsOf(deps.assets) : new Set<string>();

  // The holding's frozen classification captures across every snapshot (#242),
  // read ONCE before any recalc mutates rows. A member gaining a stake gets a
  // brand-new row whose frozen housing-ness/tier the seam recovers from these
  // captures (e.g. the household scope's), not from the live identity.
  const frozenIdentity = await readFrozenIdentityCaptures(db, holdingId, kind);

  await ctx.transaction(async () => {
    // The dates to re-weight: exactly the household snapshots carrying the holding
    // (an ownership edit moves no other dates), each mapped to the LOSSLESS global
    // value re-derived from the holding's curve / operations / stored basis. The
    // household row's frozen unit price / cost-basis flag is honored so an
    // investment's re-valued global matches the price the snapshot captured.
    const globalByDate = new Map<string, number>();
    for (const snap of await readSnapshots(db, "household")) {
      const row = (
        await readSnapshotHoldings(db, {
          from: snap.dateKey,
          scopeId: "household",
          to: snap.dateKey,
        })
      ).find((r) => r.holdingId === holdingId && r.kind === kind);
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
      for (const snap of await readSnapshots(db, scope.id)) {
        const globalValueMinor = globalByDate.get(snap.dateKey);
        if (globalValueMinor === undefined) continue;

        const frozenHoldings = await readSnapshotHoldings(db, {
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
          await saveSnapshot({
            holdings: recalculated.holdings,
            replace: true,
            snapshot: recalculated.snapshot,
          });
        } else {
          await db.delete(snapshots).where(eq(snapshots.id, snap.id)).run();
        }
      }
    }
  });
}

/**
 * Read one liability's identity (ownership, currency, type, name, associated
 * asset), including trashed liabilities — historical reconstruction needs the
 * identity of debts that existed on past dates even if they were trashed since.
 */
async function readLiabilityIdentity(
  db: StoreDb,
  liabilityId: string,
): Promise<Liability | null> {
  const row = await db
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

  const ownership = await db
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
