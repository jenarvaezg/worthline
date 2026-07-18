import type {
  AssistantProposal,
  AssistantProposalStore,
} from "@db/assistant-proposal-store";
import type { ConnectedSourceSeams } from "@db/connected-source-seams";
import type { CorrectionEdit, CorrectionPlan } from "@db/correction-plan";
import type { AddBalanceRebaselineInput, LiabilityStore } from "@db/liability-store";
import type { SnapshotOrchestrator } from "@db/snapshot-orchestrator";
import type { SnapshotStore } from "@db/snapshot-store";
import type { StoreContext } from "@db/store-context";
import { checkOwnershipSplit } from "@worthline/domain";
import type { DatedFactCommandImplementations } from "./dated-facts";
import { rippleHistoricalSnapshotsForDebt } from "./dated-facts";
import type { ImportBalanceHistoryCommand } from "./import-balance-history";
import { executeImportBalanceHistoryCommand } from "./import-balance-history";
import type { FactBatchInput } from "./types";
import { createUnitOfWork } from "./unit-of-work";

type DatedFactCommands = DatedFactCommandImplementations;
type StatementImportCommand = Omit<
  Parameters<DatedFactCommands["applyStatementImportAndRipple"]>[0],
  "trigger"
>;

/** Intent-level command surface. Persist+ripple implementation details stay private. */
export interface CommandHost {
  createAndLinkContributionOperation: DatedFactCommands["createAndLinkContributionOperation"];
  applyStoredContributionValue: DatedFactCommands["applyStoredContributionValue"];
  recordInvestmentOperation: DatedFactCommands["recordOperationAndRipple"];
  mergeInvestmentOperations: DatedFactCommands["recordOperationsAndRipple"];
  applyStatementImport: (params: StatementImportCommand) => Promise<void>;
  applyAssistantStatementProposal: (
    params: StatementImportCommand & { proposalId: string },
  ) => Promise<void>;
  applyAssistantMixedProposal: (
    params: StatementImportCommand & { proposalId: string },
  ) => Promise<void>;
  /**
   * Apply one reconcile proposal (PRD #1103 S5, #1108) and resolve it in the SAME
   * transaction — the "todo o nada" upsert. The web action resolves the curated
   * batch into a statement-import `funds` array (created holdings as `new`,
   * matched-with-movements holdings as `matched`); this runs them through the
   * proven atomic statement-import ripple, so a write that fails midway rolls the
   * whole batch back and nothing persists, and the draft survives for a retry.
   */
  applyAssistantReconcileProposal: (
    params: StatementImportCommand & { proposalId: string },
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
  applyAssistantCorrectionProposal: (params: {
    proposalId: string;
    today: string;
    /**
     * Present only for the "reconstruct" depth (#1053): the freshly re-projected
     * re-baseline chain the confirm composed from the (possibly point-edited)
     * series. When set, the apply routes through the atomic balance-history
     * import (ONE fact_batch, ONE ripple from the oldest date) instead of the
     * anchor-only edit loop. The persisted plan keeps the raw series + before-values.
     */
    reconstruct?: { liabilityId: string; rebaselines: AddBalanceRebaselineInput[] };
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
  changeDebtModel: DatedFactCommands["changeDebtModelAndRipple"];
  importBalanceHistory: (command: ImportBalanceHistoryCommand) => Promise<number>;
  addBalanceRebaseline: DatedFactCommands["addBalanceRebaselineAndRipple"];
  updateBalanceRebaseline: DatedFactCommands["updateBalanceRebaselineAndRipple"];
  deleteBalanceRebaseline: DatedFactCommands["deleteBalanceRebaselineAndRipple"];
  addBalanceAnchor: DatedFactCommands["addBalanceAnchorAndRipple"];
  updateBalanceAnchor: DatedFactCommands["updateBalanceAnchorAndRipple"];
  deleteBalanceAnchor: DatedFactCommands["deleteBalanceAnchorAndRipple"];
  rippleHousingAfterAssetEdit: DatedFactCommands["rippleHousingAfterAssetEdit"];

  syncConnectedSource: ConnectedSourceSeams["syncConnectedSource"];
  /**
   * Run one sync job through the S2 executor and report its typed outcome (#1063):
   * the per-workspace entry point the durable queue's worker routes a leased job
   * to. Never throws for a job failure — returns the typed error result.
   */
  runSyncJob: ConnectedSourceSeams["runSyncJob"];
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
  /** Read seam for the correction apply's live-data revalidation (#1051). */
  liabilityReads: Pick<LiabilityStore, "debtBalanceAtDate">;
  snapshotOrchestrator: SnapshotOrchestrator;
}

async function applyDraftAssistantProposal(
  ctx: StoreContext,
  assistantProposals: AssistantProposalStore,
  proposalId: string,
  requireExpectedKind: (proposal: AssistantProposal | null) => AssistantProposal,
  apply: () => Promise<unknown>,
): Promise<void> {
  await ctx.transaction(async () => {
    const proposal = requireExpectedKind(await assistantProposals.read(proposalId));
    if (proposal.status !== "draft") {
      throw new Error(
        `Assistant proposal "${proposalId}" is already resolved as ${proposal.status}.`,
      );
    }
    await apply();
    await assistantProposals.markApplied(proposalId);
  });
}

function throwCommandResultError(result: { error: string; code?: string }): never {
  const error = new Error(result.error);
  if (result.code !== undefined) Object.assign(error, { code: result.code });
  throw error;
}

/** Extract the single correction plan a `correction` proposal carries. */
function correctionPlanOf(proposal: AssistantProposal): CorrectionPlan {
  const fact = proposal.documents
    .flatMap((document) => document.facts)
    .find((item) => item.kind === "holding_correction");
  if (!fact || fact.kind !== "holding_correction") {
    throw new Error(`Correction proposal "${proposal.id}" carries no correction plan.`);
  }
  return fact.row;
}

/**
 * Apply one correction plan (#1051) inside the caller's transaction: revalidate
 * against live data first (a stale draft fails honestly and nothing persists),
 * validate any ownership split at the trust boundary, then dispatch each edit to
 * the already-shipped #997 write commands with the `"assistant"` provenance. The
 * radius is one holding, save for the atomic debt↔asset pair an ownership fix
 * carries as two edits in the same transaction.
 */
async function applyCorrectionPlan(
  ctx: StoreContext,
  datedFacts: DatedFactCommands,
  liabilityReads: Pick<LiabilityStore, "debtBalanceAtDate">,
  plan: CorrectionPlan,
  today: string,
): Promise<void> {
  if (plan.mode !== "anchor-only") {
    // The reconstruct depth is applied through the atomic balance-history import,
    // never this per-edit loop — the caller routes it before reaching here.
    throw new Error(`Correction plan mode "${plan.mode}" is not applied here.`);
  }
  if (plan.revalidation) {
    const live = await liabilityReads.debtBalanceAtDate(
      plan.revalidation.liabilityId,
      plan.revalidation.asOf,
    );
    if (live !== plan.revalidation.expectedBalanceMinor) {
      const error = new Error(
        "El holding cambió desde que se preparó la propuesta. Vuelve a pedir la corrección.",
      );
      Object.assign(error, { code: "correction_draft_stale" });
      throw error;
    }
  }
  for (const edit of plan.edits) {
    await applyCorrectionEdit(ctx, datedFacts, edit, today);
  }
}

async function assertOwnershipSplit(
  ctx: StoreContext,
  ownership: { ownership?: Parameters<typeof checkOwnershipSplit>[1] },
): Promise<void> {
  if (!ownership.ownership) return;
  const workspace = await ctx.getWorkspace();
  if (!workspace) throw new Error("Workspace no inicializado.");
  // A correction that repays/reassigns a co-owned home mirrors a known partial
  // split, exactly as the manual ownership command allows.
  const violation = checkOwnershipSplit(workspace, ownership.ownership, {
    allowKnownPartial: true,
  });
  if (violation) throw new Error("El reparto de titularidad no suma 100 %.");
}

async function applyCorrectionEdit(
  ctx: StoreContext,
  datedFacts: DatedFactCommands,
  edit: CorrectionEdit,
  today: string,
): Promise<void> {
  switch (edit.kind) {
    case "debt_rebaseline":
      await datedFacts.addBalanceRebaselineAndRipple(edit.input, { today });
      return;
    case "balance_anchor":
      await datedFacts.addBalanceAnchorAndRipple(edit.input, { today });
      return;
    case "valuation_anchor":
      await datedFacts.addValuationAnchorAndRipple(edit.input, { today });
      return;
    case "debt_model":
      await datedFacts.changeDebtModelAndRipple(edit.liabilityId, edit.debtModel, {
        today,
      });
      return;
    case "liability_cadence":
      await datedFacts.setValuationCadenceAndRipple(edit.liabilityId, edit.cadence, {
        today,
      });
      return;
    case "housing_cadence":
      await datedFacts.setHousingValuationCadenceAndRipple(edit.assetId, edit.cadence, {
        today,
      });
      return;
    case "amortization_plan":
      await datedFacts.updateAmortizationPlanAndRipple(edit.planId, edit.input, {
        liabilityId: edit.liabilityId,
        today,
      });
      return;
    case "liability_config":
      await assertOwnershipSplit(ctx, edit.patch);
      await datedFacts.updateLiabilityAndRippleOwnership(edit.liabilityId, edit.patch, {
        today,
      });
      return;
    case "asset_config":
      await assertOwnershipSplit(ctx, edit.patch);
      await datedFacts.updateAssetAndRippleOwnership(edit.assetId, edit.patch, { today });
      return;
    case "investment_operations":
      await datedFacts.recordOperationsAndRipple({
        assetId: edit.assetId,
        creates: edit.creates,
        deletes: edit.deletes,
        overwrites: edit.overwrites,
        today,
      });
      return;
  }
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
    liabilityReads,
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
    if (!result.ok) throwCommandResultError(result);
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
      applyDraftAssistantProposal(
        ctx,
        assistantProposals,
        proposalId,
        (proposal) => {
          if (!proposal)
            throw new Error(`Assistant proposal "${proposalId}" was not found.`);
          if (proposal.kind !== "statement_import") {
            throw new Error(
              `Assistant proposal "${proposalId}" has an unsupported kind.`,
            );
          }
          return proposal;
        },
        () =>
          datedFacts.applyStatementImportAndRipple({ ...params, trigger: "assistant" }),
      ),
    applyAssistantMixedProposal: async ({ proposalId, ...params }) =>
      applyDraftAssistantProposal(
        ctx,
        assistantProposals,
        proposalId,
        (proposal) => {
          if (!proposal || proposal.kind !== "mixed_document_import") {
            throw new Error(`Assistant proposal "${proposalId}" is not a mixed import.`);
          }
          return proposal;
        },
        () =>
          datedFacts.applyStatementImportAndRipple({ ...params, trigger: "assistant" }),
      ),
    applyAssistantReconcileProposal: async ({ proposalId, ...params }) =>
      applyDraftAssistantProposal(
        ctx,
        assistantProposals,
        proposalId,
        (proposal) => {
          if (!proposal || proposal.kind !== "reconcile") {
            throw new Error(`Assistant proposal "${proposalId}" is not a reconcile.`);
          }
          return proposal;
        },
        () =>
          datedFacts.applyStatementImportAndRipple({ ...params, trigger: "assistant" }),
      ),
    applyAssistantBalanceHistoryProposal: async ({
      proposalId,
      liabilityId,
      rebaselines,
      today,
    }) =>
      applyDraftAssistantProposal(
        ctx,
        assistantProposals,
        proposalId,
        (proposal) => {
          if (!proposal || proposal.kind !== "balance_history_import") {
            throw new Error(`Assistant proposal "${proposalId}" is not a debt history.`);
          }
          return proposal;
        },
        () =>
          importBalanceHistory(
            { liabilityId, rebaselines, ...(today === undefined ? {} : { today }) },
            { trigger: "assistant" },
          ),
      ),
    applyAssistantPropertyValuationProposal: async ({ proposalId, anchor, today }) =>
      applyDraftAssistantProposal(
        ctx,
        assistantProposals,
        proposalId,
        (proposal) => {
          if (!proposal || proposal.kind !== "property_valuation_anchor") {
            throw new Error(
              `Assistant proposal "${proposalId}" is not a property valuation.`,
            );
          }
          return proposal;
        },
        () => datedFacts.addValuationAnchorAndRipple(anchor, { today }),
      ),
    applyAssistantCorrectionProposal: async ({ proposalId, today, reconstruct }) =>
      applyDraftAssistantProposal(
        ctx,
        assistantProposals,
        proposalId,
        (proposal) => {
          if (!proposal || proposal.kind !== "correction") {
            throw new Error(`Assistant proposal "${proposalId}" is not a correction.`);
          }
          return proposal;
        },
        async () => {
          // Reconstruct depth (#1053): apply the re-projected series as ONE atomic
          // batch with ONE ripple from the oldest date. The confirm already
          // revalidated the endpoint against live data (the series must reconcile
          // to the current anchor), so a stale draft never reaches here.
          if (reconstruct) {
            await importBalanceHistory(
              {
                liabilityId: reconstruct.liabilityId,
                rebaselines: reconstruct.rebaselines,
                today,
              },
              { trigger: "assistant" },
            );
            return;
          }
          const proposal = await assistantProposals.read(proposalId);
          if (!proposal) throw new Error(`Assistant proposal "${proposalId}" vanished.`);
          await applyCorrectionPlan(
            ctx,
            datedFacts,
            liabilityReads,
            correctionPlanOf(proposal),
            today,
          );
        },
      ),
    applyStatementImport: (params) =>
      datedFacts.applyStatementImportAndRipple({ ...params, trigger: "statement" }),
    applyStoredContributionValue: datedFacts.applyStoredContributionValue,
    backfillHistoricalSnapshots: snapshotOrchestrator.backfillHistoricalSnapshots,
    changeDebtModel: datedFacts.changeDebtModelAndRipple,
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
    runSyncJob: connectedSources.runSyncJob,
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
