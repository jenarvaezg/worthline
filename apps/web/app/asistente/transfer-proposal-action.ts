"use server";

import { runProposalConfirm, runProposalDiscard } from "./proposal-action";
import { parseTransferProposalDraft } from "./transfer-proposal-contract";
import {
  projectTransferWrite,
  transferPlanFromProposal,
  transferWriteFromPlan,
} from "./transfer-proposals";

/**
 * Confirm a traspaso proposal (#1482). The web layer hands the command only the
 * proposal id: the date, the importe and the two VL that reach the gate are read from
 * the persisted intent, so what gets written is exactly what the card showed — and the
 * pair itself is minted by `recordTransferAndRipple`, the same gate the screen of #1480
 * submits to (#1479). There is nothing here for the card to curate.
 *
 * Before that, the draft is re-projected against LIVE data: a holding connected to a
 * source in the meantime, a position that can no longer cover the importe, or the same
 * traspaso registered by hand since the card was armed all fail honestly with nothing
 * persisted. That re-projection is where a refusal gets its Spanish sentence; the gate's
 * own violation underneath it is the backstop that rolls the transaction back.
 */
export async function confirmTransferProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  return runProposalConfirm({
    rawDraft,
    testArgs: _testArgs,
    kind: "investment_transfer",
    parse: (raw) => {
      const parsed = parseTransferProposalDraft(raw);
      return parsed.ok
        ? { ok: true, proposalId: parsed.draft.proposalId, data: undefined }
        : { ok: false, message: parsed.error };
    },
    apply: async ({ store, proposal, today }) => {
      const plan = transferPlanFromProposal(proposal);
      if (!plan) {
        return {
          status: "error",
          message: "La propuesta no contiene un traspaso inequívoco.",
        };
      }
      const projected = await projectTransferWrite(store, transferWriteFromPlan(plan));
      if (!projected.ok) return { status: "error", message: projected.error };
      try {
        await store.command.applyAssistantProposal({
          kind: "investment_transfer",
          proposalId: proposal.id,
          today,
        });
      } catch (error) {
        // A stale draft or a domain violation rolls the whole apply back — including
        // the pair, which is the promise this gate exists for: never half a traspaso.
        return {
          status: "error",
          message:
            error instanceof Error ? error.message : "No se pudo anotar el traspaso.",
        };
      }
      return { status: "applied" };
    },
  });
}

export async function discardTransferProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  return runProposalDiscard({
    rawDraft,
    testArgs: _testArgs,
    kind: "investment_transfer",
    parse: (raw) => {
      const parsed = parseTransferProposalDraft(raw);
      return parsed.ok
        ? { ok: true, proposalId: parsed.draft.proposalId, data: undefined }
        : { ok: false, message: parsed.error };
    },
  });
}
