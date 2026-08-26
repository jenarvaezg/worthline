"use client";

import {
  confirmHoldingCreationProposalAction,
  discardHoldingCreationProposalAction,
} from "@web/asistente/holding-creation-proposal-action";
import type { HoldingCreationProposal } from "@web/asistente/holding-creation-proposal-contract";
import { proposalImpactHeader } from "@web/asistente/proposal-impact-header";
import { useState, useTransition } from "react";
import { formatPositionMoney } from "./card-copy";
import type { ProposalCardGate } from "./gate";
import { ProposalMutationStatus } from "./mutation-status";

/**
 * Alta «por estado actual» (#1105, PRD #1103 S2): the impact header leads
 * (patrimonio neto antes → después), then the holding row, then the informative
 * duplicate warning (never blocks), then Confirmar / Descartar.
 */
export function HoldingCreationProposalCard({
  mutationsDisabled,
  mutationsDisabledMessage,
  proposal,
}: ProposalCardGate & { proposal: HoldingCreationProposal }) {
  const [result, setResult] = useState<
    | Awaited<ReturnType<typeof confirmHoldingCreationProposalAction>>
    | Awaited<ReturnType<typeof discardHoldingCreationProposalAction>>
    | null
  >(null);
  const [pending, startTransition] = useTransition();
  const settled = result?.status === "applied" || result?.status === "discarded";
  const actionsDisabled = pending || mutationsDisabled || settled;
  const header = proposalImpactHeader(proposal.impact, formatPositionMoney);
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
        <li>
          <strong>{proposal.holding.name}</strong>{" "}
          <span>
            {proposal.holding.instrumentLabel} · {proposal.holding.detail}
            {/* Títulos, precio y comisión de la apertura (#1315): lo que se
                persiste, visible antes de confirmar. */}
            {proposal.holding.opening
              ? ` · ${proposal.holding.opening.units} uds. × ${proposal.holding.opening.pricePerUnit}`
              : ""}
            {proposal.holding.opening?.fees
              ? ` · Comisión ${proposal.holding.opening.fees}`
              : ""}
            {proposal.holding.providerSymbol
              ? ` · Símbolo ${proposal.holding.providerSymbol}`
              : ""}
          </span>
        </li>
      </ul>
      {/* La procedencia de la cotización que mintió los títulos (#1329): dato de
          auditoría, no aviso — el usuario decide si un cierre de hace días le
          vale para dar de alta la posición. */}
      {proposal.openingQuoteNote ? (
        <p className="assistantQuoteNote">{proposal.openingQuoteNote}</p>
      ) : null}
      {proposal.openingMismatchWarning ? (
        <p className="assistantWarning">{proposal.openingMismatchWarning}</p>
      ) : null}
      {proposal.priceTrackingWarning ? (
        <p className="assistantWarning">{proposal.priceTrackingWarning}</p>
      ) : null}
      {/* La fecha de adquisición amputaría el histórico de una deuda anterior
          (#1561): se pregunta ANTES de confirmar, que es cuando aún no hay nada
          escrito. Aviso, nunca bloqueo. */}
      {proposal.acquisitionTodayWarning ? (
        <p className="assistantWarning">{proposal.acquisitionTodayWarning}</p>
      ) : null}
      {proposal.duplicate ? (
        <p className="assistantError">
          Ya tienes «{proposal.duplicate.name}»
          {proposal.duplicate.confidence === "strong"
            ? " (coincidencia fuerte)"
            : " (mismo nombre)"}
          {proposal.duplicate.otherCandidates
            ? ` y ${proposal.duplicate.otherCandidates} más que se le parece${
                proposal.duplicate.otherCandidates === 1 ? "" : "n"
              }`
            : ""}
          . Puedes crearlo igualmente si es otro distinto.
        </p>
      ) : null}
      {result ? (
        <p
          aria-live="polite"
          className={result.status === "applied" ? "assistantOk" : "assistantError"}
          role="status"
        >
          {result.status === "applied"
            ? "Holding creado."
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
              setResult(await confirmHoldingCreationProposalAction(proposal.draft)),
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
              setResult(await discardHoldingCreationProposalAction(proposal.draft)),
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
