"use server";

import type { AssistantProposal } from "@worthline/db";

import { parseHoldingCreationProposalDraft } from "./holding-creation-proposal-contract";
import { persistHoldingCreation } from "./persist-holding-creation";
import {
  PROPOSAL_UNRECOGNIZED_MESSAGE,
  runProposalConfirm,
  runProposalDiscard,
} from "./proposal-action";

/** The single alta plan a `holding_creation` proposal carries. */
function holdingCreationPlanOf(proposal: AssistantProposal) {
  const fact = proposal.documents
    .flatMap((document) => document.facts)
    .find((item) => item.kind === "holding_creation");
  return fact && fact.kind === "holding_creation" ? fact.row : null;
}

export async function confirmHoldingCreationProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  return runProposalConfirm({
    rawDraft,
    testArgs: _testArgs,
    kind: "holding_creation",
    parse: (raw) => {
      const draft = parseHoldingCreationProposalDraft(raw);
      return draft
        ? { ok: true, proposalId: draft.proposalId, data: undefined }
        : { ok: false, message: PROPOSAL_UNRECOGNIZED_MESSAGE };
    },
    apply: async ({ store, proposal, today }) => {
      const plan = holdingCreationPlanOf(proposal);
      if (!plan) return { status: "error", message: "La propuesta no contiene un alta." };

      // Persist-then-mark. The write and the resolution are two seams, so a crash
      // between them would leave the holding created but the proposal still draft
      // (a re-confirm would then create a duplicate — the informative duplicate
      // warning is the mitigation, not a lock). We accept this small window rather
      // than thread the resolution through the create seam's transaction.
      const persisted = await persistHoldingCreation(store, plan, Date.now(), today);
      if (!persisted.ok) return { status: "error", message: persisted.error };
      await store.assistantProposals.markApplied(proposal.id);
      return { status: "applied" };
    },
  });
}

export async function discardHoldingCreationProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  return runProposalDiscard({
    rawDraft,
    testArgs: _testArgs,
    kind: "holding_creation",
    parse: (raw) => {
      const draft = parseHoldingCreationProposalDraft(raw);
      return draft
        ? { ok: true, proposalId: draft.proposalId, data: undefined }
        : { ok: false, message: PROPOSAL_UNRECOGNIZED_MESSAGE };
    },
  });
}
