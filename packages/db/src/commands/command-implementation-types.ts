import type {
  AddValuationAnchorInput,
  AssetStore,
  CreateInvestmentAssetInput,
  UpdateAssetInput,
  UpdateValuationAnchorInput,
} from "@db/asset-store";
import type { ContributionPlanStore } from "@db/contribution-plan-store";
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
} from "@db/liability-store";
import type {
  OperationsStore,
  UpdateInvestmentOperationInput,
} from "@db/operations-store";
import type { SnapshotStore } from "@db/snapshot-store";
import type { CreateHousingHoldingCommand } from "@db/store-types";
import type {
  CreateInvestmentOperationInput,
  DebtModel,
  DecimalString,
  ValuationCadence,
} from "@worthline/domain";
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
    today?: string;
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
    opts?: { today?: string },
  ) => Promise<void>;
  recordOperationsAndRipple: (params: {
    assetId: string;
    creates: CreateInvestmentOperationInput[];
    overwrites: UpdateInvestmentOperationInput[];
    deletes?: string[];
    today?: string;
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
    today?: string;
    trigger: Extract<FactBatchTrigger, "assistant" | "statement">;
  }) => Promise<void>;
  deleteOperationAndRipple: (params: {
    operationId: string;
    today?: string;
  }) => Promise<{ assetId: string; executedAt: string } | null>;
  deleteOperationsAndRipple: (params: {
    operationIds: string[];
    today?: string;
  }) => Promise<Array<{ assetId: string; executedAt: string }>>;
  addValuationAnchorAndRipple: (
    input: AddValuationAnchorInput,
    opts?: { today?: string },
  ) => Promise<void>;
  updateValuationAnchorAndRipple: (
    anchorId: string,
    input: UpdateValuationAnchorInput,
    opts?: { today?: string },
  ) => Promise<number>;
  deleteValuationAnchorAndRipple: (
    anchorId: string,
    opts?: { today?: string },
  ) => Promise<number>;
  setAnnualAppreciationRateAndRipple: (
    assetId: string,
    rate: DecimalString | null,
    opts?: { today?: string },
  ) => Promise<void>;
  setHousingValuationCadenceAndRipple: (
    assetId: string,
    cadence: ValuationCadence | null,
    opts?: { today?: string },
  ) => Promise<void>;
  recordHousingValuationAndRipple: (
    assetId: string,
    currentValue: number,
    opts?: { today?: string },
  ) => Promise<void>;
  updateAssetAndRippleOwnership: (
    assetId: string,
    patch: UpdateAssetInput,
    opts?: { today?: string },
  ) => Promise<void>;
  updateLiabilityAndRippleOwnership: (
    liabilityId: string,
    patch: UpdateLiabilityInput,
    opts?: { today?: string },
  ) => Promise<void>;
  createHousingHoldingAndRipple: (
    command: CreateHousingHoldingCommand,
    opts?: { today?: string },
  ) => Promise<void>;
  createAmortizationPlanAndRipple: (
    input: CreateAmortizationPlanInput,
    opts?: { today?: string },
  ) => Promise<void>;
  updateAmortizationPlanAndRipple: (
    planId: string,
    input: UpdateAmortizationPlanInput,
    opts: { liabilityId: string; today?: string },
  ) => Promise<number>;
  deleteAmortizationPlanAndRipple: (opts: {
    liabilityId: string;
    today?: string;
  }) => Promise<number>;
  addInterestRateRevisionAndRipple: (
    input: AddInterestRateRevisionInput,
    opts: { liabilityId: string; today?: string },
  ) => Promise<void>;
  setValuationCadenceAndRipple: (
    liabilityId: string,
    cadence: ValuationCadence | null,
    opts?: { today?: string },
  ) => Promise<void>;
  updateInterestRateRevisionAndRipple: (
    revisionId: string,
    input: UpdateInterestRateRevisionInput,
    opts?: { today?: string },
  ) => Promise<number>;
  deleteInterestRateRevisionAndRipple: (
    revisionId: string,
    opts?: { today?: string },
  ) => Promise<number>;
  addEarlyRepaymentAndRipple: (
    input: AddEarlyRepaymentInput,
    opts: { liabilityId: string; today?: string },
  ) => Promise<void>;
  updateEarlyRepaymentAndRipple: (
    repaymentId: string,
    input: UpdateEarlyRepaymentInput,
    opts?: { today?: string },
  ) => Promise<number>;
  deleteEarlyRepaymentAndRipple: (
    repaymentId: string,
    opts?: { today?: string },
  ) => Promise<number>;
  /**
   * Current-state debt dated-fact seam (ADR 0056, #677): create the derived
   * amortization plan row AND the `startsAtBaseline` balance re-baseline AND
   * sync the liability's `currentBalanceMinor`, atomically, with ONE ripple
   * (the `amortizable-rebaseline` kind, which governs the curve from the
   * baseline forward). The #676 review's requirement that a current-state
   * debt never exists with one fact but not the other — a mid-failure leaves
   * NEITHER persisted. Wraps `liabilities.createAmortizationPlan` +
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
  addBalanceAnchorAndRipple: (
    input: AddBalanceAnchorInput,
    opts?: { today?: string },
  ) => Promise<void>;
  updateBalanceAnchorAndRipple: (
    anchorId: string,
    input: UpdateBalanceAnchorInput,
    opts?: { today?: string },
  ) => Promise<number>;
  deleteBalanceAnchorAndRipple: (
    anchorId: string,
    opts?: { today?: string },
  ) => Promise<number>;
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
   * Debt-model change seam (#1051, the one write #997 left open). Flip a
   * liability's `debtModel` (amortizable ↔ revolving ↔ informal) and re-cut its
   * modeled curve under the new model, atomically, with ONE ripple. The model is
   * a parameter flag (like `valuationCadence`), not a dated fact, so no
   * `fact_batch` row is minted; `debtBalanceAtDate` already gates which facts it
   * reads by the active model, so the other model's dated facts are re-interpreted
   * (never deleted — their audit trail survives a switch back). The pre-change
   * past that the new model cannot reach stays frozen (ADR 0012/0056). A no-op
   * (same model) ripples nothing. `today` defaults to the current date.
   */
  changeDebtModelAndRipple: (
    liabilityId: string,
    debtModel: DebtModel,
    opts?: { today?: string },
  ) => Promise<void>;
}
