"use server";

import type { WorthlineStore } from "@web/store";
import type {
  AssistantProposal,
  BatchTrashFailureReason,
  BatchTrashResult,
  HoldingTrashTarget,
} from "@worthline/db";

import { parseHoldingTrashProposalDraft } from "./holding-trash-proposal-contract";
import {
  PROPOSAL_UNRECOGNIZED_MESSAGE,
  runProposalConfirm,
  runProposalDiscard,
} from "./proposal-action";

/** The `{ holdingId, kind }` targets a trash proposal carries, from its facts. */
function targetsOf(proposal: AssistantProposal): HoldingTrashTarget[] {
  return proposal.documents
    .flatMap((document) => document.facts)
    .flatMap((fact) =>
      fact.kind === "holding_trash_action"
        ? [{ holdingId: fact.row.holdingId, kind: fact.row.holdingKind }]
        : [],
    );
}

async function confirmTrashProposal(
  rawDraft: unknown,
  testArgs: unknown[],
  kind: "holding_removal" | "holding_restoration",
  apply: (
    store: WorthlineStore,
    targets: HoldingTrashTarget[],
    now: string,
  ) => Promise<BatchTrashResult>,
) {
  return runProposalConfirm({
    rawDraft,
    testArgs,
    kind,
    parse: (raw) => {
      const draft = parseHoldingTrashProposalDraft(raw);
      return draft
        ? { ok: true, proposalId: draft.proposalId, data: undefined }
        : { ok: false, message: PROPOSAL_UNRECOGNIZED_MESSAGE };
    },
    apply: async ({ store, proposal, now }) => {
      const targets = targetsOf(proposal);
      if (targets.length === 0) {
        return { status: "error", message: "La propuesta no contiene holdings." };
      }
      const result = await apply(store, targets, now);
      if (!result.ok) {
        return { status: "error", message: trashFailureMessage(result) };
      }
      await store.assistantProposals.markApplied(proposal.id);
      return { status: "applied" };
    },
  });
}

/**
 * Map an atomic batch failure to a Spanish, user-facing message.
 *
 * Two of the four reasons are the Papelera's gate (#1549), which the chat's baja
 * goes through like every other writer. It cannot hand the gate an exit: saying
 * «ese valor nunca existió» is a statement about the book that belongs to its
 * owner, from the holding's own ficha — so the message sends him there instead of
 * pretending the chat can decide it.
 */
function trashFailureMessage(result: {
  ok: false;
  reason: BatchTrashFailureReason;
  holdingId: string;
}): string {
  switch (result.reason) {
    case "not_in_trash":
      return "Uno de los holdings ya no está en la papelera; no se ha restaurado nada.";
    case "needs_exit":
      return (
        "Uno de los holdings todavía conserva participaciones: antes de darlo de baja hay " +
        "que decir a dónde fue el dinero (lo vendiste, lo traspasaste, o fue un error de " +
        "registro). Puedes hacerlo desde su ficha. No se ha dado de baja nada."
      );
    case "portfolio_cash":
      return (
        "Uno de los holdings es el efectivo de una cartera gestionada: para quitarlo hay " +
        "que borrar la cartera, y entonces queda como una cuenta normal. No se ha dado de " +
        "baja nada."
      );
    case "not_found":
      return "Uno de los holdings ya no existe; no se ha dado de baja nada.";
  }
}

async function discardTrashProposal(
  rawDraft: unknown,
  testArgs: unknown[],
  kind: "holding_removal" | "holding_restoration",
) {
  return runProposalDiscard({
    rawDraft,
    testArgs,
    kind,
    parse: (raw) => {
      const draft = parseHoldingTrashProposalDraft(raw);
      return draft
        ? { ok: true, proposalId: draft.proposalId, data: undefined }
        : { ok: false, message: PROPOSAL_UNRECOGNIZED_MESSAGE };
    },
  });
}

export async function confirmHoldingRemovalProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  return confirmTrashProposal(
    rawDraft,
    _testArgs,
    "holding_removal",
    (store, targets, now) => store.batchSoftDeleteHoldings(targets, now),
  );
}

export async function discardHoldingRemovalProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  return discardTrashProposal(rawDraft, _testArgs, "holding_removal");
}

export async function confirmHoldingRestorationProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  return confirmTrashProposal(
    rawDraft,
    _testArgs,
    "holding_restoration",
    (store, targets) => store.batchRestoreHoldings(targets),
  );
}

export async function discardHoldingRestorationProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  return discardTrashProposal(rawDraft, _testArgs, "holding_restoration");
}
