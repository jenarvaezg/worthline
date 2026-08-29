"use client";

import type { ProposalCardResult, ProposalMutation } from "./proposal-mutation";

/**
 * The pair of buttons that closes a proposal card (#1617): Confirmar as the card's
 * only primary, Descartar secondary next to it.
 *
 * `confirmDisabled` is the card's OWN extra condition on confirming — the correction
 * asks its guarantee to be verified, the reconcile asks the batch not to be empty,
 * the reconstruction its gate. It is added to the shared one (pending, demo gate,
 * already settled), never replaces it.
 *
 * It paints the PAIR, and the type says so: a mutation with no discard does not fit,
 * so a proposal that cannot be thrown away keeps its own lone button rather than
 * getting a row with a hole in it (the debt balance history, #1617).
 */
export function ProposalActions<Result extends ProposalCardResult>({
  confirmDisabled = false,
  discardLabel = "Descartar",
  mutation,
}: {
  confirmDisabled?: boolean;
  discardLabel?: string;
  mutation: ProposalMutation<Result> & { discard: () => void };
}) {
  const { actionsDisabled, confirm, discard, pending } = mutation;
  return (
    <div className="assistantProposalActions">
      <button
        disabled={actionsDisabled || confirmDisabled}
        onClick={confirm}
        type="button"
      >
        {pending ? "Guardando…" : "Confirmar"}
      </button>
      <button
        className="secondary"
        disabled={actionsDisabled}
        onClick={discard}
        type="button"
      >
        {discardLabel}
      </button>
    </div>
  );
}
