"use client";

import {
  holdingTrashImpactHeader,
  holdingTrashWarnings,
} from "@web/asistente/holding-trash-card-model";
import {
  confirmHoldingRemovalProposalAction,
  confirmHoldingRestorationProposalAction,
  discardHoldingRemovalProposalAction,
  discardHoldingRestorationProposalAction,
} from "@web/asistente/holding-trash-proposal-action";
import type { HoldingTrashProposal } from "@web/asistente/holding-trash-proposal-contract";
import { formatPositionMoney } from "./card-copy";
import type { ProposalCardGate } from "./gate";
import { ProposalMutationStatus } from "./mutation-status";
import { ProposalActions } from "./proposal-actions";
import { useProposalMutation } from "./proposal-mutation";
import { ProposalOutcome } from "./proposal-outcome";

/**
 * Baja / restauración (#1106, PRD #1103 S3, superficie B): the same anatomy as
 * the alta — impact header leads (patrimonio neto antes → después), then the
 * batch of holdings, then the informative warnings (orphan pair, shared
 * ownership, live-holding duplicate — never block), then Confirmar / Descartar.
 * One card serves both mirror kinds; `operation` picks the server actions and
 * the wording. Display logic lives in the pure `holding-trash-card-model`.
 */
export function HoldingTrashProposalCard({
  proposal,
  ...gate
}: ProposalCardGate & { proposal: HoldingTrashProposal }) {
  const isRemoval = proposal.proposalType === "holding_removal";
  const confirmAction = isRemoval
    ? confirmHoldingRemovalProposalAction
    : confirmHoldingRestorationProposalAction;
  const discardAction = isRemoval
    ? discardHoldingRemovalProposalAction
    : discardHoldingRestorationProposalAction;
  const mutation = useProposalMutation(gate, {
    confirm: () => confirmAction(proposal.draft),
    discard: () => discardAction(proposal.draft),
  });
  const header = holdingTrashImpactHeader(proposal.impact, formatPositionMoney);
  const warnings = holdingTrashWarnings(proposal);
  return (
    <div className="assistantProposal">
      <ProposalMutationStatus pending={mutation.pending} result={mutation.result} />
      <p className="assistantProposalKind">{proposal.folio}</p>
      {/* Impact first: what confirming does to the household net worth. */}
      <strong>{header.headline}</strong>
      <p className={header.increases ? "assistantOk" : "assistantError"}>
        {header.deltaLabel}
      </p>
      <ul>
        {proposal.lines.map((line) => (
          <li key={line.holdingId}>
            <strong>{line.name}</strong>{" "}
            <span>
              {line.instrumentLabel} · {line.detail}
            </span>
          </li>
        ))}
      </ul>
      {warnings.map((warning) => (
        <p className="assistantWarning" key={warning}>
          {warning}
        </p>
      ))}
      <ProposalOutcome
        applied={isRemoval ? "Holdings enviados a la papelera." : "Holdings restaurados."}
        mutation={mutation}
      />
      <ProposalActions mutation={mutation} />
    </div>
  );
}
