"use client";

import { balanceCurvePolyline } from "@web/asistente/balance-curve-polyline";
import {
  confirmPropertyValuationProposalAction,
  discardPropertyValuationProposalAction,
} from "@web/asistente/property-valuation-proposal-action";
import type { PropertyValuationProposal } from "@web/asistente/property-valuation-proposal-contract";
import { useState, useTransition } from "react";
import { formatPositionMoney, proposalResultMessage } from "./card-copy";
import { ProposalMutationStatus } from "./mutation-status";

export function PropertyValuationProposalCard({
  proposal,
  mutationsDisabled,
}: {
  proposal: PropertyValuationProposal;
  mutationsDisabled: boolean;
}) {
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof confirmPropertyValuationProposalAction>
  > | null>(null);
  const [rejected, setRejected] = useState(false);
  const [pending, startTransition] = useTransition();
  if (rejected) return null;
  return (
    <div className="assistantProposal">
      <ProposalMutationStatus pending={pending} result={result} />
      <p className="assistantProposalKind">
        Propuesta de tasación · <strong>No verificada</strong>
      </p>
      <strong>{proposal.property.name}</strong>
      <p>Revisa este punto: no existe un ancla de reconciliación que lo compruebe.</p>
      <svg
        aria-label="Curva resultante del valor del inmueble"
        role="img"
        viewBox="0 0 100 100"
      >
        <polyline
          fill="none"
          points={balanceCurvePolyline(
            proposal.curve.map((point) => ({
              date: point.date,
              balanceMinor: point.valueMinor,
            })),
          )}
          stroke="currentColor"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <p>
        {proposal.anchor.valuationDate} ·{" "}
        {formatPositionMoney(proposal.anchor.valueMinor)}
      </p>
      {result ? (
        <p
          className={result.status === "applied" ? "assistantOk" : "assistantError"}
          role="status"
        >
          {proposalResultMessage(result, "Tasación aplicada.")}
        </p>
      ) : null}
      <div className="assistantProposalActions">
        <button
          disabled={pending || mutationsDisabled || result?.status === "applied"}
          onClick={() =>
            startTransition(async () =>
              setResult(await confirmPropertyValuationProposalAction(proposal.draft)),
            )
          }
          type="button"
        >
          {pending ? "Guardando…" : "Confirmar tras revisar"}
        </button>
        <button
          className="secondary"
          disabled={pending || mutationsDisabled || result?.status === "applied"}
          onClick={() =>
            startTransition(async () => {
              const discarded = await discardPropertyValuationProposalAction(
                proposal.draft,
              );
              if (discarded.status === "discarded") setRejected(true);
              else setResult(discarded);
            })
          }
          type="button"
        >
          Descartar
        </button>
      </div>
    </div>
  );
}
