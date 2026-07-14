import type { ConnectedSourceSeams } from "@db/connected-source-seams";
import type { DatedFactSeams } from "@db/dated-fact-seams";
import { rippleHistoricalSnapshotsForDebt } from "@db/dated-fact-seams";
import type { SnapshotOrchestrator } from "@db/snapshot-orchestrator";
import type { SnapshotStore } from "@db/snapshot-store";
import type { StoreContext } from "@db/store-context";

import type { UnitOfWork } from "./types";
import { createUnitOfWork } from "./unit-of-work";

/** Intent-level command surface. Persist+ripple implementation details stay private. */
export interface CommandHost {
  uow: UnitOfWork;
  rippleDebtRebaseline: (params: {
    liabilityId: string;
    fromDateKey: string;
    today: string;
  }) => Promise<void>;

  createAndLinkContributionOperation: DatedFactSeams["createAndLinkContributionOperation"];
  applyStoredContributionValue: DatedFactSeams["applyStoredContributionValue"];
  recordInvestmentOperation: DatedFactSeams["recordOperationAndRipple"];
  mergeInvestmentOperations: DatedFactSeams["recordOperationsAndRipple"];
  applyStatementImport: DatedFactSeams["applyStatementImportAndRipple"];
  applyAssistantStatementProposal: (
    params: Parameters<DatedFactSeams["applyStatementImportAndRipple"]>[0] & {
      proposalId: string;
    },
  ) => Promise<void>;
  applyAssistantMixedProposal: (
    params: Parameters<DatedFactSeams["applyStatementImportAndRipple"]>[0] & {
      proposalId: string;
    },
  ) => Promise<void>;
  applyAssistantBalanceHistoryProposal: (
    params: Parameters<DatedFactSeams["importBalanceHistoryAndRipple"]>[0] & {
      proposalId: string;
    },
  ) => Promise<void>;
  applyAssistantPropertyValuationProposal: (params: {
    proposalId: string;
    anchor: Parameters<DatedFactSeams["addValuationAnchorAndRipple"]>[0];
    today: string;
  }) => Promise<void>;
  deleteInvestmentOperation: DatedFactSeams["deleteOperationAndRipple"];
  deleteInvestmentOperations: DatedFactSeams["deleteOperationsAndRipple"];
  addValuationAnchor: DatedFactSeams["addValuationAnchorAndRipple"];
  updateValuationAnchor: DatedFactSeams["updateValuationAnchorAndRipple"];
  deleteValuationAnchor: DatedFactSeams["deleteValuationAnchorAndRipple"];
  setAnnualAppreciationRate: DatedFactSeams["setAnnualAppreciationRateAndRipple"];
  setHousingValuationCadence: DatedFactSeams["setHousingValuationCadenceAndRipple"];
  recordHousingValuation: DatedFactSeams["recordHousingValuationAndRipple"];
  updateAssetOwnership: DatedFactSeams["updateAssetAndRippleOwnership"];
  updateLiabilityOwnership: DatedFactSeams["updateLiabilityAndRippleOwnership"];
  createHousingHolding: DatedFactSeams["createHousingHoldingAndRipple"];
  createAmortizationPlan: DatedFactSeams["createAmortizationPlanAndRipple"];
  updateAmortizationPlan: DatedFactSeams["updateAmortizationPlanAndRipple"];
  deleteAmortizationPlan: DatedFactSeams["deleteAmortizationPlanAndRipple"];
  addInterestRateRevision: DatedFactSeams["addInterestRateRevisionAndRipple"];
  setLiabilityValuationCadence: DatedFactSeams["setValuationCadenceAndRipple"];
  updateInterestRateRevision: DatedFactSeams["updateInterestRateRevisionAndRipple"];
  deleteInterestRateRevision: DatedFactSeams["deleteInterestRateRevisionAndRipple"];
  addEarlyRepayment: DatedFactSeams["addEarlyRepaymentAndRipple"];
  updateEarlyRepayment: DatedFactSeams["updateEarlyRepaymentAndRipple"];
  deleteEarlyRepayment: DatedFactSeams["deleteEarlyRepaymentAndRipple"];
  createCurrentStateDebt: DatedFactSeams["createCurrentStateDebtAndRipple"];
  importBalanceHistory: DatedFactSeams["importBalanceHistoryAndRipple"];
  addBalanceRebaseline: DatedFactSeams["addBalanceRebaselineAndRipple"];
  updateBalanceRebaseline: DatedFactSeams["updateBalanceRebaselineAndRipple"];
  deleteBalanceRebaseline: DatedFactSeams["deleteBalanceRebaselineAndRipple"];
  addBalanceAnchor: DatedFactSeams["addBalanceAnchorAndRipple"];
  updateBalanceAnchor: DatedFactSeams["updateBalanceAnchorAndRipple"];
  deleteBalanceAnchor: DatedFactSeams["deleteBalanceAnchorAndRipple"];
  rippleHousingAfterAssetEdit: DatedFactSeams["rippleHousingAfterAssetEdit"];

  syncConnectedSource: ConnectedSourceSeams["syncConnectedSource"];
  applyBinanceHistory: ConnectedSourceSeams["applyBinanceHistoryAndRipple"];
  backfillHistoricalSnapshots: SnapshotOrchestrator["backfillHistoricalSnapshots"];
  backfillInvestmentPrices: SnapshotOrchestrator["backfillInvestmentPricesAndRipple"];
  correctInvestmentSnapshotUnitPrice: SnapshotOrchestrator["correctInvestmentSnapshotUnitPrice"];
}

export function createCommandHost(
  ctx: StoreContext,
  snapshots: { saveSnapshot: SnapshotStore["saveSnapshot"] },
  seams: {
    datedFacts: DatedFactSeams;
    connectedSources: ConnectedSourceSeams;
    snapshotOrchestrator: SnapshotOrchestrator;
    assistant: Pick<
      CommandHost,
      | "applyAssistantStatementProposal"
      | "applyAssistantMixedProposal"
      | "applyAssistantBalanceHistoryProposal"
      | "applyAssistantPropertyValuationProposal"
    >;
  },
): CommandHost {
  const { assistant, connectedSources, datedFacts, snapshotOrchestrator } = seams;
  return {
    addBalanceAnchor: datedFacts.addBalanceAnchorAndRipple,
    addBalanceRebaseline: datedFacts.addBalanceRebaselineAndRipple,
    addEarlyRepayment: datedFacts.addEarlyRepaymentAndRipple,
    addInterestRateRevision: datedFacts.addInterestRateRevisionAndRipple,
    addValuationAnchor: datedFacts.addValuationAnchorAndRipple,
    applyBinanceHistory: connectedSources.applyBinanceHistoryAndRipple,
    ...assistant,
    applyStatementImport: datedFacts.applyStatementImportAndRipple,
    applyStoredContributionValue: datedFacts.applyStoredContributionValue,
    backfillHistoricalSnapshots: snapshotOrchestrator.backfillHistoricalSnapshots,
    backfillInvestmentPrices: snapshotOrchestrator.backfillInvestmentPricesAndRipple,
    correctInvestmentSnapshotUnitPrice:
      snapshotOrchestrator.correctInvestmentSnapshotUnitPrice,
    createAmortizationPlan: datedFacts.createAmortizationPlanAndRipple,
    createAndLinkContributionOperation: datedFacts.createAndLinkContributionOperation,
    createCurrentStateDebt: datedFacts.createCurrentStateDebtAndRipple,
    createHousingHolding: datedFacts.createHousingHoldingAndRipple,
    deleteAmortizationPlan: datedFacts.deleteAmortizationPlanAndRipple,
    deleteBalanceAnchor: datedFacts.deleteBalanceAnchorAndRipple,
    deleteBalanceRebaseline: datedFacts.deleteBalanceRebaselineAndRipple,
    deleteEarlyRepayment: datedFacts.deleteEarlyRepaymentAndRipple,
    deleteInterestRateRevision: datedFacts.deleteInterestRateRevisionAndRipple,
    deleteInvestmentOperation: datedFacts.deleteOperationAndRipple,
    deleteInvestmentOperations: datedFacts.deleteOperationsAndRipple,
    deleteValuationAnchor: datedFacts.deleteValuationAnchorAndRipple,
    importBalanceHistory: datedFacts.importBalanceHistoryAndRipple,
    mergeInvestmentOperations: datedFacts.recordOperationsAndRipple,
    recordHousingValuation: datedFacts.recordHousingValuationAndRipple,
    recordInvestmentOperation: datedFacts.recordOperationAndRipple,
    rippleHousingAfterAssetEdit: datedFacts.rippleHousingAfterAssetEdit,
    setAnnualAppreciationRate: datedFacts.setAnnualAppreciationRateAndRipple,
    setHousingValuationCadence: datedFacts.setHousingValuationCadenceAndRipple,
    setLiabilityValuationCadence: datedFacts.setValuationCadenceAndRipple,
    syncConnectedSource: connectedSources.syncConnectedSource,
    updateAmortizationPlan: datedFacts.updateAmortizationPlanAndRipple,
    updateAssetOwnership: datedFacts.updateAssetAndRippleOwnership,
    updateBalanceAnchor: datedFacts.updateBalanceAnchorAndRipple,
    updateBalanceRebaseline: datedFacts.updateBalanceRebaselineAndRipple,
    updateEarlyRepayment: datedFacts.updateEarlyRepaymentAndRipple,
    updateInterestRateRevision: datedFacts.updateInterestRateRevisionAndRipple,
    updateLiabilityOwnership: datedFacts.updateLiabilityAndRippleOwnership,
    updateValuationAnchor: datedFacts.updateValuationAnchorAndRipple,
    rippleDebtRebaseline: async ({ liabilityId, fromDateKey, today }) => {
      const workspace = await ctx.getWorkspace();
      if (!workspace) return;
      await rippleHistoricalSnapshotsForDebt(ctx, workspace, snapshots.saveSnapshot, {
        fromDateKey,
        kind: "amortizable-rebaseline",
        liabilityId,
        today,
      });
    },
    uow: createUnitOfWork(ctx),
  };
}
