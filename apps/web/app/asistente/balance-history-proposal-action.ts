"use server";

import { createStableId } from "@web/intake";
import type { DebtRippleCounts } from "@worthline/db";

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
  return runProposalConfirm<DebtRippleCounts>({
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
      // El descuadre NO bloquea (#1422). Es la misma puerta que dejaba muerta la
      // tarjeta de reconstrucción, en la lane hermana: la tarjeta enseña el
      // veredicto y sus testigos antes de pulsar, y quien pulsa manda.
      const snapshots = await store.command.applyAssistantBalanceHistoryProposal({
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
      return { status: "applied", ...snapshots };
    },
  });
}
