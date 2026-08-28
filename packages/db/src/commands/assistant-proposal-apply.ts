/**
 * ONE gate for applying a drafted assistant proposal (#1591).
 *
 * Every kind of proposal resolves the same way: read the draft, refuse it if it
 * is not the kind the caller asked for or is no longer a draft, run the kind's
 * write, and mark it applied — all inside ONE transaction, so a refused write
 * leaves the draft intact for a retry and never a half-applied proposal.
 *
 * That shape used to be restated as a near-identical method per kind on the
 * command host. Here it is stated once, and each kind is a ROW in
 * `ASSISTANT_PROPOSAL_APPLIERS`: the next kind adds a row, not a method. It is a
 * dispatcher, nothing more — the `trigger: "assistant"` provenance still lands at
 * the dated-fact seam each row calls, where it always did.
 */

import type {
  AssistantProposal,
  AssistantProposalFact,
  AssistantProposalStore,
} from "@db/assistant-proposal-store";
import type { CorrectionPlan } from "@db/correction-plan";
import type { EarlyRepaymentPlan } from "@db/early-repayment-plan";
import type { InvestmentOperationPlan } from "@db/investment-operation-plan";
import type { InvestmentTransferPlan } from "@db/investment-transfer-plan";
import type { AddBalanceRebaselineInput } from "@db/liability-balance-rebaseline-store";
import type { AssistantProposalKind } from "@db/schema";
import type { StoreContext } from "@db/store-context";
import type { LiabilityStore } from "@db/store-types";
import type {
  CorrectionReconstruction,
  InvestmentIdentitySeams,
} from "./assistant-correction-apply";
import {
  applyCorrectionPlan,
  applyCorrectionReconstruction,
  assertLiveBalanceUnchanged,
} from "./assistant-correction-apply";
import type {
  DatedFactCommandImplementations,
  StatementImportCommand,
} from "./command-implementation-types";
import type {
  ImportBalanceHistoryCommand,
  ImportBalanceHistoryResult,
} from "./import-balance-history";
import { throwCommandResultError } from "./ripple-engine";
import type { DebtRippleCounts, FactBatchInput } from "./types";
import { EMPTY_DEBT_RIPPLE_COUNTS } from "./types";

/** Everything the rows below can reach. Assembled once by the command host. */
export interface AssistantProposalApplySeams {
  assistantProposals: AssistantProposalStore;
  ctx: StoreContext;
  datedFacts: DatedFactCommandImplementations;
  /**
   * `updateLiabilityBalance` rides along for the reconstruct depth (#1422): the
   * declared balance is re-derived from the curve the user just accepted, inside
   * the SAME transaction as the re-baselines that made it true.
   */
  factPersistence: Pick<LiabilityStore, "updateLiabilityBalance">;
  /** The command host's atomic balance-history import, batch provenance included. */
  importBalanceHistory: (
    params: ImportBalanceHistoryCommand,
    batch: FactBatchInput,
  ) => Promise<ImportBalanceHistoryResult>;
  investmentIdentity: InvestmentIdentitySeams;
  /** Read seam for the debt-side applies' live-data revalidation (#1051). */
  liabilityReads: Pick<LiabilityStore, "debtBalanceAtDate">;
}

/**
 * One kind's write. It runs inside the gate's transaction, on a draft whose kind
 * has already been checked, so a row is only the write itself: no status guard,
 * no re-read, no `markApplied`. Throwing rolls the whole apply back.
 */
type AssistantProposalApplier<Params, Result> = (
  seams: AssistantProposalApplySeams,
  params: Params,
  proposal: AssistantProposal,
) => Promise<Result>;

/** The walk from a proposal to the facts of ONE kind it carries. */
function factsOf<Kind extends AssistantProposalFact["kind"]>(
  proposal: AssistantProposal,
  kind: Kind,
): Extract<AssistantProposalFact, { kind: Kind }>[] {
  return proposal.documents
    .flatMap((document) => document.facts)
    .filter(
      (fact): fact is Extract<AssistantProposalFact, { kind: Kind }> =>
        fact.kind === kind,
    );
}

/** Extract the single correction plan a `correction` proposal carries. */
function correctionPlanOf(proposal: AssistantProposal): CorrectionPlan {
  const [fact] = factsOf(proposal, "holding_correction");
  if (!fact) {
    throw new Error(`Correction proposal "${proposal.id}" carries no correction plan.`);
  }
  return fact.row;
}

/** Extract the single early-repayment plan an `early_repayment` proposal carries. */
function earlyRepaymentPlanOf(proposal: AssistantProposal): EarlyRepaymentPlan {
  const [fact] = factsOf(proposal, "debt_early_repayment");
  if (!fact) {
    throw new Error(
      `Early-repayment proposal "${proposal.id}" carries no repayment plan.`,
    );
  }
  return fact.row;
}

/** Extract the single operation plan an `investment_operation` proposal carries. */
function investmentOperationPlanOf(proposal: AssistantProposal): InvestmentOperationPlan {
  const facts = factsOf(proposal, "investment_operation");
  const [fact] = facts;
  // Exactly one, not «the first one»: this lane exists because a single dated fact
  // was being pushed through a batch tool (#1374), so a draft that somehow carries
  // two operations is a bug to surface, never half a write to apply.
  if (facts.length !== 1 || !fact) {
    throw new Error(
      `Investment-operation proposal "${proposal.id}" carries no single operation plan.`,
    );
  }
  return fact.row;
}

/** Extract the single traspaso plan an `investment_transfer` proposal carries. */
function investmentTransferPlanOf(proposal: AssistantProposal): InvestmentTransferPlan {
  const facts = factsOf(proposal, "investment_transfer");
  const [fact] = facts;
  // Exactly one, for the same reason as the operation above: a draft carrying two
  // traspasos is a bug to surface, never half a pair to write.
  if (facts.length !== 1 || !fact) {
    throw new Error(
      `Investment-transfer proposal "${proposal.id}" carries no single transfer plan.`,
    );
  }
  return fact.row;
}

/**
 * The write the three document-shaped kinds share: the curated batch the card
 * resolved, through the proven atomic statement-import ripple, stamped
 * `trigger: "assistant"`. Named once and referenced by three rows, because they
 * are the same lane and not three coincidences.
 */
const applyThroughStatementImport: AssistantProposalApplier<
  StatementImportCommand,
  void
> = async (seams, params) => {
  await seams.datedFacts.applyStatementImportAndRipple({
    ...params,
    trigger: "assistant",
  });
};

/**
 * kind → the write that applies it. The three document-shaped kinds share the
 * proven atomic statement-import ripple: their curated batch legitimately comes
 * from the card, so it arrives as params. The rest reconstruct the write from the
 * persisted fact — there is nothing for the user to curate, so what reaches the
 * engine is exactly what the preview showed.
 */
const ASSISTANT_PROPOSAL_APPLIERS = {
  balance_history_import: async (
    seams,
    params: {
      liabilityId: string;
      rebaselines: AddBalanceRebaselineInput[];
      today: string;
    },
  ): Promise<DebtRippleCounts> => {
    const outcome = await seams.importBalanceHistory(
      {
        liabilityId: params.liabilityId,
        rebaselines: params.rebaselines,
        today: params.today,
      },
      { trigger: "assistant" },
    );
    return outcome.snapshots;
  },

  /**
   * Two depths behind one confirmed intent (#1051, #1053): the anchor-only plan is
   * a per-edit loop over the #997 write commands; the reconstruct is the atomic
   * balance-history import. Both live in `assistant-correction-apply.ts`; the row
   * only routes.
   */
  correction: async (
    seams,
    params: { today: string; reconstruct?: CorrectionReconstruction },
    proposal,
  ): Promise<DebtRippleCounts> => {
    const { reconstruct, today } = params;
    if (reconstruct) {
      return applyCorrectionReconstruction(seams, reconstruct, today);
    }
    await applyCorrectionPlan(
      seams.ctx,
      {
        datedFacts: seams.datedFacts,
        investmentIdentity: seams.investmentIdentity,
        liabilityReads: seams.liabilityReads,
      },
      correctionPlanOf(proposal),
      today,
    );
    return EMPTY_DEBT_RIPPLE_COUNTS;
  },

  /**
   * The write is reconstructed from the persisted fact, never from the caller:
   * the web action passes only the proposal id, so the amount, date and mode that
   * reach the engine are exactly the ones the user confirmed in the preview.
   * `source: "agent"` is stamped here.
   */
  early_repayment: async (seams, params: { today: string }, proposal): Promise<void> => {
    const plan = earlyRepaymentPlanOf(proposal);
    await assertLiveBalanceUnchanged(seams.liabilityReads, {
      ...plan.revalidation,
      liabilityId: plan.liabilityId,
    });
    // The dated-fact seam writes the repayment and ripples from its own
    // cuota boundary, so the history BEFORE it is left verbatim.
    await seams.datedFacts.addEarlyRepaymentAndRipple(
      {
        amountMinor: plan.amountMinor,
        id: seams.ctx.newId(),
        mode: plan.mode,
        planId: plan.planId,
        repaymentDate: plan.repaymentDate,
        source: "agent",
      },
      { liabilityId: plan.liabilityId, today: params.today },
    );
  },

  /**
   * Routed through the proven statement-import ripple as a single `matched` fund,
   * the same path a reconcile row takes, and stamped `source: "agent"` (#1374).
   */
  investment_operation: async (
    seams,
    params: { today: string },
    proposal,
  ): Promise<void> => {
    const plan = investmentOperationPlanOf(proposal);
    await seams.datedFacts.applyStatementImportAndRipple({
      funds: [
        {
          assetId: plan.assetId,
          creates: [
            {
              assetId: plan.assetId,
              currency: plan.currency,
              executedAt: plan.executedAt,
              id: seams.ctx.newId(),
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
      today: params.today,
      trigger: "assistant",
    });
  },

  /**
   * The write is reconstructed from the persisted intent — the two holdings, the
   * date, the importe and the two VLs the card showed — and goes through
   * `recordTransferAndRipple`, the ONE gate that mints a pair (#1479). So a traspaso
   * dictated to the chat lands as the very same two rows, tied by the same
   * `transferId`, as one submitted from the screen of #1480.
   *
   * The three ids are minted HERE and not carried in the draft: a proposal can only
   * be applied once (the gate refuses a resolved one, in the same transaction), so
   * idempotency is the draft's status rather than a seeded id.
   *
   * A domain refusal — an importe the position no longer covers, a VL that stopped
   * being positive — THROWS, so the whole apply rolls back and the card says why. The
   * confirm action re-runs the same plan against live data first, which is where a
   * refusal gets its Spanish sentence; this is the backstop underneath it.
   */
  investment_transfer: async (
    seams,
    params: { today: string },
    proposal,
  ): Promise<void> => {
    const plan = investmentTransferPlanOf(proposal);
    const result = await seams.datedFacts.recordTransferAndRipple({
      destinationAssetId: plan.destinationAssetId,
      destinationPricePerUnit: plan.destinationPricePerUnit,
      destinationUnits: plan.destinationUnits,
      executedAt: plan.executedAt,
      inOperationId: seams.ctx.newId(),
      originAssetId: plan.originAssetId,
      originPricePerUnit: plan.originPricePerUnit,
      outOperationId: seams.ctx.newId(),
      portion: plan.portion,
      source: "agent",
      today: params.today,
      transferId: seams.ctx.newId(),
    });
    // The gate answers a bad figure with data, not an exception. Here it has to
    // become one: the pair is the write, so a refusal at this depth must roll the
    // apply back rather than leave the draft marked applied with nothing written.
    if (!result.ok) {
      throwCommandResultError({
        code: result.violations[0]?.code ?? "transfer_refused",
        error: `El traspaso ya no se puede registrar (${result.violations[0]?.code ?? "rechazado"}). Vuelve a pedirlo con los datos de ahora.`,
      });
    }
  },

  /**
   * The multi-domain document (#1104): investments, debt histories and property
   * valuations in ONE batched statement-import ripple.
   */
  mixed_document_import: applyThroughStatementImport,

  /**
   * Its sibling `property_valuation_anchor` ADDS an anchor; this one MOVES the
   * anchor that starts the housing's history (#1563), so it rides
   * `updateValuationAnchorAndRipple` — the very seam the ficha's «Adquisición» form
   * uses (#1437) — and the ripple runs from the earlier of the two dates, which is
   * what puts a 2004 mortgage back in the snapshots.
   *
   * The anchor is resolved by the caller, from a LIVE read of the property's
   * `kind = 'acquisition'` row rather than from an id frozen in the draft: what the
   * user confirmed is «the acquisition of this flat», and that is a thing the store
   * identifies at apply time. A write that touches no row throws, so the draft is
   * never left marked applied over a property whose anchor vanished meanwhile.
   */
  property_acquisition: async (
    seams,
    params: {
      /** The live acquisition anchor and the pair to patch onto it. */
      anchor: { id: string; valuationDate: string; valueMinor: number };
      today: string;
    },
  ): Promise<void> => {
    const changes = await seams.datedFacts.updateValuationAnchorAndRipple(
      params.anchor.id,
      {
        valuationDate: params.anchor.valuationDate,
        valueMinor: params.anchor.valueMinor,
      },
      { today: params.today },
    );
    if (changes === 0) {
      throw new Error(
        "El ancla de adquisición ya no existe: la propuesta no se ha aplicado.",
      );
    }
  },

  property_valuation_anchor: async (
    seams,
    params: {
      anchor: Parameters<
        DatedFactCommandImplementations["addValuationAnchorAndRipple"]
      >[0];
      today: string;
    },
  ): Promise<void> => {
    await seams.datedFacts.addValuationAnchorAndRipple(params.anchor, {
      today: params.today,
    });
  },

  /**
   * The curated batch legitimately comes from the card (PRD #1103 S5, #1108): the
   * web action resolves it into a statement-import `funds` array (created holdings
   * as `new`, matched-with-movements holdings as `matched`) and this runs them
   * through the proven atomic statement-import ripple, so a write that fails midway
   * rolls the whole batch back and the draft survives for a retry.
   */
  reconcile: applyThroughStatementImport,

  statement_import: applyThroughStatementImport,
} satisfies Partial<
  Record<AssistantProposalKind, AssistantProposalApplier<never, unknown>>
>;

type AssistantProposalAppliers = typeof ASSISTANT_PROPOSAL_APPLIERS;

/** The kinds a confirmed proposal can be applied as: the table's rows. */
export type AssistantProposalApplyKind = keyof AssistantProposalAppliers;

/**
 * The same rows, enumerable. The three trash-lane kinds (`holding_creation`,
 * `holding_removal`, `holding_restoration`) are deliberately absent: they resolve
 * their draft from the web action, not through this gate.
 */
export const ASSISTANT_PROPOSAL_APPLY_KINDS = Object.keys(
  ASSISTANT_PROPOSAL_APPLIERS,
) as AssistantProposalApplyKind[];

/** What one kind's apply needs beyond the id, and what it answers with. */
type AssistantProposalApplyParams<Kind extends AssistantProposalApplyKind> = Parameters<
  AssistantProposalAppliers[Kind]
>[1];
type AssistantProposalApplyResult<Kind extends AssistantProposalApplyKind> = Awaited<
  ReturnType<AssistantProposalAppliers[Kind]>
>;

/**
 * The ONE public apply for assistant proposals. The `kind` is what pairs the id
 * with the rest of the call and with what comes back, so a caller cannot pass a
 * reconcile's curated batch under a correction's name.
 */
export type ApplyAssistantProposal = <Kind extends AssistantProposalApplyKind>(
  params: { kind: Kind; proposalId: string } & AssistantProposalApplyParams<Kind>,
) => Promise<AssistantProposalApplyResult<Kind>>;

/**
 * The same table, seen as «kind → some apply». The per-kind pairing lives in the
 * public signature above; the dispatcher itself only needs to find the row, so
 * `never` params (which every row's params accept) is what lets it index the
 * table without restating the ten shapes.
 */
const APPLY_BY_KIND: Record<
  AssistantProposalApplyKind,
  AssistantProposalApplier<never, unknown>
> = ASSISTANT_PROPOSAL_APPLIERS;

export function createApplyAssistantProposal(
  seams: AssistantProposalApplySeams,
): ApplyAssistantProposal {
  const applyProposal = async (
    input: {
      kind: AssistantProposalApplyKind;
      proposalId: string;
    } & Record<string, unknown>,
  ): Promise<unknown> =>
    seams.ctx.transaction(async () => {
      // The two identity fields are the GATE's, not the row's: a row that spreads
      // its params into a write seam must not carry them along.
      const { kind, proposalId, ...params } = input;
      const proposal = await seams.assistantProposals.read(proposalId);
      if (!proposal) {
        throw new Error(`Assistant proposal "${proposalId}" was not found.`);
      }
      if (proposal.kind !== kind) {
        throw new Error(
          `Assistant proposal "${proposalId}" is not a ${kind}: it is a ${proposal.kind}.`,
        );
      }
      if (proposal.status !== "draft") {
        throw new Error(
          `Assistant proposal "${proposalId}" is already resolved as ${proposal.status}.`,
        );
      }
      const value = await APPLY_BY_KIND[kind](seams, params as never, proposal);
      await seams.assistantProposals.markApplied(proposalId);
      return value;
    });

  // The kind→params→result pairing is checked at every call site by
  // `ApplyAssistantProposal`; inside, the dispatcher is deliberately kind-blind.
  return applyProposal as ApplyAssistantProposal;
}
