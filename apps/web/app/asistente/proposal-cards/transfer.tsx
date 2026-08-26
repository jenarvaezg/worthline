"use client";

import { proposalImpactHeader } from "@web/asistente/proposal-impact-header";
import {
  confirmTransferProposalAction,
  discardTransferProposalAction,
} from "@web/asistente/transfer-proposal-action";
import type { TransferProposal } from "@web/asistente/transfer-proposal-contract";
import { useState, useTransition } from "react";
import { formatPositionMoney } from "./card-copy";
import type { ProposalCardGate } from "./gate";
import { ProposalMutationStatus } from "./mutation-status";

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
  mutationsDisabled,
  mutationsDisabledMessage,
  proposal,
}: ProposalCardGate & { proposal: TransferProposal }) {
  const [result, setResult] = useState<
    | Awaited<ReturnType<typeof confirmTransferProposalAction>>
    | Awaited<ReturnType<typeof discardTransferProposalAction>>
    | null
  >(null);
  const [pending, startTransition] = useTransition();
  const settled = result?.status === "applied" || result?.status === "discarded";
  const actionsDisabled = pending || mutationsDisabled || settled;
  const header = proposalImpactHeader(proposal.impact, formatPositionMoney, {
    caption: proposal.impactCaption,
  });
  return (
    <div className="assistantProposal">
      <ProposalMutationStatus pending={pending} result={result} />
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
      {result ? (
        <p
          aria-live="polite"
          className={result.status === "applied" ? "assistantOk" : "assistantError"}
          role="status"
        >
          {result.status === "applied"
            ? "Traspaso anotado."
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
            startTransition(async () =>
              setResult(await confirmTransferProposalAction(proposal.draft)),
            )
          }
          type="button"
        >
          {pending ? "Guardando…" : "Confirmar"}
        </button>
        <button
          className="secondary"
          disabled={actionsDisabled}
          onClick={() =>
            startTransition(async () =>
              setResult(await discardTransferProposalAction(proposal.draft)),
            )
          }
          type="button"
        >
          Descartar
        </button>
      </div>
    </div>
  );
}
