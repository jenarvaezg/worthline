"use server";

import { parseOperationProposalDraft } from "./operation-proposal-contract";
import {
  operationPlanFromProposal,
  operationWriteFromPlan,
  projectOperationWrite,
} from "./operation-proposals";
import { runProposalConfirm, runProposalDiscard } from "./proposal-action";

/**
 * Confirm an operation proposal (#1374). The web layer hands the command only the
 * proposal id: the date, the participaciones, the price and the commission that reach
 * the engine are read from the persisted fact, so what gets written is exactly what
 * the preview showed — and there is nothing for the card to curate, unlike the
 * reconcile's batch.
 *
 * Before that, the draft is re-projected against LIVE data: a holding connected to a
 * source in the meantime, a position that can no longer take the sale, or the same
 * operation registered by hand since the draft was armed all fail honestly with
 * nothing persisted.
 */
export async function confirmOperationProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  return runProposalConfirm({
    rawDraft,
    testArgs: _testArgs,
    kind: "investment_operation",
    parse: (raw) => {
      const parsed = parseOperationProposalDraft(raw);
      return parsed.ok
        ? { ok: true, proposalId: parsed.draft.proposalId, data: undefined }
        : { ok: false, message: parsed.error };
    },
    apply: async ({ store, proposal, today }) => {
      const plan = operationPlanFromProposal(proposal);
      if (!plan) {
        return {
          status: "error",
          message: "La propuesta no contiene una operación inequívoca.",
        };
      }
      const projected = await projectOperationWrite(
        store,
        plan.assetId,
        operationWriteFromPlan(plan),
      );
      if (!projected.ok) return { status: "error", message: projected.error };
      try {
        await store.command.applyAssistantProposal({
          kind: "investment_operation",
          proposalId: proposal.id,
          today,
        });
      } catch (error) {
        // A stale draft or a domain violation rolls the whole apply back.
        return {
          status: "error",
          message:
            error instanceof Error ? error.message : "No se pudo anotar la operación.",
        };
      }
      return { status: "applied" };
    },
  });
}

export async function discardOperationProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  return runProposalDiscard({
    rawDraft,
    testArgs: _testArgs,
    kind: "investment_operation",
    parse: (raw) => {
      const parsed = parseOperationProposalDraft(raw);
      return parsed.ok
        ? { ok: true, proposalId: parsed.draft.proposalId, data: undefined }
        : { ok: false, message: parsed.error };
    },
  });
}
