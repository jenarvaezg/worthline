"use client";

import {
  confirmEarlyRepaymentProposalAction,
  discardEarlyRepaymentProposalAction,
} from "@web/asistente/early-repayment-proposal-action";
import type { EarlyRepaymentProposal } from "@web/asistente/early-repayment-proposal-contract";
import { useState, useTransition } from "react";
import type { ProposalCardGate } from "./gate";
import { ProposalMutationStatus } from "./mutation-status";

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
  mutationsDisabled,
  mutationsDisabledMessage,
  proposal,
}: ProposalCardGate & { proposal: EarlyRepaymentProposal }) {
  const [result, setResult] = useState<
    | Awaited<ReturnType<typeof confirmEarlyRepaymentProposalAction>>
    | Awaited<ReturnType<typeof discardEarlyRepaymentProposalAction>>
    | null
  >(null);
  const [pending, startTransition] = useTransition();
  const settled = result?.status === "applied" || result?.status === "discarded";
  const actionsDisabled = pending || mutationsDisabled || settled;
  return (
    <div className="assistantProposal">
      <ProposalMutationStatus pending={pending} result={result} />
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
      {result ? (
        <p
          aria-live="polite"
          className={result.status === "applied" ? "assistantOk" : "assistantError"}
          role="status"
        >
          {result.status === "applied"
            ? "Amortización anticipada registrada."
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
              setResult(await confirmEarlyRepaymentProposalAction(proposal.draft)),
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
              setResult(await discardEarlyRepaymentProposalAction(proposal.draft)),
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
