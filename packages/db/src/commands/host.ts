import type { AssistantProposalStore } from "@db/assistant-proposal-store";
import type { ConnectedSourceSeams } from "@db/connected-source-seams";
import type { LiabilityStore } from "@db/liability-store";
import type { SnapshotOrchestrator } from "@db/snapshot-orchestrator";
import type { SnapshotStore } from "@db/snapshot-store";
import type { StoreContext } from "@db/store-context";
import type { DatedFactCommandImplementations } from "./dated-facts";
import { rippleHistoricalSnapshotsForDebt } from "./dated-facts";
import type { ImportBalanceHistoryCommand } from "./import-balance-history";
import { executeImportBalanceHistoryCommand } from "./import-balance-history";
import type { FactBatchInput } from "./types";
import { createUnitOfWork } from "./unit-of-work";

type DatedFactCommands = DatedFactCommandImplementations;

/** Intent-level command surface. Persist+ripple implementation details stay private. */
export interface CommandHost {
  createAndLinkContributionOperation: DatedFactCommands["createAndLinkContributionOperation"];
  applyStoredContributionValue: DatedFactCommands["applyStoredContributionValue"];
  recordInvestmentOperation: DatedFactCommands["recordOperationAndRipple"];
  mergeInvestmentOperations: DatedFactCommands["recordOperationsAndRipple"];
  applyStatementImport: DatedFactCommands["applyStatementImportAndRipple"];
  applyAssistantStatementProposal: (
    params: Parameters<DatedFactCommands["applyStatementImportAndRipple"]>[0] & {
      proposalId: string;
    },
  ) => Promise<void>;
  applyAssistantMixedProposal: (
    params: Parameters<DatedFactCommands["applyStatementImportAndRipple"]>[0] & {
      proposalId: string;
    },
  ) => Promise<void>;
  applyAssistantBalanceHistoryProposal: (
    params: Parameters<DatedFactCommands["importBalanceHistoryAndRipple"]>[0] & {
      proposalId: string;
    },
  ) => Promise<void>;
  applyAssistantPropertyValuationProposal: (params: {
    proposalId: string;
    anchor: Parameters<DatedFactCommands["addValuationAnchorAndRipple"]>[0];
    today: string;
  }) => Promise<void>;
  deleteInvestmentOperation: DatedFactCommands["deleteOperationAndRipple"];
  deleteInvestmentOperations: DatedFactCommands["deleteOperationsAndRipple"];
  addValuationAnchor: DatedFactCommands["addValuationAnchorAndRipple"];
  updateValuationAnchor: DatedFactCommands["updateValuationAnchorAndRipple"];
  deleteValuationAnchor: DatedFactCommands["deleteValuationAnchorAndRipple"];
  setAnnualAppreciationRate: DatedFactCommands["setAnnualAppreciationRateAndRipple"];
  setHousingValuationCadence: DatedFactCommands["setHousingValuationCadenceAndRipple"];
  recordHousingValuation: DatedFactCommands["recordHousingValuationAndRipple"];
  updateAssetOwnership: DatedFactCommands["updateAssetAndRippleOwnership"];
  updateLiabilityOwnership: DatedFactCommands["updateLiabilityAndRippleOwnership"];
  createHousingHolding: DatedFactCommands["createHousingHoldingAndRipple"];
  createAmortizationPlan: DatedFactCommands["createAmortizationPlanAndRipple"];
  updateAmortizationPlan: DatedFactCommands["updateAmortizationPlanAndRipple"];
  deleteAmortizationPlan: DatedFactCommands["deleteAmortizationPlanAndRipple"];
  addInterestRateRevision: DatedFactCommands["addInterestRateRevisionAndRipple"];
  setLiabilityValuationCadence: DatedFactCommands["setValuationCadenceAndRipple"];
  updateInterestRateRevision: DatedFactCommands["updateInterestRateRevisionAndRipple"];
  deleteInterestRateRevision: DatedFactCommands["deleteInterestRateRevisionAndRipple"];
  addEarlyRepayment: DatedFactCommands["addEarlyRepaymentAndRipple"];
  updateEarlyRepayment: DatedFactCommands["updateEarlyRepaymentAndRipple"];
  deleteEarlyRepayment: DatedFactCommands["deleteEarlyRepaymentAndRipple"];
  createCurrentStateDebt: DatedFactCommands["createCurrentStateDebtAndRipple"];
  importBalanceHistory: (command: ImportBalanceHistoryCommand) => Promise<number>;
  addBalanceRebaseline: DatedFactCommands["addBalanceRebaselineAndRipple"];
  updateBalanceRebaseline: DatedFactCommands["updateBalanceRebaselineAndRipple"];
  deleteBalanceRebaseline: DatedFactCommands["deleteBalanceRebaselineAndRipple"];
  addBalanceAnchor: DatedFactCommands["addBalanceAnchorAndRipple"];
  updateBalanceAnchor: DatedFactCommands["updateBalanceAnchorAndRipple"];
  deleteBalanceAnchor: DatedFactCommands["deleteBalanceAnchorAndRipple"];
  rippleHousingAfterAssetEdit: DatedFactCommands["rippleHousingAfterAssetEdit"];

  syncConnectedSource: ConnectedSourceSeams["syncConnectedSource"];
  applyBinanceHistory: ConnectedSourceSeams["applyBinanceHistoryAndRipple"];
  backfillHistoricalSnapshots: SnapshotOrchestrator["backfillHistoricalSnapshots"];
  backfillInvestmentPrices: SnapshotOrchestrator["backfillInvestmentPricesAndRipple"];
  correctInvestmentSnapshotUnitPrice: SnapshotOrchestrator["correctInvestmentSnapshotUnitPrice"];
}

/** Private capabilities used to assemble the public, intent-only command host. */
interface InternalCommandHostDependencies {
  assistantProposals: AssistantProposalStore;
  connectedSources: ConnectedSourceSeams;
  datedFacts: DatedFactCommands;
  factPersistence: Pick<LiabilityStore, "addBalanceRebaseline">;
  snapshotOrchestrator: SnapshotOrchestrator;
}

export function createCommandHost(
  ctx: StoreContext,
  snapshots: { saveSnapshot: SnapshotStore["saveSnapshot"] },
  seams: InternalCommandHostDependencies,
): CommandHost {
  const {
    assistantProposals,
    connectedSources,
    datedFacts,
    factPersistence,
    snapshotOrchestrator,
  } = seams;
  const uow = createUnitOfWork(ctx);
  const rippleDebtRebaseline = async ({
    liabilityId,
    fromDateKey,
    today,
  }: {
    liabilityId: string;
    fromDateKey: string;
    today: string;
  }) => {
    const workspace = await ctx.getWorkspace();
    if (!workspace) return;
    await rippleHistoricalSnapshotsForDebt(ctx, workspace, snapshots.saveSnapshot, {
      fromDateKey,
      kind: "amortizable-rebaseline",
      liabilityId,
      today,
    });
  };
  const importBalanceHistory = async (
    params: Parameters<CommandHost["importBalanceHistory"]>[0],
    batch: FactBatchInput = { trigger: params.trigger ?? "manual" },
  ) => {
    const result = await executeImportBalanceHistoryCommand(
      {
        addBalanceRebaseline: factPersistence.addBalanceRebaseline,
        rippleDebtRebaseline,
        uow,
      },
      params,
      batch,
    );
    if (!result.ok) throw new Error(result.error);
    return result.value.created;
  };
  return {
    addBalanceAnchor: datedFacts.addBalanceAnchorAndRipple,
    addBalanceRebaseline: datedFacts.addBalanceRebaselineAndRipple,
    addEarlyRepayment: datedFacts.addEarlyRepaymentAndRipple,
    addInterestRateRevision: datedFacts.addInterestRateRevisionAndRipple,
    addValuationAnchor: datedFacts.addValuationAnchorAndRipple,
    applyBinanceHistory: connectedSources.applyBinanceHistoryAndRipple,
    applyAssistantStatementProposal: async ({ proposalId, ...params }) =>
      ctx.transaction(async () => {
        const proposal = await assistantProposals.read(proposalId);
        if (!proposal)
          throw new Error(`Assistant proposal "${proposalId}" was not found.`);
        if (proposal.kind !== "statement_import") {
          throw new Error(`Assistant proposal "${proposalId}" has an unsupported kind.`);
        }
        if (proposal.status !== "draft") {
          throw new Error(
            `Assistant proposal "${proposalId}" is already resolved as ${proposal.status}.`,
          );
        }
        await datedFacts.applyStatementImportAndRipple(params);
        await assistantProposals.markApplied(proposalId);
      }),
    applyAssistantMixedProposal: async ({ proposalId, ...params }) =>
      ctx.transaction(async () => {
        const proposal = await assistantProposals.read(proposalId);
        if (!proposal || proposal.kind !== "mixed_document_import") {
          throw new Error(`Assistant proposal "${proposalId}" is not a mixed import.`);
        }
        if (proposal.status !== "draft") {
          throw new Error(
            `Assistant proposal "${proposalId}" is already resolved as ${proposal.status}.`,
          );
        }
        await datedFacts.applyStatementImportAndRipple(params);
        await assistantProposals.markApplied(proposalId);
      }),
    applyAssistantBalanceHistoryProposal: async ({
      proposalId,
      liabilityId,
      rebaselines,
      today,
    }) =>
      ctx.transaction(async () => {
        const proposal = await assistantProposals.read(proposalId);
        if (!proposal || proposal.kind !== "balance_history_import") {
          throw new Error(`Assistant proposal "${proposalId}" is not a debt history.`);
        }
        if (proposal.status !== "draft") {
          throw new Error(
            `Assistant proposal "${proposalId}" is already resolved as ${proposal.status}.`,
          );
        }
        await importBalanceHistory(
          { liabilityId, rebaselines, ...(today === undefined ? {} : { today }) },
          { trigger: "assistant" },
        );
        await assistantProposals.markApplied(proposalId);
      }),
    applyAssistantPropertyValuationProposal: async ({ proposalId, anchor, today }) =>
      ctx.transaction(async () => {
        const proposal = await assistantProposals.read(proposalId);
        if (!proposal || proposal.kind !== "property_valuation_anchor") {
          throw new Error(
            `Assistant proposal "${proposalId}" is not a property valuation.`,
          );
        }
        if (proposal.status !== "draft") {
          throw new Error(
            `Assistant proposal "${proposalId}" is already resolved as ${proposal.status}.`,
          );
        }
        await datedFacts.addValuationAnchorAndRipple(anchor, { today });
        await assistantProposals.markApplied(proposalId);
      }),
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
    importBalanceHistory,
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
  };
}
