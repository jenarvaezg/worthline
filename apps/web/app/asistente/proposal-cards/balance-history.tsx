"use client";

import { balanceCurvePolyline } from "@web/asistente/balance-curve-polyline";
import { confirmBalanceHistoryProposalAction } from "@web/asistente/balance-history-proposal-action";
import type { BalanceHistoryProposal } from "@web/asistente/balance-history-proposal-contract";
import {
  anchorDriftSentence,
  reconciliationSentence,
} from "@web/asistente/balance-reconciliation";
import {
  historyReconstructedCopy,
  snapshotMembershipAllowsConfirm,
  snapshotMembershipNotice,
} from "@web/asistente/debt-history-copy";
import { formatPositionMoney } from "./card-copy";
import type { ProposalCardGate } from "./gate";
import { ProposalMutationStatus } from "./mutation-status";
import { useProposalMutation } from "./proposal-mutation";
import { ProposalOutcome } from "./proposal-outcome";

/**
 * The one card of the shared skeleton (#1617) that keeps its own button: this
 * proposal has NO discard, so there is no pair to wrap in `.assistantProposalActions`
 * and `<ProposalActions>` would add a node the card has never painted. It takes the
 * hook and the outcome paragraph; the lone Confirmar stays here.
 */
export function BalanceHistoryProposalCard({
  proposal,
  ...gate
}: ProposalCardGate & { proposal: BalanceHistoryProposal }) {
  const mutation = useProposalMutation(gate, {
    confirm: () => confirmBalanceHistoryProposalAction(proposal.draft),
  });
  // La misma puerta de #1422, en la otra lane del mismo documento: exigir que el
  // extremo cuadre para dejar confirmar dejaba el botón muerto sin salida ninguna.
  // El veredicto se dice; aplicar es decisión del usuario.
  const confirmDisabled =
    mutation.actionsDisabled ||
    !snapshotMembershipAllowsConfirm(proposal.snapshotMembership);
  const membershipNotice = snapshotMembershipNotice(proposal.snapshotMembership);
  const balanceHistoryDrift = anchorDriftSentence(
    proposal.reconciliation,
    formatPositionMoney,
  );
  return (
    <div className="assistantProposal">
      <ProposalMutationStatus pending={mutation.pending} result={mutation.result} />
      <p className="assistantProposalKind">Propuesta de historial de deuda</p>
      <strong>{proposal.liability.name}</strong>
      <svg
        aria-label="Curva resultante del saldo de la deuda"
        role="img"
        viewBox="0 0 100 100"
      >
        <polyline
          fill="none"
          points={balanceCurvePolyline(proposal.curve)}
          stroke="currentColor"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <ul>
        {proposal.points.map((point) => (
          <li key={point.date}>
            <span>{point.date}</span>{" "}
            <span>{formatPositionMoney(point.balanceMinor)}</span>
            <span>
              {point.status === "accepted"
                ? "Incluido"
                : point.status === "skipped"
                  ? "Ya existente"
                  : `Excluido: ${point.reason ?? "saldo no aplicable"}`}
              {point.driftMinor === null
                ? ""
                : ` · Desvío ${formatPositionMoney(point.driftMinor)}`}
            </span>
          </li>
        ))}
      </ul>
      <p>
        Reconciliación: {formatPositionMoney(proposal.reconciliation.resultingMinor)} /{" "}
        {formatPositionMoney(proposal.reconciliation.expectedMinor)}
      </p>
      <p className={proposal.reconciliation.matches ? "assistantOk" : "assistantWarning"}>
        {reconciliationSentence(proposal.reconciliation, formatPositionMoney)}
      </p>
      {balanceHistoryDrift === null ? null : (
        <p className="assistantWarning">{balanceHistoryDrift}</p>
      )}
      {membershipNotice === null ? null : (
        <p className={membershipNotice.className}>{membershipNotice.text}</p>
      )}
      <ProposalOutcome applied={historyReconstructedCopy} mutation={mutation} />
      <button disabled={confirmDisabled} onClick={mutation.confirm} type="button">
        {mutation.pending ? "Guardando…" : "Confirmar"}
      </button>
    </div>
  );
}
