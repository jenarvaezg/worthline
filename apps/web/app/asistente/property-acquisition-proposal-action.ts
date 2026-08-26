"use server";

import { parsePropertyAcquisitionProposalDraft } from "./property-acquisition-proposal-contract";
import {
  acquisitionFromProposal,
  parsePropertyAcquisitionInput,
  projectPropertyAcquisitionProposal,
} from "./property-acquisition-proposals";
import { runProposalConfirm, runProposalDiscard } from "./proposal-action";

/**
 * Confirm a property-acquisition proposal (#1563).
 *
 * The web layer hands the command only the proposal id plus the anchor the LIVE
 * store says is the acquisition: the date and the price that reach the engine are
 * read back from the persisted fact, so what gets written is exactly what the
 * preview showed. Before that, the draft is re-projected — a property that stopped
 * having an acquisition anchor, or one whose date is now occupied by a tasación
 * somebody added meanwhile, fails honestly with nothing persisted.
 *
 * The write itself is the deterministic route the ficha uses (#1437): the assistant
 * proposes, the command writes and ripples. That is the whole shape the frontier of
 * #1248 asks for — the model never touches a snapshot.
 */
export async function confirmPropertyAcquisitionProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  return runProposalConfirm({
    rawDraft,
    testArgs: _testArgs,
    kind: "property_acquisition",
    parse: (raw) => {
      const parsed = parsePropertyAcquisitionProposalDraft(raw);
      return parsed.ok
        ? { ok: true, proposalId: parsed.draft.proposalId, data: undefined }
        : { ok: false, message: parsed.error };
    },
    apply: async ({ store, proposal, today }) => {
      const fact = acquisitionFromProposal(proposal);
      if (!fact) {
        return {
          status: "error",
          message: "La propuesta no contiene una adquisición inequívoca.",
        };
      }
      // Re-validated, not trusted: the fact was written by this app, but `today`
      // has moved since, and a date that was in the past then still has to be now.
      const validated = parsePropertyAcquisitionInput(
        {
          acquisitionDate: fact.valuationDate,
          acquisitionValueMinor: fact.valueMinor,
          assetId: fact.assetId,
        },
        today,
      );
      if (!validated.ok) return { status: "error", message: validated.error };
      const projected = await projectPropertyAcquisitionProposal(
        store,
        validated.row,
        today,
      );
      if (!projected.ok) return { status: "error", message: projected.error };
      try {
        await store.command.applyAssistantProposal({
          kind: "property_acquisition",
          anchor: {
            id: projected.anchor.id,
            valuationDate: validated.row.valuationDate,
            valueMinor: validated.row.valueMinor,
          },
          proposalId: proposal.id,
          today,
        });
      } catch (error) {
        // A stale draft or a refused write rolls the whole apply back.
        return {
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "No se pudo mover la fecha de adquisición.",
        };
      }
      return { status: "applied" };
    },
  });
}

export async function discardPropertyAcquisitionProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  return runProposalDiscard({
    rawDraft,
    testArgs: _testArgs,
    kind: "property_acquisition",
    parse: (raw) => {
      const parsed = parsePropertyAcquisitionProposalDraft(raw);
      return parsed.ok
        ? { ok: true, proposalId: parsed.draft.proposalId, data: undefined }
        : { ok: false, message: parsed.error };
    },
  });
}
