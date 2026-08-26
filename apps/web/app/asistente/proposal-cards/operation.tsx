"use client";

import {
  confirmOperationProposalAction,
  discardOperationProposalAction,
} from "@web/asistente/operation-proposal-action";
import type { OperationProposal } from "@web/asistente/operation-proposal-contract";
import { proposalImpactHeader } from "@web/asistente/proposal-impact-header";
import { useState, useTransition } from "react";
import { formatPositionMoney } from "./card-copy";
import type { ProposalCardGate } from "./gate";
import { ProposalMutationStatus } from "./mutation-status";

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
  mutationsDisabled,
  mutationsDisabledMessage,
  proposal,
}: ProposalCardGate & { proposal: OperationProposal }) {
  const [result, setResult] = useState<
    | Awaited<ReturnType<typeof confirmOperationProposalAction>>
    | Awaited<ReturnType<typeof discardOperationProposalAction>>
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
          <span>En el documento</span>
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
      {result ? (
        <p
          aria-live="polite"
          className={result.status === "applied" ? "assistantOk" : "assistantError"}
          role="status"
        >
          {result.status === "applied"
            ? "Operación anotada."
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
              setResult(await confirmOperationProposalAction(proposal.draft)),
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
              setResult(await discardOperationProposalAction(proposal.draft)),
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
