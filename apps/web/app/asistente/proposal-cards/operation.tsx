"use client";

import {
  confirmOperationProposalAction,
  discardOperationProposalAction,
} from "@web/asistente/operation-proposal-action";
import type { OperationProposal } from "@web/asistente/operation-proposal-contract";
import { proposalImpactHeader } from "@web/asistente/proposal-impact-header";
import { formatPositionMoney } from "./card-copy";
import type { ProposalCardGate } from "./gate";
import { ProposalMutationStatus } from "./mutation-status";
import { ProposalActions } from "./proposal-actions";
import { useProposalMutation } from "./proposal-mutation";
import { ProposalOutcome } from "./proposal-outcome";

/**
 * The operation card (#1374) — one dated buy/sell/aportación on a position that
 * already exists.
 *
 * Its shape is the fix of the session that opened the issue, where the fact travelled
 * inside a reconcile batch: the document's own text sits on ITS line, the destination
 * holding on another (so a jump of holding is visible before confirming, #1373's
 * rule), the fact is printed term by term exactly as it will be written, and the
 * impact header carries «estimado» because the ripple values the position at today's
 * price — the improvised path promised a «recalibración» that does not exist.
 *
 * Every figure arrives pre-formatted from the server; the client renders strings and
 * never recomputes money, a quantity or a date.
 */
export function OperationProposalCard({
  proposal,
  ...gate
}: ProposalCardGate & { proposal: OperationProposal }) {
  const mutation = useProposalMutation(gate, {
    confirm: () => confirmOperationProposalAction(proposal.draft),
    discard: () => discardOperationProposalAction(proposal.draft),
  });
  const header = proposalImpactHeader(proposal.impact, formatPositionMoney, {
    caption: proposal.impactCaption,
  });
  return (
    <div className="assistantProposal">
      <ProposalMutationStatus pending={mutation.pending} result={mutation.result} />
      <p className="assistantProposalKind">Operación · Hecho fechado</p>
      <strong>{proposal.summary}</strong>
      <p className={header.increases ? "assistantOk" : "assistantError"}>
        {header.totalKnown
          ? `${header.headline} · ${header.deltaLabel}`
          : header.headline}
      </p>
      <ul>
        <li>
          <strong>{proposal.document.line}</strong>
          {/* Which door the fact came through (#1466): a validated justificante, or
              the user's own message read by worthline. */}
          <span>{proposal.document.caption}</span>
          {/* The fact, term by term: what confirm will write on this holding. */}
          <span className="assistantRowMovement">{proposal.document.fact}</span>
          <span>{proposal.holding.destination}</span>
          <span>
            Participaciones {proposal.position.unitsBefore} →{" "}
            {proposal.position.unitsAfter}
          </span>
        </li>
      </ul>
      {proposal.notes.map((note) => (
        <p className="assistantWarning" key={note}>
          {note}
        </p>
      ))}
      <p className="assistantProposalFolio">{proposal.folio}</p>
      <ProposalOutcome applied="Operación anotada." mutation={mutation} />
      <ProposalActions mutation={mutation} />
    </div>
  );
}
