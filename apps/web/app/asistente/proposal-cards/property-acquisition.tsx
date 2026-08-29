"use client";

import { balanceCurvePolyline } from "@web/asistente/balance-curve-polyline";
import {
  confirmPropertyAcquisitionProposalAction,
  discardPropertyAcquisitionProposalAction,
} from "@web/asistente/property-acquisition-proposal-action";
import type { PropertyAcquisitionProposal } from "@web/asistente/property-acquisition-proposal-contract";
import type { ProposalCardGate } from "./gate";
import { ProposalMutationStatus } from "./mutation-status";
import { ProposalActions } from "./proposal-actions";
import { useProposalMutation } from "./proposal-mutation";
import { ProposalOutcome } from "./proposal-outcome";

/**
 * The property-acquisition card (#1563).
 *
 * It follows the early-repayment shape — kind, summary, before → after rows, notes,
 * folio, Confirmar / Descartar — and not its housing sibling's, on purpose. The
 * valuation card announces «No verificada» and shows one point; here the user is
 * confirming a MOVE, so the two figures it replaces have to be on screen next to
 * the ones replacing them. That is the whole reason this proposal is allowed to be
 * born from evidence worthline could not validate (#1248): the human eye is the
 * validator, and it can only validate what it is shown.
 *
 * The curve is the same sparkline the valuation card draws, and for the same
 * reason: moving an acquisition to 2004 rewrites twenty-two years of value, and a
 * date plus a price does not look like twenty-two years of anything.
 *
 * Every figure arrives pre-formatted from the server; the client renders strings.
 */
export function PropertyAcquisitionProposalCard({
  proposal,
  ...gate
}: ProposalCardGate & { proposal: PropertyAcquisitionProposal }) {
  const mutation = useProposalMutation(gate, {
    confirm: () => confirmPropertyAcquisitionProposalAction(proposal.draft),
    discard: () => discardPropertyAcquisitionProposalAction(proposal.draft),
  });
  return (
    <div className="assistantProposal">
      <ProposalMutationStatus pending={mutation.pending} result={mutation.result} />
      <p className="assistantProposalKind">Adquisición del inmueble · Hecho fechado</p>
      {/*
        The summary already names the property, the date and the price, so there is
        no line repeating the name under it: a footer or a subtitle that merely
        restates the header is the mistake #1317 pinned. What goes below is the
        pair being replaced, which the headline cannot carry.
      */}
      <strong>{proposal.summary}</strong>
      <ul>
        {proposal.rows.map((row) => (
          <li key={row.label}>
            <span>{row.label}</span>{" "}
            <span>
              {row.before} → {row.after}
            </span>
          </li>
        ))}
      </ul>
      <svg
        aria-label="Curva del valor del inmueble tras mover la adquisición"
        role="img"
        viewBox="0 0 100 100"
      >
        <polyline
          fill="none"
          points={balanceCurvePolyline(
            proposal.points.map((point) => ({
              balanceMinor: point.afterMinor,
              date: point.dateKey,
            })),
          )}
          stroke="currentColor"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {proposal.notes.map((note) => (
        <p className="assistantWarning" key={note}>
          {note}
        </p>
      ))}
      <p className="assistantProposalFolio">{proposal.folio}</p>
      <ProposalOutcome applied="Fecha de adquisición actualizada." mutation={mutation} />
      <ProposalActions mutation={mutation} />
    </div>
  );
}
