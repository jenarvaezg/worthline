"use client";

import {
  confirmCorrectionProposalAction,
  discardCorrectionProposalAction,
} from "@web/asistente/correction-proposal-action";
import type {
  AnchorOnlyCorrectionProposal,
  CorrectionProposal,
} from "@web/asistente/correction-proposal-contract";
import type { ProposalCardGate } from "./gate";
import { ProposalMutationStatus } from "./mutation-status";
import { ProposalActions } from "./proposal-actions";
import { useProposalMutation } from "./proposal-mutation";
import { ProposalOutcome } from "./proposal-outcome";

/** The guarantee sentence of superficie C «Ancla primero», by gate state. */
function guaranteeMessage(state: CorrectionProposal["guarantee"]["state"]): string {
  switch (state) {
    case "declared":
      return "Hecho declarado por ti — la historia anterior queda intacta.";
    case "reconciled":
      return "Reconciliado con el saldo conocido.";
    case "mismatch":
      return "No cuadra con el saldo conocido — revisa los puntos.";
    case "unverified":
      return "No verificado — revisa cada punto antes de confirmar.";
  }
}

export function CorrectionProposalCard({
  proposal,
  ...gate
}: ProposalCardGate & { proposal: AnchorOnlyCorrectionProposal }) {
  const mutation = useProposalMutation(gate, {
    confirm: () => confirmCorrectionProposalAction(proposal.draft),
    discard: () => discardCorrectionProposalAction(proposal.draft),
  });
  const verified =
    proposal.guarantee.state === "declared" || proposal.guarantee.state === "reconciled";
  return (
    <div className="assistantProposal">
      <ProposalMutationStatus pending={mutation.pending} result={mutation.result} />
      <p className="assistantProposalKind">Corrección · Solo desde hoy</p>
      <strong>{proposal.summary}</strong>
      {/* Superficie C: the guarantee leads; the point-by-point diff follows. */}
      <p className={verified ? "assistantOk" : "assistantError"}>
        {guaranteeMessage(proposal.guarantee.state)}
      </p>
      <ul>
        {proposal.edits.map((edit, index) => (
          <li key={`${edit.label}-${index}`}>
            <span>{edit.label}</span>{" "}
            <span>
              {edit.before} → {edit.after}
            </span>
            <span>
              {edit.origin === "user" ? "Corregido por ti" : "Propuesto por el asistente"}
            </span>
          </li>
        ))}
      </ul>
      <p className="assistantProposalFolio">{proposal.folio}</p>
      <ProposalOutcome applied="Corrección aplicada." mutation={mutation} />
      <ProposalActions confirmDisabled={!verified} mutation={mutation} />
    </div>
  );
}
