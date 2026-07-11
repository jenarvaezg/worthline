import type {
  BinanceHistoryCurve,
  CreateInvestmentOperationInput,
  CreateManualAssetInput,
  DecimalString,
  FireScopeConfig,
  ValuationCadence,
  WarningOverride,
} from "@worthline/domain";
import type { AgentViewReadStore } from "./agent-view-read-store";
import type {
  AddValuationAnchorInput,
  AssetStore,
  CreateInvestmentAssetInput,
  UpdateAssetInput,
  UpdateValuationAnchorInput,
} from "./asset-store";
import type { ConnectedSourceStore, SourcePositionInput } from "./connected-source-store";
import type { ContributionPlanStore } from "./contribution-plan-store";
import type { ExposureProfileStore } from "./exposure-profile-store";
import type { GoalStore } from "./goal-store";
import type {
  AddBalanceAnchorInput,
  AddBalanceRebaselineInput,
  AddEarlyRepaymentInput,
  AddInterestRateRevisionInput,
  CreateAmortizationPlanInput,
  LiabilityStore,
  UpdateAmortizationPlanInput,
  UpdateBalanceAnchorInput,
  UpdateBalanceRebaselineInput,
  UpdateEarlyRepaymentInput,
  UpdateInterestRateRevisionInput,
  UpdateLiabilityInput,
} from "./liability-store";
import type { OperationsStore, UpdateInvestmentOperationInput } from "./operations-store";
import type { PayoutStore } from "./payout-store";
import type { SnapshotStore } from "./snapshot-store";
import type { WorkspaceStore } from "./workspace-store";

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

export interface DatabaseTargetEnv extends Record<string, string | undefined> {
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
  createAndLinkContributionOperation: (params: {
    contributionId: string;
    occurrenceId: string;
    operation: CreateInvestmentOperationInput;
    today?: string;
  }) => Promise<void>;
  applyStoredContributionValue: (params: {
    contributionId: string;
    occurrenceId: string;
    assetId: string;
    newValueMinor: number;
    executedMinor: number;
  }) => Promise<void>;
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
  /** Hand-entered exposure profiles keyed by security identity (PRD #539, ADR 0039). */
  exposureProfiles: ExposureProfileStore;
  payouts: PayoutStore;
  /** Planned contributions per scope (ADR 0041, PRD #553 S1). */
  contributionPlan: ContributionPlanStore;
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
    deletes?: string[];
    today?: string;
  }) => Promise<void>;
  /**
   * Portfolio-level statement import seam (ADR 0055): create any included new
   * investments, merge operations into matched investments, and ripple the affected
   * history atomically across the confirmed selection.
   */
  applyStatementImportAndRipple: (params: {
    funds: Array<
      | {
          kind: "matched";
          assetId: string;
          creates: CreateInvestmentOperationInput[];
          overwrites: UpdateInvestmentOperationInput[];
          deletes?: string[];
        }
      | {
          kind: "new";
          asset: CreateInvestmentAssetInput;
          creates: CreateInvestmentOperationInput[];
        }
    >;
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
   * Batched operation delete seam (ADR 0020): delete many investment operations
   * and run ONE batched ripple across the affected dates, atomically. Unknown ids
   * are skipped; returns the deleted operations' asset ids and dates.
   */
  deleteOperationsAndRipple: (params: {
    operationIds: string[];
    today?: string;
  }) => Promise<Array<{ assetId: string; executedAt: string }>>;
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
   * Current-state debt dated-fact seam (ADR 0056, #677): create the derived
   * amortization plan row AND the `startsAtBaseline` balance re-baseline AND
   * sync the liability's `currentBalanceMinor`, atomically, with ONE ripple.
   * The #676 review's requirement that a current-state debt never exists with
   * one fact but not the other. Wraps `liabilities.createAmortizationPlan` +
   * `liabilities.addBalanceRebaseline` + `liabilities.updateLiabilityBalance`.
   */
  createCurrentStateDebtAndRipple: (params: {
    plan: CreateAmortizationPlanInput;
    rebaseline: AddBalanceRebaselineInput;
    today?: string;
  }) => Promise<void>;
  /**
   * Balance-history import seam (ADR 0056, #696): persist a chain of balance
   * re-baselines (`startsAtBaseline: false`) AND run ONE ripple from the
   * earliest checkpoint, atomically. Never N ripples — the batched debt seam
   * #764 S7 consumes. Returns how many rows were inserted (0 when empty).
   */
  importBalanceHistoryAndRipple: (params: {
    liabilityId: string;
    rebaselines: AddBalanceRebaselineInput[];
    today?: string;
  }) => Promise<number>;
  addBalanceRebaselineAndRipple: (
    input: AddBalanceRebaselineInput,
    opts?: { today?: string },
  ) => Promise<void>;
  updateBalanceRebaselineAndRipple: (
    rebaselineId: string,
    input: UpdateBalanceRebaselineInput,
    opts?: { today?: string },
  ) => Promise<number>;
  deleteBalanceRebaselineAndRipple: (
    rebaselineId: string,
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
