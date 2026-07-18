"use server";

import { createStableId } from "@web/intake";

import { parsePropertyValuationProposalDraft } from "./property-valuation-proposal-contract";
import {
  parsePropertyValuationAnchorInput,
  projectPropertyValuationProposal,
  valuationAnchorFromProposal,
} from "./property-valuation-proposals";
import { runProposalConfirm, runProposalDiscard } from "./proposal-action";

export async function confirmPropertyValuationProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  return runProposalConfirm({
    rawDraft,
    testArgs: _testArgs,
    kind: "property_valuation_anchor",
    parse: (raw) => {
      const parsed = parsePropertyValuationProposalDraft(raw);
      return parsed.ok
        ? { ok: true, proposalId: parsed.draft.proposalId, data: undefined }
        : { ok: false, message: parsed.error };
    },
    apply: async ({ store, proposal, today }) => {
      const anchor = valuationAnchorFromProposal(proposal);
      if (!anchor)
        return {
          status: "error",
          message: "La propuesta no contiene una valoración inequívoca.",
        };
      const validated = parsePropertyValuationAnchorInput(anchor, today);
      if (!validated.ok) return { status: "error", message: validated.error };
      const projected = await projectPropertyValuationProposal(
        store,
        validated.row.assetId,
        validated.row.valuationDate,
        validated.row.valueMinor,
        today,
      );
      if (!projected.ok) return { status: "error", message: projected.error };
      await store.command.applyAssistantPropertyValuationProposal({
        proposalId: proposal.id,
        today,
        anchor: {
          id: createStableId(
            "valuation_anchor",
            `${validated.row.assetId}_${validated.row.valuationDate}`,
            0,
          ),
          ...validated.row,
          adjustsPriorCurve: true,
          source: "agent",
        },
      });
      return { status: "applied" };
    },
  });
}

export async function discardPropertyValuationProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  return runProposalDiscard({
    rawDraft,
    testArgs: _testArgs,
    kind: "property_valuation_anchor",
    parse: (raw) => {
      const parsed = parsePropertyValuationProposalDraft(raw);
      return parsed.ok
        ? { ok: true, proposalId: parsed.draft.proposalId, data: undefined }
        : { ok: false, message: parsed.error };
    },
  });
}
