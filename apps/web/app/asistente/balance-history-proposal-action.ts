"use server";

import { createStableId } from "@web/intake";

import { parseBalanceHistoryProposalDraft } from "./balance-history-proposal-contract";
import {
  observationsFromProposal,
  projectBalanceHistoryProposal,
} from "./balance-history-proposals";
import { runProposalConfirm } from "./proposal-action";

export async function confirmBalanceHistoryProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  return runProposalConfirm<{ created: number }>({
    rawDraft,
    testArgs: _testArgs,
    kind: "balance_history_import",
    parse: (raw) => {
      const p = parseBalanceHistoryProposalDraft(raw);
      return p.ok
        ? { ok: true, proposalId: p.draft.proposalId, data: undefined }
        : { ok: false, message: p.error };
    },
    apply: async ({ store, proposal, today }) => {
      const observations = observationsFromProposal(proposal);
      if (!observations) {
        return {
          status: "error",
          message: "La propuesta no contiene una deuda inequívoca.",
        };
      }
      const projected = await projectBalanceHistoryProposal(
        store,
        observations.liabilityId,
        observations.rows,
        today,
      );
      if (!projected.ok) return { status: "error", message: projected.error };
      if (!projected.reconciliation.matches) {
        return {
          status: "error",
          message:
            "La serie ya no reconcilia exactamente con el saldo actual de la deuda.",
        };
      }
      await store.command.applyAssistantBalanceHistoryProposal({
        liabilityId: observations.liabilityId,
        proposalId: proposal.id,
        rebaselines: projected.plan.composed.map((row) => ({
          ...row,
          id: createStableId(
            "rebaseline",
            `${observations.liabilityId}_${row.baselineDate}`,
            0,
          ),
          liabilityId: observations.liabilityId,
          source: "agent" as const,
          startsAtBaseline: false,
        })),
        today,
      });
      return { status: "applied", created: projected.plan.composed.length };
    },
  });
}
