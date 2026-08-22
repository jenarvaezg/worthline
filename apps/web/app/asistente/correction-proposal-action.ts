"use server";

import { createStableId } from "@web/intake";
import { parseBalanceHistoryRows } from "@web/patrimonio/import-balance-history";
import type { WorthlineStore } from "@web/store";
import type {
  AssistantProposal,
  DebtRippleCounts,
  ReconstructCorrectionPlan,
} from "@worthline/db";

import { projectBalanceHistoryProposal } from "./balance-history-proposals";
import { parseCorrectionProposalDraft } from "./correction-proposal-contract";
import {
  PROPOSAL_UNRECOGNIZED_MESSAGE,
  type ProposalApplyResult,
  runProposalConfirm,
  runProposalDiscard,
} from "./proposal-action";
import {
  effectiveReconstructionRows,
  normalizeReconstructionAmendments,
} from "./reconstruction-amendment";

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
  return runProposalConfirm<DebtRippleCounts>({
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
        const snapshots = await store.command.applyAssistantCorrectionProposal({
          proposalId: proposal.id,
          today,
        });
        return { status: "applied", ...snapshots };
      } catch (error) {
        // A stale draft (live data moved since drafting) or a domain violation
        // rolls the whole apply back; surface it honestly, nothing persisted.
        return {
          status: "error",
          message:
            error instanceof Error ? error.message : "No se pudo aplicar la corrección.",
        };
      }
    },
  });
}

/**
 * Confirm the reconstruct depth (#1053): re-project the kept series against LIVE
 * data (the revalidation) and apply the chain as ONE atomic batch. Edited rows
 * from the card override the persisted series; the persisted plan's before-values
 * stay for audit.
 *
 * The endpoint no longer gates this (#1422). It used to reject anything that did
 * not equal `current_balance_minor` to the cent — a hand-typed field the engine
 * does not even read for a debt that has a curve — so a correct document from the
 * bank was unappliable, and the card's «edita un punto» escape hatch just moved
 * the same refusal one click later («la serie YA NO reconcilia», blaming the user
 * for a series that never did). Now the mismatch is surfaced on the card BEFORE
 * confirming and applying it re-derives the declared balance from the curve the
 * user accepted, so the anchor stops lying instead of blocking the repair.
 */
async function applyReconstruction(
  store: WorthlineStore,
  proposalId: string,
  plan: ReconstructCorrectionPlan,
  editedRows: unknown[] | undefined,
  today: string,
): Promise<ProposalApplyResult<DebtRippleCounts>> {
  const parsed = parseBalanceHistoryRows(editedRows ?? plan.observations);
  if (!parsed.ok) return { message: parsed.error, status: "error" };
  // Las filas que llegan de la tarjeta ya traen la edición del usuario aplicada
  // (excluidos fuera, importes sobrescritos). Las persistidas son la serie CRUDA,
  // así que las enmiendas del chat (#1423) se aplican aquí — si no, confirmar
  // volvería a meter los puntos que el asistente había quitado por encargo.
  const rows = editedRows
    ? parsed.rows
    : effectiveReconstructionRows(
        parsed.rows,
        normalizeReconstructionAmendments(plan.amendments),
      );
  const projected = await projectBalanceHistoryProposal(
    store,
    plan.liabilityId,
    rows,
    today,
  );
  if (!projected.ok) return { message: projected.error, status: "error" };
  const { anchor, resultingMinor } = projected.reconciliation;
  const snapshots = await store.command.applyAssistantCorrectionProposal({
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
      // El saldo declarado se re-deriva de la curva que el usuario acaba de
      // aceptar (#1422). Dejarlo como estaba es dejar en la base de datos una
      // cifra que el propio documento acaba de desmentir.
      ...(anchor.declaredMinor === resultingMinor
        ? {}
        : { redeclaredBalanceMinor: resultingMinor }),
    },
    today,
  });
  return { status: "applied", ...snapshots };
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
