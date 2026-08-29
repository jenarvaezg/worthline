"use client";

import { proposalImpactHeader } from "@web/asistente/proposal-impact-header";
import {
  confirmTransferProposalAction,
  discardTransferProposalAction,
} from "@web/asistente/transfer-proposal-action";
import type { TransferProposal } from "@web/asistente/transfer-proposal-contract";
import { formatPositionMoney } from "./card-copy";
import type { ProposalCardGate } from "./gate";
import { ProposalMutationStatus } from "./mutation-status";
import { ProposalActions } from "./proposal-actions";
import { useProposalMutation } from "./proposal-mutation";
import { ProposalOutcome } from "./proposal-outcome";

/**
 * The traspaso card (#1482) — ONE movement with two halves, dictated to the chat.
 *
 * Why its shape differs from every other proposal card. What worthline READ in the
 * user's own message goes on its own line and first: the importe and the date were
 * parsed off that message rather than off a document, so that echo is the ceremony —
 * it is where «1.018,67 €» read as «1.018,76 €» gets caught, before two rows and an
 * inherited cost move real capital. Underneath it, each half prints the derived
 * participaciones next to the VL they came from, and each side its position before →
 * after, because the two unit counts are unrelated figures (that is the instrument) and
 * a card that showed only one of them would hide half the write.
 *
 * The impact reads «around zero» by construction and the note says why in words: a
 * traspaso moves capital, realizes no plusvalía and spends no cupo de aportación.
 *
 * Every figure arrives pre-formatted from the server; the client renders strings.
 */
export function TransferProposalCard({
  proposal,
  ...gate
}: ProposalCardGate & { proposal: TransferProposal }) {
  const mutation = useProposalMutation(gate, {
    confirm: () => confirmTransferProposalAction(proposal.draft),
    discard: () => discardTransferProposalAction(proposal.draft),
  });
  const header = proposalImpactHeader(proposal.impact, formatPositionMoney, {
    caption: proposal.impactCaption,
  });
  return (
    <div className="assistantProposal">
      <ProposalMutationStatus pending={mutation.pending} result={mutation.result} />
      <p className="assistantProposalKind">Traspaso · Hecho fechado</p>
      <strong>{proposal.summary}</strong>
      <p className={header.increases ? "assistantOk" : "assistantError"}>
        {header.totalKnown
          ? `${header.headline} · ${header.deltaLabel}`
          : header.headline}
      </p>
      <ul>
        <li>
          {/* What worthline read in the message, before anything derived from it. */}
          <strong>{proposal.dictated}</strong>
          <span>Lo que he leído en tu mensaje</span>
          <span>{proposal.origin.positionLine}</span>
          <span className="assistantRowMovement">{proposal.origin.movementLine}</span>
          <span>{proposal.destination.positionLine}</span>
          <span className="assistantRowMovement">
            {proposal.destination.movementLine}
          </span>
          <span>{proposal.inheritedCost}</span>
        </li>
      </ul>
      {proposal.notes.map((note) => (
        <p className="assistantWarning" key={note}>
          {note}
        </p>
      ))}
      <p className="assistantProposalFolio">{proposal.folio}</p>
      <ProposalOutcome applied="Traspaso anotado." mutation={mutation} />
      <ProposalActions mutation={mutation} />
    </div>
  );
}
