"use server";

import { parseEarlyRepaymentProposalDraft } from "./early-repayment-proposal-contract";
import {
  earlyRepaymentPlanFromProposal,
  projectEarlyRepaymentProposal,
} from "./early-repayment-proposals";
import { runProposalConfirm, runProposalDiscard } from "./proposal-action";

/**
 * Confirm an early-repayment proposal (#1245). The web layer hands the command
 * only the proposal id: the amount, date and mode that reach the engine are read
 * from the persisted fact, so what gets written is exactly what the preview
 * showed. Before that, the draft is re-projected against the LIVE schedule — a
 * repayment registered by hand in the meantime, or a debt that stopped being
 * amortizable, fails honestly with nothing persisted.
 */
export async function confirmEarlyRepaymentProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  return runProposalConfirm({
    rawDraft,
    testArgs: _testArgs,
    kind: "early_repayment",
    parse: (raw) => {
      const parsed = parseEarlyRepaymentProposalDraft(raw);
      return parsed.ok
        ? { ok: true, proposalId: parsed.draft.proposalId, data: undefined }
        : { ok: false, message: parsed.error };
    },
    apply: async ({ store, proposal, today }) => {
      const plan = earlyRepaymentPlanFromProposal(proposal);
      if (!plan) {
        return {
          status: "error",
          message: "La propuesta no contiene una anticipada inequívoca.",
        };
      }
      const projected = await projectEarlyRepaymentProposal(
        store,
        {
          amountMinor: plan.amountMinor,
          liabilityId: plan.liabilityId,
          mode: plan.mode,
          repaymentDate: plan.repaymentDate,
        },
        today,
      );
      if (!projected.ok) return { status: "error", message: projected.error };
      try {
        await store.command.applyAssistantProposal({
          kind: "early_repayment",
          proposalId: proposal.id,
          today,
        });
      } catch (error) {
        // A stale draft or a domain violation rolls the whole apply back.
        return {
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "No se pudo registrar la amortización anticipada.",
        };
      }
      return { status: "applied" };
    },
  });
}

export async function discardEarlyRepaymentProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  return runProposalDiscard({
    rawDraft,
    testArgs: _testArgs,
    kind: "early_repayment",
    parse: (raw) => {
      const parsed = parseEarlyRepaymentProposalDraft(raw);
      return parsed.ok
        ? { ok: true, proposalId: parsed.draft.proposalId, data: undefined }
        : { ok: false, message: parsed.error };
    },
  });
}
