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
import { useState, useTransition } from "react";
import { formatPositionMoney } from "./card-copy";
import type { ProposalCardGate } from "./gate";
import { ProposalMutationStatus } from "./mutation-status";

/**
 * Baja / restauración (#1106, PRD #1103 S3, superficie B): the same anatomy as
 * the alta — impact header leads (patrimonio neto antes → después), then the
 * batch of holdings, then the informative warnings (orphan pair, shared
 * ownership, live-holding duplicate — never block), then Confirmar / Descartar.
 * One card serves both mirror kinds; `operation` picks the server actions and
 * the wording. Display logic lives in the pure `holding-trash-card-model`.
 */
export function HoldingTrashProposalCard({
  mutationsDisabled,
  mutationsDisabledMessage,
  proposal,
}: ProposalCardGate & { proposal: HoldingTrashProposal }) {
  const isRemoval = proposal.proposalType === "holding_removal";
  const confirmAction = isRemoval
    ? confirmHoldingRemovalProposalAction
    : confirmHoldingRestorationProposalAction;
  const discardAction = isRemoval
    ? discardHoldingRemovalProposalAction
    : discardHoldingRestorationProposalAction;
  const [result, setResult] = useState<
    | Awaited<ReturnType<typeof confirmHoldingRemovalProposalAction>>
    | Awaited<ReturnType<typeof discardHoldingRemovalProposalAction>>
    | null
  >(null);
  const [pending, startTransition] = useTransition();
  const settled = result?.status === "applied" || result?.status === "discarded";
  const actionsDisabled = pending || mutationsDisabled || settled;
  const header = holdingTrashImpactHeader(proposal.impact, formatPositionMoney);
  const warnings = holdingTrashWarnings(proposal);
  return (
    <div className="assistantProposal">
      <ProposalMutationStatus pending={pending} result={result} />
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
      {result ? (
        <p
          aria-live="polite"
          className={result.status === "applied" ? "assistantOk" : "assistantError"}
          role="status"
        >
          {result.status === "applied"
            ? isRemoval
              ? "Holdings enviados a la papelera."
              : "Holdings restaurados."
            : result.status === "discarded"
              ? "Propuesta descartada."
              : result.message}
        </p>
      ) : mutationsDisabled ? (
        <p className="assistantError">{mutationsDisabledMessage}</p>
      ) : null}
      <div className="assistantProposalActions">
        <button
          disabled={actionsDisabled}
          onClick={() =>
            startTransition(async () => setResult(await confirmAction(proposal.draft)))
          }
          type="button"
        >
          {pending ? "Guardando…" : "Confirmar"}
        </button>
        <button
          className="secondary"
          disabled={actionsDisabled}
          onClick={() =>
            startTransition(async () => setResult(await discardAction(proposal.draft)))
          }
          type="button"
        >
          Descartar
        </button>
      </div>
    </div>
  );
}
