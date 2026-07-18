"use server";

import { createStableId } from "@web/intake";
import { parseBalanceHistoryRows } from "@web/patrimonio/import-balance-history";
import type { WorthlineStore } from "@web/store";
import type { AssistantProposal } from "@worthline/db";

import { projectBalanceHistoryProposal } from "./balance-history-proposals";
import { parseCorrectionProposalDraft } from "./correction-proposal-contract";
import {
  PROPOSAL_UNRECOGNIZED_MESSAGE,
  type ProposalApplyResult,
  runProposalConfirm,
  runProposalDiscard,
} from "./proposal-action";

/** The single correction plan a `correction` proposal carries. */
function correctionPlanOf(proposal: AssistantProposal) {
  const fact = proposal.documents
    .flatMap((document) => document.facts)
    .find((item) => item.kind === "holding_correction");
  return fact && fact.kind === "holding_correction" ? fact.row : null;
}

/**
 * The edited reconstruct series a superficie-C card may re-send at confirm — a
 * plain array of `{ date, balanceMinor }` rows the user kept (excluded points
 * dropped, edited amounts overridden). Detected among the varargs so the S3
 * anchor-only call site `confirmCorrectionProposalAction(draft, store, clock)`
 * keeps working unchanged (a store/clock is an object, never this array shape).
 */
function editedRowsFromArgs(args: unknown[]): unknown[] | undefined {
  return args.find(
    (arg): arg is unknown[] =>
      Array.isArray(arg) &&
      arg.every(
        (row) =>
          row !== null &&
          typeof row === "object" &&
          typeof (row as { date?: unknown }).date === "string" &&
          typeof (row as { balanceMinor?: unknown }).balanceMinor === "number",
      ),
  );
}

export async function confirmCorrectionProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  const editedRows = editedRowsFromArgs(_testArgs);
  return runProposalConfirm({
    rawDraft,
    testArgs: _testArgs,
    kind: "correction",
    parse: (raw) => {
      const draft = parseCorrectionProposalDraft(raw);
      return draft
        ? { ok: true, proposalId: draft.proposalId, data: undefined }
        : { ok: false, message: PROPOSAL_UNRECOGNIZED_MESSAGE };
    },
    apply: async ({ store, proposal, today }) => {
      const plan = correctionPlanOf(proposal);
      try {
        if (plan?.mode === "reconstruct") {
          return await applyReconstruction(store, proposal.id, plan, editedRows, today);
        }
        await store.command.applyAssistantCorrectionProposal({
          proposalId: proposal.id,
          today,
        });
      } catch (error) {
        // A stale draft (live data moved since drafting) or a domain violation
        // rolls the whole apply back; surface it honestly, nothing persisted.
        return {
          status: "error",
          message:
            error instanceof Error ? error.message : "No se pudo aplicar la corrección.",
        };
      }
      return { status: "applied" };
    },
  });
}

/**
 * Confirm the reconstruct depth (#1053): re-project the kept series against LIVE
 * data (the revalidation), reject unless the endpoint reconciles to the anchor,
 * then apply the chain as ONE atomic batch. Edited rows from the card override
 * the persisted series; the persisted plan's before-values stay for audit.
 */
async function applyReconstruction(
  store: WorthlineStore,
  proposalId: string,
  plan: { liabilityId: string; observations: unknown },
  editedRows: unknown[] | undefined,
  today: string,
): Promise<ProposalApplyResult> {
  const parsed = parseBalanceHistoryRows(editedRows ?? plan.observations);
  if (!parsed.ok) return { message: parsed.error, status: "error" };
  const projected = await projectBalanceHistoryProposal(
    store,
    plan.liabilityId,
    parsed.rows,
    today,
  );
  if (!projected.ok) return { message: projected.error, status: "error" };
  if (!projected.reconciliation.matches) {
    return {
      message: "La serie ya no reconcilia con el saldo conocido de la deuda.",
      status: "error",
    };
  }
  await store.command.applyAssistantCorrectionProposal({
    proposalId,
    reconstruct: {
      liabilityId: plan.liabilityId,
      rebaselines: projected.plan.composed.map((row) => ({
        ...row,
        id: createStableId("rebaseline", `${plan.liabilityId}_${row.baselineDate}`, 0),
        liabilityId: plan.liabilityId,
        source: "agent" as const,
        startsAtBaseline: false,
      })),
    },
    today,
  });
  return { status: "applied" };
}

export async function discardCorrectionProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  return runProposalDiscard({
    rawDraft,
    testArgs: _testArgs,
    kind: "correction",
    parse: (raw) => {
      const draft = parseCorrectionProposalDraft(raw);
      return draft
        ? { ok: true, proposalId: draft.proposalId, data: undefined }
        : { ok: false, message: PROPOSAL_UNRECOGNIZED_MESSAGE };
    },
  });
}
