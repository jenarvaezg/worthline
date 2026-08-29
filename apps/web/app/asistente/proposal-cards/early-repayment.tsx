"use client";

import {
  confirmEarlyRepaymentProposalAction,
  discardEarlyRepaymentProposalAction,
} from "@web/asistente/early-repayment-proposal-action";
import type { EarlyRepaymentProposal } from "@web/asistente/early-repayment-proposal-contract";
import type { ProposalCardGate } from "./gate";
import { ProposalMutationStatus } from "./mutation-status";
import { ProposalActions } from "./proposal-actions";
import { useProposalMutation } from "./proposal-mutation";
import { ProposalOutcome } from "./proposal-outcome";

/**
 * The early-repayment card (#1245). Reuses the correction card's shape — kind,
 * summary, before → after rows, folio, Confirmar / Descartar — because the PRD
 * keeps previews on the existing pattern. What it does NOT reuse is the «Solo
 * desde hoy» label: this fact is dated in the past and reshapes the curve from its
 * own month boundary, so claiming the past is untouched would be a lie.
 *
 * Every figure arrives pre-formatted from the server; the client renders strings
 * and never recomputes money.
 */
export function EarlyRepaymentProposalCard({
  proposal,
  ...gate
}: ProposalCardGate & { proposal: EarlyRepaymentProposal }) {
  const mutation = useProposalMutation(gate, {
    confirm: () => confirmEarlyRepaymentProposalAction(proposal.draft),
    discard: () => discardEarlyRepaymentProposalAction(proposal.draft),
  });
  return (
    <div className="assistantProposal">
      <ProposalMutationStatus pending={mutation.pending} result={mutation.result} />
      <p className="assistantProposalKind">Amortización anticipada · Hecho fechado</p>
      <strong>{proposal.summary}</strong>
      <p>
        {proposal.repayment.amount} · {proposal.repayment.dateLabel} ·{" "}
        {proposal.repayment.modeLabel}
      </p>
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
      {proposal.reconciliation ? (
        <p
          className={proposal.reconciliation.matches ? "assistantOk" : "assistantWarning"}
        >
          {proposal.reconciliation.matches
            ? `Cuota observada ${proposal.reconciliation.observed}: cuadra con la del plan.`
            : `Cuota observada ${proposal.reconciliation.observed} · cuota del plan ${proposal.reconciliation.plan}.`}
        </p>
      ) : null}
      {proposal.notes.map((note) => (
        <p className="assistantWarning" key={note}>
          {note}
        </p>
      ))}
      <p className="assistantProposalFolio">{proposal.folio}</p>
      <ProposalOutcome
        applied="Amortización anticipada registrada."
        mutation={mutation}
      />
      <ProposalActions mutation={mutation} />
    </div>
  );
}
