import type { AssistantProposalStore } from "@db/assistant-proposal-store";
import type { ConnectedSourceSeams } from "@db/connected-source-seams";
import type { LiabilityStore } from "@db/liability-store";
import type { SnapshotOrchestrator } from "@db/snapshot-orchestrator";
import type { SnapshotStore } from "@db/snapshot-store";
import type { StoreContext } from "@db/store-context";
import type { InvestmentIdentitySeams } from "./assistant-correction-apply";
import type { ApplyAssistantProposal } from "./assistant-proposal-apply";
import { createApplyAssistantProposal } from "./assistant-proposal-apply";
import type {
  DatedFactCommandImplementations,
  StatementImportCommand,
} from "./command-implementation-types";
import { debtRebaselineChainBand, rippleHistoricalSnapshotsForDebt } from "./debt-band";
import type {
  ImportBalanceHistoryCommand,
  ImportBalanceHistoryResult,
} from "./import-balance-history";
import { executeImportBalanceHistoryCommand } from "./import-balance-history";
import { throwCommandResultError } from "./ripple-engine";
import type { DebtRippleCounts, FactBatchInput } from "./types";
import { EMPTY_DEBT_RIPPLE_COUNTS } from "./types";
import { createUnitOfWork } from "./unit-of-work";

type DatedFactCommands = DatedFactCommandImplementations;

/**
 * The intent→persistence rename boundary (ADR 0062), declared ONCE. Each key is
 * the intent-shaped name the command host exposes; each value the
 * persistence-shaped `…AndRipple` implementation it forwards to. Both the
 * `CommandHost` type (via `DatedFactAliases`) and the runtime host object (via
 * `datedFactAliases`) are derived from this single table, so the boundary is
 * never restated per method.
 */
const DATED_FACT_ALIASES = {
  createAndLinkContributionOperation: "createAndLinkContributionOperation",
  applyStoredContributionValue: "applyStoredContributionValue",
  recordInvestmentOperation: "recordOperationAndRipple",
  mergeInvestmentOperations: "recordOperationsAndRipple",
  recordInvestmentTransfer: "recordTransferAndRipple",
  recordExternalTransferIn: "recordExternalTransferInAndRipple",
  deleteInvestmentTransfer: "deleteTransferAndRipple",
  deleteInvestmentOperation: "deleteOperationAndRipple",
  deleteInvestmentOperations: "deleteOperationsAndRipple",
  addValuationAnchor: "addValuationAnchorAndRipple",
  countValuationRippleSnapshots: "countValuationRippleSnapshots",
  updateValuationAnchor: "updateValuationAnchorAndRipple",
  deleteValuationAnchor: "deleteValuationAnchorAndRipple",
  setAnnualAppreciationRate: "setAnnualAppreciationRateAndRipple",
  setHousingValuationCadence: "setHousingValuationCadenceAndRipple",
  recordHousingValuation: "recordHousingValuationAndRipple",
  updateAssetOwnership: "updateAssetAndRippleOwnership",
  updateLiabilityOwnership: "updateLiabilityAndRippleOwnership",
  createHousingHolding: "createHousingHoldingAndRipple",
  createInvestmentHolding: "createInvestmentHoldingAndRipple",
  createDebtHolding: "createDebtHoldingAndRipple",
  createAmortizationPlan: "createAmortizationPlanAndRipple",
  updateAmortizationPlan: "updateAmortizationPlanAndRipple",
  deleteAmortizationPlan: "deleteAmortizationPlanAndRipple",
  addInterestRateRevision: "addInterestRateRevisionAndRipple",
  setLiabilityValuationCadence: "setValuationCadenceAndRipple",
  updateInterestRateRevision: "updateInterestRateRevisionAndRipple",
  deleteInterestRateRevision: "deleteInterestRateRevisionAndRipple",
  addEarlyRepayment: "addEarlyRepaymentAndRipple",
  importAmortizationSchedule: "importAmortizationScheduleAndRipple",
  updateEarlyRepayment: "updateEarlyRepaymentAndRipple",
  deleteEarlyRepayment: "deleteEarlyRepaymentAndRipple",
  createCurrentStateDebt: "createCurrentStateDebtAndRipple",
  changeDebtModel: "changeDebtModelAndRipple",
  addBalanceRebaseline: "addBalanceRebaselineAndRipple",
  updateBalanceRebaseline: "updateBalanceRebaselineAndRipple",
  deleteBalanceRebaseline: "deleteBalanceRebaselineAndRipple",
  addBalanceAnchor: "addBalanceAnchorAndRipple",
  updateBalanceAnchor: "updateBalanceAnchorAndRipple",
  deleteBalanceAnchor: "deleteBalanceAnchorAndRipple",
  rippleHousingAfterAssetEdit: "rippleHousingAfterAssetEdit",
} as const satisfies Record<string, keyof DatedFactCommands>;

/** The renamed slice of `CommandHost`, derived from the single alias table. */
type DatedFactAliases = {
  [Intent in keyof typeof DATED_FACT_ALIASES]: DatedFactCommands[(typeof DATED_FACT_ALIASES)[Intent]];
};

/** Build the runtime alias slice by forwarding each intent name to its
 *  persistence-shaped implementation, from the same single table. */
function datedFactAliases(datedFacts: DatedFactCommands): DatedFactAliases {
  const aliased: Record<string, unknown> = {};
  for (const [intent, impl] of Object.entries(DATED_FACT_ALIASES)) {
    aliased[intent] = datedFacts[impl as keyof DatedFactCommands];
  }
  return aliased as DatedFactAliases;
}

/**
 * Intent-level command surface. Persist+ripple implementation details stay
 * private. The 1:1 intent→persistence renames live in `DatedFactAliases` (the
 * single `DATED_FACT_ALIASES` table); only the members with real wrapping logic
 * or a different seam are declared here.
 */
export interface CommandHost extends DatedFactAliases {
  applyStatementImport: (params: StatementImportCommand) => Promise<void>;
  /**
   * ONE gate for applying a drafted assistant proposal (#767, #1591). The `kind`
   * picks the write from the single table in `assistant-proposal-apply.ts`, which
   * also decides what else the call takes and what it answers with; the
   * preview-then-confirm ceremony, the refusals and the `trigger: "assistant"`
   * provenance are the same for every kind because they are stated once, there.
   */
  applyAssistantProposal: ApplyAssistantProposal;
  importBalanceHistory: (
    command: ImportBalanceHistoryCommand,
  ) => Promise<ImportBalanceHistoryResult>;

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
  /**
   * `updateLiabilityBalance` rides along for the reconstruct depth (#1422): the
   * declared balance is re-derived from the curve the user just accepted, inside
   * the SAME transaction as the re-baselines that made it true.
   */
  factPersistence: Pick<
    LiabilityStore,
    "addBalanceRebaselines" | "updateLiabilityBalance"
  >;
  /** Read seam for the correction apply's live-data revalidation (#1051). */
  liabilityReads: Pick<LiabilityStore, "debtBalanceAtDate">;
  /** Read + write seams for the identity fill a correction can carry (#1349). */
  investmentIdentity: InvestmentIdentitySeams;
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
    investmentIdentity,
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
  }): Promise<DebtRippleCounts> => {
    const workspace = await ctx.getWorkspace();
    if (!workspace) return EMPTY_DEBT_RIPPLE_COUNTS;
    return rippleHistoricalSnapshotsForDebt(ctx, workspace, snapshots.saveSnapshot, {
      band: debtRebaselineChainBand(fromDateKey),
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
        addBalanceRebaselines: factPersistence.addBalanceRebaselines,
        rippleDebtRebaseline,
        uow,
      },
      params,
      batch,
    );
    if (!result.ok) throwCommandResultError(result);
    return result.value;
  };
  return {
    ...datedFactAliases(datedFacts),
    applyBinanceHistory: connectedSources.applyBinanceHistoryAndRipple,
    applyAssistantProposal: createApplyAssistantProposal({
      assistantProposals,
      ctx,
      datedFacts,
      factPersistence,
      importBalanceHistory,
      investmentIdentity,
      liabilityReads,
    }),
    applyStatementImport: (params) =>
      datedFacts.applyStatementImportAndRipple({ ...params, trigger: "statement" }),
    backfillHistoricalSnapshots: snapshotOrchestrator.backfillHistoricalSnapshots,
    backfillInvestmentPrices: snapshotOrchestrator.backfillInvestmentPricesAndRipple,
    correctInvestmentSnapshotUnitPrice:
      snapshotOrchestrator.correctInvestmentSnapshotUnitPrice,
    importBalanceHistory,
    runSyncJob: connectedSources.runSyncJob,
    syncConnectedSource: connectedSources.syncConnectedSource,
  };
}
