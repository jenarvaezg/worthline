import type { AssetStore } from "@db/asset-store";
import type {
  AssistantProposal,
  AssistantProposalStore,
} from "@db/assistant-proposal-store";
import type { ConnectedSourceSeams } from "@db/connected-source-seams";
import type { CorrectionEdit, CorrectionPlan } from "@db/correction-plan";
import type { EarlyRepaymentPlan } from "@db/early-repayment-plan";
import type { InvestmentOperationPlan } from "@db/investment-operation-plan";
import type { AddBalanceRebaselineInput, LiabilityStore } from "@db/liability-store";
import type { OperationsStore } from "@db/operations-store";
import type { SnapshotOrchestrator } from "@db/snapshot-orchestrator";
import type { SnapshotStore } from "@db/snapshot-store";
import type { StoreContext } from "@db/store-context";
import {
  checkOwnershipSplit,
  detectValueOnlyOpening,
  resolveInstrumentIdentityFill,
  valueOnlySymbolGuardMessage,
} from "@worthline/domain";
import type { DatedFactCommandImplementations } from "./command-implementation-types";
import type { ImportBalanceHistoryCommand } from "./import-balance-history";
import { executeImportBalanceHistoryCommand } from "./import-balance-history";
import {
  rippleHistoricalSnapshotsForDebt,
  throwCommandResultError,
} from "./ripple-engine";
import type { FactBatchInput } from "./types";
import { createUnitOfWork } from "./unit-of-work";

type DatedFactCommands = DatedFactCommandImplementations;
type StatementImportCommand = Omit<
  Parameters<DatedFactCommands["applyStatementImportAndRipple"]>[0],
  "trigger"
>;

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
  deleteInvestmentOperation: "deleteOperationAndRipple",
  deleteInvestmentOperations: "deleteOperationsAndRipple",
  addValuationAnchor: "addValuationAnchorAndRipple",
  updateValuationAnchor: "updateValuationAnchorAndRipple",
  deleteValuationAnchor: "deleteValuationAnchorAndRipple",
  setAnnualAppreciationRate: "setAnnualAppreciationRateAndRipple",
  setHousingValuationCadence: "setHousingValuationCadenceAndRipple",
  recordHousingValuation: "recordHousingValuationAndRipple",
  updateAssetOwnership: "updateAssetAndRippleOwnership",
  updateLiabilityOwnership: "updateLiabilityAndRippleOwnership",
  createHousingHolding: "createHousingHoldingAndRipple",
  createAmortizationPlan: "createAmortizationPlanAndRipple",
  updateAmortizationPlan: "updateAmortizationPlanAndRipple",
  deleteAmortizationPlan: "deleteAmortizationPlanAndRipple",
  addInterestRateRevision: "addInterestRateRevisionAndRipple",
  setLiabilityValuationCadence: "setValuationCadenceAndRipple",
  updateInterestRateRevision: "updateInterestRateRevisionAndRipple",
  deleteInterestRateRevision: "deleteInterestRateRevisionAndRipple",
  addEarlyRepayment: "addEarlyRepaymentAndRipple",
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
  /**
   * Apply one investment-operation proposal (#1374) and resolve it in the SAME
   * transaction. The write is reconstructed from the persisted fact, never from the
   * caller — like the early repayment and unlike the reconcile, whose curated batch
   * legitimately comes from the card: here there is nothing for the user to curate,
   * so the terms that reach the engine are exactly the ones the preview showed. It
   * routes through the proven statement-import ripple as a single `matched` fund,
   * the same path a reconcile row takes, and stamps `source: "agent"`.
   */
  applyAssistantOperationProposal: (params: {
    proposalId: string;
    today: string;
  }) => Promise<void>;
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
    reconstruct?: {
      liabilityId: string;
      rebaselines: AddBalanceRebaselineInput[];
      /**
       * The endpoint of the accepted curve today (#1422). Present only when it
       * differs from the stored `current_balance_minor`: applying a document the
       * user confirmed must not leave the hand-typed anchor contradicting it.
       */
      redeclaredBalanceMinor?: number;
    };
  }) => Promise<void>;
  /**
   * Apply one early-repayment proposal (#1245) and resolve it in the SAME
   * transaction. The write is reconstructed from the persisted fact, never from
   * the caller: the web action passes only the proposal id, so the amount, date
   * and mode that reach the engine are exactly the ones the user confirmed in the
   * preview. `source: "agent"` is stamped here.
   */
  applyAssistantEarlyRepaymentProposal: (params: {
    proposalId: string;
    today: string;
  }) => Promise<void>;
  importBalanceHistory: (command: ImportBalanceHistoryCommand) => Promise<number>;

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
    "addBalanceRebaseline" | "updateLiabilityBalance"
  >;
  /** Read seam for the correction apply's live-data revalidation (#1051). */
  liabilityReads: Pick<LiabilityStore, "debtBalanceAtDate">;
  /**
   * Read + write seams for the identity fill a correction can carry (#1349). The
   * reads are the re-resolution against live data — the portfolio for the identity
   * rule, the ledger for the #1329 guard; `clearPriceCache` is the third reason the
   * operations store rides along, since a new symbol must not be priced from the
   * cache row the old configuration left behind.
   */
  investmentIdentity: Pick<
    AssetStore,
    "readInvestmentAssetsWithMeta" | "patchInvestmentIdentity"
  > &
    Pick<OperationsStore, "clearPriceCache" | "readOperations">;
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

/** Extract the single early-repayment plan an `early_repayment` proposal carries. */
function earlyRepaymentPlanOf(proposal: AssistantProposal): EarlyRepaymentPlan {
  const fact = proposal.documents
    .flatMap((document) => document.facts)
    .find((item) => item.kind === "debt_early_repayment");
  if (!fact || fact.kind !== "debt_early_repayment") {
    throw new Error(
      `Early-repayment proposal "${proposal.id}" carries no repayment plan.`,
    );
  }
  return fact.row;
}

/** Extract the single operation plan an `investment_operation` proposal carries. */
function investmentOperationPlanOf(proposal: AssistantProposal): InvestmentOperationPlan {
  const facts = proposal.documents
    .flatMap((document) => document.facts)
    .filter((item) => item.kind === "investment_operation");
  const [fact] = facts;
  // Exactly one, not «the first one»: this lane exists because a single dated fact
  // was being pushed through a batch tool (#1374), so a draft that somehow carries
  // two operations is a bug to surface, never half a write to apply.
  if (facts.length !== 1 || !fact || fact.kind !== "investment_operation") {
    throw new Error(
      `Investment-operation proposal "${proposal.id}" carries no single operation plan.`,
    );
  }
  return fact.row;
}

/**
 * The staleness guard both debt-side proposals share (#1051/#1245): the live
 * balance at the frozen `asOf` must still be what the draft was armed against.
 * `asOf` is frozen at draft time, so confirming a day later is fine — only a fact
 * that MOVED the curve in between fails, which is exactly the case where the
 * previewed arithmetic no longer describes what would be written.
 */
async function assertLiveBalanceUnchanged(
  liabilityReads: Pick<LiabilityStore, "debtBalanceAtDate">,
  revalidation: { liabilityId: string; asOf: string; expectedBalanceMinor: number },
): Promise<void> {
  const live = await liabilityReads.debtBalanceAtDate(
    revalidation.liabilityId,
    revalidation.asOf,
  );
  if (live === revalidation.expectedBalanceMinor) return;
  const error = new Error(
    "El holding cambió desde que se preparó la propuesta. Vuelve a pedirla con los datos de ahora.",
  );
  Object.assign(error, { code: "correction_draft_stale" });
  throw error;
}

/**
 * Apply one correction plan (#1051) inside the caller's transaction: revalidate
 * against live data first (a stale draft fails honestly and nothing persists),
 * validate any ownership split at the trust boundary, then dispatch each edit to
 * the already-shipped #997 write commands with the `"assistant"` provenance. The
 * radius is one holding, save for the atomic debt↔asset pair an ownership fix
 * carries as two edits in the same transaction.
 */
/**
 * The collaborators one correction edit can need. Grouped rather than threaded
 * positionally: the loop already carries three, and every new edit kind that needs
 * a seam would add another parameter to both functions below.
 */
interface CorrectionApplySeams {
  datedFacts: DatedFactCommands;
  liabilityReads: Pick<LiabilityStore, "debtBalanceAtDate">;
  investmentIdentity: InternalCommandHostDependencies["investmentIdentity"];
}

async function applyCorrectionPlan(
  ctx: StoreContext,
  seams: CorrectionApplySeams,
  plan: CorrectionPlan,
  today: string,
): Promise<void> {
  if (plan.mode !== "anchor-only") {
    // The reconstruct depth is applied through the atomic balance-history import,
    // never this per-edit loop — the caller routes it before reaching here.
    throw new Error(`Correction plan mode "${plan.mode}" is not applied here.`);
  }
  if (plan.revalidation) {
    await assertLiveBalanceUnchanged(seams.liabilityReads, plan.revalidation);
  }
  for (const edit of plan.edits) {
    await applyCorrectionEdit(ctx, seams, edit, today);
  }
}

/**
 * Fill an investment's identity, re-resolved against LIVE data (#1349). The draft
 * carries the declaration, never a decision: between arming the card and
 * confirming it, a sibling proposal or the ficha may have written the very field
 * this edit believes is empty, or given the key to a neighbour. Re-running the
 * pure rule here is what makes «solo rellenar hueco» true at write time instead
 * of at draft time; the throw rolls the whole apply back and the action surfaces
 * the reason.
 */
async function applyInvestmentIdentityFill(
  seams: InternalCommandHostDependencies["investmentIdentity"],
  edit: Extract<CorrectionEdit, { kind: "investment_identity" }>,
): Promise<void> {
  const portfolio = await seams.readInvestmentAssetsWithMeta();
  const target = portfolio.find((holding) => holding.id === edit.assetId);
  if (!target) {
    throw new Error("Esa inversión ya no existe en el workspace.");
  }
  const resolved = resolveInstrumentIdentityFill({
    declaration: edit.declaration,
    portfolio,
    target,
  });
  if (!resolved.ok) throw new Error(resolved.error);

  // The #1329 guard, live too: the ledger CAN become the 1-participación opening
  // between drafting and confirming (an operation deleted on the ficha is enough),
  // and then this write would hand a 574,48 € holding to one share's quote. No
  // figure to quote here — pricing it would be a network call inside the apply —
  // so the message degrades to the honest half the pure module already has.
  if (resolved.patch.providerSymbol !== undefined) {
    const valueOnly = detectValueOnlyOpening(await seams.readOperations(edit.assetId));
    if (valueOnly) {
      throw new Error(
        valueOnlySymbolGuardMessage({
          opening: valueOnly,
          symbol: resolved.patch.providerSymbol,
        }),
      );
    }
  }

  // `priceProvider` is deliberately NOT written: `readInvestmentAssetsWithMeta`
  // derives the default for a NULL column (and it is what feeds the refresh), so
  // stamping it would be an invisible side effect of an identity fill.
  await seams.patchInvestmentIdentity(edit.assetId, resolved.patch);
  // A cache row minted under the previous configuration would price the new
  // symbol from the old figure — the editing surface clears it for the same reason.
  if (resolved.patch.providerSymbol !== undefined) {
    await seams.clearPriceCache(edit.assetId);
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
  seams: CorrectionApplySeams,
  edit: CorrectionEdit,
  today: string,
): Promise<void> {
  const { datedFacts } = seams;
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
    case "investment_identity":
      // No ripple: identity is a mapping route, not a dated fact. The next price
      // refresh is what re-values the holding through the new symbol.
      await applyInvestmentIdentityFill(seams.investmentIdentity, edit);
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
    ...datedFactAliases(datedFacts),
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
    applyAssistantOperationProposal: async ({ proposalId, today }) =>
      applyDraftAssistantProposal(
        ctx,
        assistantProposals,
        proposalId,
        (proposal) => {
          if (!proposal || proposal.kind !== "investment_operation") {
            throw new Error(
              `Assistant proposal "${proposalId}" is not an investment operation.`,
            );
          }
          return proposal;
        },
        async () => {
          const proposal = await assistantProposals.read(proposalId);
          if (!proposal) throw new Error(`Assistant proposal "${proposalId}" vanished.`);
          const plan = investmentOperationPlanOf(proposal);
          await datedFacts.applyStatementImportAndRipple({
            funds: [
              {
                assetId: plan.assetId,
                creates: [
                  {
                    assetId: plan.assetId,
                    currency: plan.currency,
                    executedAt: plan.executedAt,
                    id: ctx.newId(),
                    kind: plan.kind,
                    pricePerUnit: plan.pricePerUnit,
                    source: "agent",
                    units: plan.units,
                    // A printed zero is «sin comisión», which is already the
                    // domain's default: carry nothing rather than a fact that
                    // changes nothing (the alta's rule, #1315).
                    ...(plan.feesMinor !== undefined && plan.feesMinor > 0
                      ? { feesMinor: plan.feesMinor }
                      : {}),
                  },
                ],
                deletes: [],
                kind: "matched",
                overwrites: [],
              },
            ],
            today,
            trigger: "assistant",
          });
        },
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
    applyAssistantEarlyRepaymentProposal: async ({ proposalId, today }) =>
      applyDraftAssistantProposal(
        ctx,
        assistantProposals,
        proposalId,
        (proposal) => {
          if (!proposal || proposal.kind !== "early_repayment") {
            throw new Error(
              `Assistant proposal "${proposalId}" is not an early repayment.`,
            );
          }
          return proposal;
        },
        async () => {
          const proposal = await assistantProposals.read(proposalId);
          if (!proposal) throw new Error(`Assistant proposal "${proposalId}" vanished.`);
          const plan = earlyRepaymentPlanOf(proposal);
          await assertLiveBalanceUnchanged(liabilityReads, {
            ...plan.revalidation,
            liabilityId: plan.liabilityId,
          });
          // The dated-fact seam writes the repayment and ripples from its own
          // cuota boundary, so the history BEFORE it is left verbatim.
          await datedFacts.addEarlyRepaymentAndRipple(
            {
              amountMinor: plan.amountMinor,
              id: ctx.newId(),
              mode: plan.mode,
              planId: plan.planId,
              repaymentDate: plan.repaymentDate,
              source: "agent",
            },
            { liabilityId: plan.liabilityId, today },
          );
        },
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
          // re-projected the series against live data, and (#1422) may have
          // re-derived the declared balance from that curve — same transaction, so
          // the anchor and the re-baselines that justify it never diverge.
          if (reconstruct) {
            // El saldo va PRIMERO, y el import después: el import ripplea desde la
            // fecha más antigua, y las fechas anteriores al primer re-baseline se
            // valoran con el saldo guardado. Al revés, ese ripple congelaría en los
            // snapshots el ancla vieja que esta misma llamada viene a corregir.
            if (reconstruct.redeclaredBalanceMinor !== undefined) {
              await factPersistence.updateLiabilityBalance(
                reconstruct.liabilityId,
                reconstruct.redeclaredBalanceMinor,
              );
            }
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
            { datedFacts, investmentIdentity, liabilityReads },
            correctionPlanOf(proposal),
            today,
          );
        },
      ),
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
