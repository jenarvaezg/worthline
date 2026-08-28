import type {
  AddValuationAnchorInput,
  AssetStore,
  CreateInvestmentAssetInput,
  UpdateAssetInput,
  UpdateValuationAnchorInput,
} from "@db/asset-store";
import type { ContributionPlanStore } from "@db/contribution-plan-store";
import type {
  CreateAmortizationPlanInput,
  UpdateAmortizationPlanInput,
} from "@db/liability-amortization-plan-store";
import type {
  AddBalanceAnchorInput,
  UpdateBalanceAnchorInput,
} from "@db/liability-balance-anchor-store";
import type {
  AddBalanceRebaselineInput,
  UpdateBalanceRebaselineInput,
} from "@db/liability-balance-rebaseline-store";
import type {
  AddEarlyRepaymentInput,
  UpdateEarlyRepaymentInput,
} from "@db/liability-early-repayment-store";
import type {
  AddInterestRateRevisionInput,
  UpdateInterestRateRevisionInput,
} from "@db/liability-rate-revision-store";
import type { UpdateLiabilityInput } from "@db/liability-store";
import type {
  OperationsStore,
  UpdateInvestmentOperationInput,
} from "@db/operations-store";
import type { SnapshotStore } from "@db/snapshot-store";
import type { CreateHousingHoldingCommand, LiabilityStore } from "@db/store-types";
import type {
  CreateInvestmentOperationInput,
  CreateLiabilityInput,
  DebtModel,
  DecimalString,
  DomainResult,
  HousingValuationAnchor,
  ValuationCadence,
} from "@worthline/domain";
import type {
  RecordExternalTransferInCommand,
  RecordTransferCommand,
} from "./investment-transfer";
import type { RippleBandCounts } from "./ripple-band";
import type { FactBatchTrigger } from "./types";

/**
 * The persistence ports the dated-fact command implementations close over
 * (issues #489/#972). The composition root (`createDatedFactCommandImplementations`)
 * wires the concrete stores; each per-family factory receives this whole set and
 * uses the ports its family needs.
 */
export interface DatedFactStores {
  assets: AssetStore;
  liabilities: LiabilityStore;
  snapshots: SnapshotStore;
  operations: OperationsStore;
  contributionPlan: ContributionPlanStore;
}

/**
 * How a freshly-created investment holding gets its value (#1599): the opening BUY
 * the alta derived from the declared saldo, or the ONE `transfer_in` that records
 * capital arriving from another institution (#1541). Exclusive by construction —
 * a synthetic apertura beside a real traspaso would eat a year of contribution
 * allowance for capital that merely changed manager (ADR 0080/0083).
 */
export type InvestmentHoldingEntry =
  | { kind: "opening"; operation: CreateInvestmentOperationInput }
  | {
      kind: "external_transfer_in";
      transfer: Omit<RecordExternalTransferInCommand, "destinationAssetId" | "today">;
    };

/** The full investment-alta command for `store.command.createInvestmentHolding`. */
export interface CreateInvestmentHoldingCommand {
  /** The investment row to create; its id is the one the entry is stamped with. */
  asset: CreateInvestmentAssetInput;
  /** What gives the holding its value. Omitted for the empty container. */
  entry?: InvestmentHoldingEntry;
  /** The ripple's anchor — the frontier between history and the daily capture. */
  today: string;
}

/** The full debt-alta command for `store.command.createDebtHolding`. */
export interface CreateDebtHoldingCommand {
  /** The liability row to create. */
  liability: CreateLiabilityInput;
  /** How its balance is valued (ADR 0031) — never a second call. */
  debtModel: DebtModel;
  /** The «alta por estado actual» declaration (ADR 0056), when there is one. */
  currentState?: {
    plan: CreateAmortizationPlanInput;
    rebaseline: AddBalanceRebaselineInput;
  };
  today: string;
}

/**
 * Private dated-fact command implementations (issues #489/#972): the operations that
 * persist ONE dated fact (an operation, a valuation/balance anchor, an
 * amortization plan, a rate revision, an early repayment, a cadence/rate change,
 * or an ownership edit) AND ripple the historical snapshots it touches, each
 * atomically in one transaction (ADR 0020/0062). The composition root supplies
 * persistence ports and exposes only suffix-free intent methods through
 * `CommandHost`; these implementation names never appear on `WorthlineStore`.
 */
export interface DatedFactCommandImplementations {
  createAndLinkContributionOperation: (params: {
    contributionId: string;
    occurrenceId: string;
    operation: CreateInvestmentOperationInput;
    today: string;
  }) => Promise<void>;
  applyStoredContributionValue: (params: {
    contributionId: string;
    occurrenceId: string;
    assetId: string;
    newValueMinor: number;
    executedMinor: number;
  }) => Promise<void>;
  recordOperationAndRipple: (
    input: CreateInvestmentOperationInput,
    opts: { today: string },
  ) => Promise<void>;
  recordOperationsAndRipple: (params: {
    assetId: string;
    creates: CreateInvestmentOperationInput[];
    overwrites: UpdateInvestmentOperationInput[];
    deletes?: string[];
    today: string;
  }) => Promise<void>;
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
    balanceHistories?: Array<{
      liabilityId: string;
      rebaselines: AddBalanceRebaselineInput[];
    }>;
    propertyValuations?: AddValuationAnchorInput[];
    today: string;
    trigger: Extract<FactBatchTrigger, "assistant" | "statement">;
  }) => Promise<void>;
  /**
   * The traspaso gate (#1479, PRD #1393): mint BOTH halves of one traspaso and ripple
   * both holdings' history, atomically in a single transaction. The units of each half
   * and the acquisition cost that travels are DERIVED here, never supplied.
   *
   * Returns a `DomainResult` rather than throwing on the figures the user stated (a
   * non-positive importe, a VL of zero, an importe larger than the position, two
   * holdings in different currencies) so a screen can render them beside the field
   * that produced them. Structural impossibilities still throw — an unknown holding,
   * a non-investment one, a connected one.
   */
  recordTransferAndRipple: (
    command: RecordTransferCommand,
  ) => Promise<DomainResult<void>>;
  /**
   * Record an «alta por traspaso externo» (#1479): ONE `transfer_in` with no pair,
   * because its outgoing half lives in another institution. Writes the row and ripples
   * the destination's history atomically. The inherited cost is DECLARED — nobody here
   * can derive it — and defaults to the amount that arrived.
   */
  recordExternalTransferInAndRipple: (
    command: RecordExternalTransferInCommand,
  ) => Promise<DomainResult<void>>;
  /**
   * Delete BOTH halves of one traspaso and ripple both holdings, atomically (#1479) —
   * the mirror of the write. Returns one entry per deleted row, or an empty array when
   * no row carries that `transferId`.
   */
  deleteTransferAndRipple: (params: {
    transferId: string;
    today: string;
  }) => Promise<Array<{ assetId: string; executedAt: string }>>;
  deleteOperationAndRipple: (params: {
    operationId: string;
    today: string;
  }) => Promise<{ assetId: string; executedAt: string } | null>;
  deleteOperationsAndRipple: (params: {
    operationIds: string[];
    today: string;
  }) => Promise<Array<{ assetId: string; executedAt: string }>>;
  addValuationAnchorAndRipple: (
    input: AddValuationAnchorInput,
    opts: { today: string },
  ) => Promise<void>;
  updateValuationAnchorAndRipple: (
    anchorId: string,
    input: UpdateValuationAnchorInput,
    opts: { today: string },
  ) => Promise<number>;
  deleteValuationAnchorAndRipple: (
    anchorId: string,
    opts: { today: string },
  ) => Promise<number>;
  /**
   * Dry run of the housing valuation ripple (#1562): how much history a curve
   * change from `fromDateKey` would rewrite, counted by the SAME band that does
   * the writing and persisting nothing. The preview of an acquisition edit asks
   * this instead of counting snapshots itself — a preview computed by a second
   * engine is a preview that can disagree with the write (#1438).
   */
  countValuationRippleSnapshots: (params: {
    assetId: string;
    fromDateKey: string;
    today: string;
    /**
     * Count what the curve would do with THESE anchors — the edit is not stored
     * yet, and whether a fresh snapshot appears at the new from-date depends on
     * them (a property has no history before its first appraisal).
     */
    anchors?: readonly HousingValuationAnchor[];
  }) => Promise<RippleBandCounts>;
  setAnnualAppreciationRateAndRipple: (
    assetId: string,
    rate: DecimalString | null,
    opts: { today: string },
  ) => Promise<void>;
  setHousingValuationCadenceAndRipple: (
    assetId: string,
    cadence: ValuationCadence | null,
    opts: { today: string },
  ) => Promise<void>;
  recordHousingValuationAndRipple: (
    assetId: string,
    currentValue: number,
    opts: { today: string },
  ) => Promise<void>;
  updateAssetAndRippleOwnership: (
    assetId: string,
    patch: UpdateAssetInput,
    opts: { today: string },
  ) => Promise<void>;
  /**
   * The liability half of the ownership edit — and the ONE dated-fact command
   * that takes no `today` (#1598): re-weighting a debt's split moves the scope
   * axis of the snapshots that already exist, never the frontier between history
   * and the daily capture. Asking for a day it would ignore is how a caller ends
   * up believing the cut-off matters here.
   */
  updateLiabilityAndRippleOwnership: (
    liabilityId: string,
    patch: UpdateLiabilityInput,
  ) => Promise<void>;
  createHousingHoldingAndRipple: (
    command: CreateHousingHoldingCommand,
    opts: { today: string },
  ) => Promise<void>;
  /**
   * Investment-alta seam (#1599, ADR 0020): create ONE investment holding AND the
   * entry that gives it a value — an opening BUY, or the `transfer_in` that
   * arrived from another institution — atomically, with the entry's own ripple.
   * A holding created without its entry is the fantasma the alta used to leave
   * behind: a fondo at 0 € with no operations, beside an error message.
   *
   * `entry` is a discriminated union, not two optional fields, because the two
   * are mutually exclusive by construction: a synthetic apertura beside a real
   * traspaso would claim a purchase the book never made (ADR 0083). Omitting it
   * creates the empty container the avanzado flow asks for.
   *
   * Returns a `DomainResult` because the traspaso gate can only refuse once the
   * destination exists — its currency is a fact of the row this command is
   * creating. Every pure refusal belongs to the caller, BEFORE the alta.
   */
  createInvestmentHoldingAndRipple: (
    command: CreateInvestmentHoldingCommand,
  ) => Promise<DomainResult<void>>;
  /**
   * Debt-alta seam (#1599, ADR 0020): create ONE liability AND its debt model AND
   * — on the «alta por estado actual» path (ADR 0056) — its derived plan and
   * re-baseline, atomically, with ONE ripple. The model is never a second call:
   * a deuda that lands without it has no curve anyone can draw (ADR 0031).
   */
  createDebtHoldingAndRipple: (command: CreateDebtHoldingCommand) => Promise<void>;
  createAmortizationPlanAndRipple: (
    input: CreateAmortizationPlanInput,
    opts: { today: string },
  ) => Promise<void>;
  updateAmortizationPlanAndRipple: (
    planId: string,
    input: UpdateAmortizationPlanInput,
    opts: { liabilityId: string; today: string },
  ) => Promise<number>;
  deleteAmortizationPlanAndRipple: (opts: {
    liabilityId: string;
    today: string;
  }) => Promise<number>;
  addInterestRateRevisionAndRipple: (
    input: AddInterestRateRevisionInput,
    opts: { liabilityId: string; today: string },
  ) => Promise<void>;
  setValuationCadenceAndRipple: (
    liabilityId: string,
    cadence: ValuationCadence | null,
    opts: { today: string },
  ) => Promise<void>;
  updateInterestRateRevisionAndRipple: (
    revisionId: string,
    input: UpdateInterestRateRevisionInput,
    opts: { today: string },
  ) => Promise<number>;
  deleteInterestRateRevisionAndRipple: (
    revisionId: string,
    opts: { today: string },
  ) => Promise<number>;
  addEarlyRepaymentAndRipple: (
    input: AddEarlyRepaymentInput,
    opts: { liabilityId: string; today: string },
  ) => Promise<void>;
  updateEarlyRepaymentAndRipple: (
    repaymentId: string,
    input: UpdateEarlyRepaymentInput,
    opts: { today: string },
  ) => Promise<number>;
  deleteEarlyRepaymentAndRipple: (
    repaymentId: string,
    opts: { today: string },
  ) => Promise<number>;
  /**
   * Current-state debt dated-fact seam (ADR 0056, #677): create the derived
   * amortization plan row AND the `startsAtBaseline` balance re-baseline AND
   * sync the liability's `currentBalanceMinor`, atomically, with ONE ripple
   * (the re-baseline chain band, which governs the curve from the
   * baseline forward). The #676 review's requirement that a current-state
   * debt never exists with one fact but not the other — a mid-failure leaves
   * NEITHER persisted. Wraps `liabilities.createAmortizationPlan` +
   * `liabilities.addBalanceRebaseline` + `liabilities.updateLiabilityBalance`.
   */
  createCurrentStateDebtAndRipple: (params: {
    plan: CreateAmortizationPlanInput;
    rebaseline: AddBalanceRebaselineInput;
    today: string;
  }) => Promise<void>;
  /**
   * Amortization-schedule import seam (#1406): persist a whole cuadro's worth of
   * interest-rate revisions and early repayments over an EXISTING plan — the plan
   * row itself is never rewritten — AND run ONE ripple, atomically. Returns how
   * many rows were inserted (0 when empty).
   */
  importAmortizationScheduleAndRipple: (params: {
    liabilityId: string;
    revisions: AddInterestRateRevisionInput[];
    earlyRepayments: AddEarlyRepaymentInput[];
    today: string;
  }) => Promise<number>;
  /**
   * Balance-history import seam (ADR 0056, #696): persist a chain of balance
   * re-baselines (`startsAtBaseline: false`) AND run ONE ripple from the
   * earliest checkpoint, atomically. Never N ripples — the batched debt seam
   * #764 S7 consumes. Returns how many rows were inserted (0 when empty).
   */
  importBalanceHistoryAndRipple: (params: {
    liabilityId: string;
    rebaselines: AddBalanceRebaselineInput[];
    today: string;
  }) => Promise<number>;
  addBalanceRebaselineAndRipple: (
    input: AddBalanceRebaselineInput,
    opts: { today: string },
  ) => Promise<void>;
  updateBalanceRebaselineAndRipple: (
    rebaselineId: string,
    input: UpdateBalanceRebaselineInput,
    opts: { today: string },
  ) => Promise<number>;
  deleteBalanceRebaselineAndRipple: (
    rebaselineId: string,
    opts: { today: string },
  ) => Promise<number>;
  addBalanceAnchorAndRipple: (
    input: AddBalanceAnchorInput,
    opts: { today: string },
  ) => Promise<void>;
  updateBalanceAnchorAndRipple: (
    anchorId: string,
    input: UpdateBalanceAnchorInput,
    opts: { today: string },
  ) => Promise<number>;
  deleteBalanceAnchorAndRipple: (
    anchorId: string,
    opts: { today: string },
  ) => Promise<number>;
  /**
   * Valuation dated-fact seam (ADR 0020): re-derive the housing snapshots after a
   * non-dated-fact metadata edit (editAsset). No dated fact is persisted here; the
   * from-date is derived behind the seam as the first anchor/snapshot date
   * (`firstHousingEventDate` rule). Skips when nothing exists to ripple.
   * `today` is the cut-off, stated by the caller (ADR 0024, #1598).
   */
  rippleHousingAfterAssetEdit: (
    assetId: string,
    opts: { today: string },
  ) => Promise<void>;
  /**
   * Debt-model change seam (#1051, the one write #997 left open). Flip a
   * liability's `debtModel` (amortizable ↔ revolving ↔ informal) and re-cut its
   * modeled curve under the new model, atomically, with ONE ripple. The model is
   * a parameter flag (like `valuationCadence`), not a dated fact, so no
   * `fact_batch` row is minted; `debtBalanceAtDate` already gates which facts it
   * reads by the active model, so the other model's dated facts are re-interpreted
   * (never deleted — their audit trail survives a switch back). The pre-change
   * past that the new model cannot reach stays frozen (ADR 0012/0056). A no-op
   * (same model) ripples nothing. `today` is the cut-off, stated by the caller.
   */
  changeDebtModelAndRipple: (
    liabilityId: string,
    debtModel: DebtModel,
    opts: { today: string },
  ) => Promise<void>;
}

/**
 * One statement-import application as the intent layer states it: the
 * persistence seam's params minus `trigger`, which the command host stamps from
 * the lane the write arrives through (`"statement"` for the screen,
 * `"assistant"` for a confirmed proposal). Declared here, next to the seam it
 * derives from, because both the command host and the assistant-proposal gate
 * speak it.
 */
export type StatementImportCommand = Omit<
  Parameters<DatedFactCommandImplementations["applyStatementImportAndRipple"]>[0],
  "trigger"
>;
