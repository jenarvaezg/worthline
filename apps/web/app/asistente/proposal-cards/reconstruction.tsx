"use client";

import {
  computeCorrectionGate,
  editCorrectionPoint,
} from "@web/asistente/anchor-correction-gate";
import { balanceCurvePolyline } from "@web/asistente/balance-curve-polyline";
import {
  anchorDriftSentence,
  reconciliationSentence,
  redeclarationSentence,
} from "@web/asistente/balance-reconciliation";
import {
  confirmCorrectionProposalAction,
  discardCorrectionProposalAction,
} from "@web/asistente/correction-proposal-action";
import type { ReconstructionCorrectionProposal } from "@web/asistente/correction-proposal-contract";
import {
  historyReconstructedCopy,
  snapshotMembershipAllowsConfirm,
  snapshotMembershipNotice,
} from "@web/asistente/debt-history-copy";
import { useState, useTransition } from "react";
import { formatPositionMoney } from "./card-copy";
import type { ProposalCardGate } from "./gate";
import { ProposalMutationStatus } from "./mutation-status";

/**
 * Superficie C «Ancla primero», reconstruct depth (#1053): the guarantee leads,
 * an orienting stepped curve follows, and the point-by-point series is folded
 * below with per-point amount edit / exclusion. The confirm gate (canConfirm) and
 * the exclusions/edits run through the pure `anchor-correction-gate` module; the
 * confirm re-sends the kept series so the server re-projects it against live data.
 */
export function ReconstructionProposalCard({
  mutationsDisabled,
  mutationsDisabledMessage,
  proposal,
}: ProposalCardGate & { proposal: ReconstructionCorrectionProposal }) {
  const [result, setResult] = useState<
    | Awaited<ReturnType<typeof confirmCorrectionProposalAction>>
    | Awaited<ReturnType<typeof discardCorrectionProposalAction>>
    | null
  >(null);
  const [series, setSeries] = useState(proposal.series);
  const [dirty, setDirty] = useState(false);
  const [pending, startTransition] = useTransition();

  const applyEdit = (
    index: number,
    change: { balanceMinor?: number; excluded?: boolean },
  ) => {
    setSeries((current) => editCorrectionPoint(current, index, change) as typeof current);
    setDirty(true);
  };
  const editedRows = series
    .filter((point) => !point.excluded && point.balanceMinor !== null)
    .map((point) => ({ balanceMinor: point.balanceMinor as number, date: point.date }));

  // La reconciliación es un VEREDICTO, no una cerradura (#1422). Confirmar pide
  // solo que quede un punto que aplicar: si el extremo no cuadra, la frase lo
  // dice y el servidor re-proyecta la serie de todos modos. Al revés —lo que
  // había— un documento correcto del banco no tenía ninguna forma de entrar, y
  // «edita un punto» solo movía la misma negativa un clic más tarde.
  const gate = computeCorrectionGate({
    anchorMinor: proposal.anchorMinor,
    mode: "reconstruir",
    series,
  });
  const verified = !dirty && proposal.guarantee.state === "reconciled";
  const canConfirm =
    gate.canConfirm && snapshotMembershipAllowsConfirm(proposal.snapshotMembership);
  const membershipNotice = snapshotMembershipNotice(proposal.snapshotMembership);
  const drift = dirty
    ? null
    : anchorDriftSentence(proposal.reconciliation, formatPositionMoney);
  // Editar la serie no apaga la consecuencia, solo la vuelve menos predecible: el
  // confirmar sigue re-derivando el saldo declarado, y callarlo justo entonces
  // sería la mitad exacta de la promesa (#1422).
  const redeclaration = dirty
    ? "Al confirmar, tu saldo declarado pasará a ser el extremo de la serie que apliques."
    : redeclarationSentence(proposal.reconciliation, formatPositionMoney);
  const settled = result?.status === "applied" || result?.status === "discarded";
  const actionsDisabled = pending || mutationsDisabled || settled;

  return (
    <div className="assistantProposal">
      <ProposalMutationStatus pending={pending} result={result} />
      <p className="assistantProposalKind">Corrección · Reconstruir historia</p>
      <strong>{proposal.summary}</strong>
      {/* Superficie C: the guarantee leads, the point-by-point detail folds below. */}
      <p className={verified ? "assistantOk" : dirty ? "" : "assistantWarning"}>
        {dirty
          ? "Editaste la serie — se recomprobará con el motor al confirmar."
          : reconciliationSentence(proposal.reconciliation, formatPositionMoney)}
      </p>
      {/* El ancla deja de ser el juez incuestionable (#1422): cuando la propia
          curva de la deuda no la reproduce, se dice — es un diagnóstico que no
          depende de ningún documento y aquí señala al candidato correcto. */}
      {drift === null ? null : <p className="assistantWarning">{drift}</p>}
      <svg
        aria-label="Curva escalonada orientativa del saldo reconstruido"
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
      {dirty ? null : (
        <p>
          Reconciliación: {formatPositionMoney(proposal.reconciliation.resultingMinor)} /{" "}
          {formatPositionMoney(proposal.reconciliation.expectedMinor)} ·{" "}
          {proposal.reconciliation.against === "model"
            ? "tu curva actual"
            : "tu saldo declarado"}{" "}
          · margen ±{formatPositionMoney(proposal.reconciliation.toleranceMinor)}
        </p>
      )}
      {/* Lo que el confirmar va a hacerle al saldo declarado, dicho ANTES de
          pulsarlo: «el documento tiene razón, actualiza el saldo declarado» era
          justo lo que el usuario escribió en el chat y no tenía botón (#1422). */}
      {redeclaration === null ? null : <p>{redeclaration}</p>}
      <details suppressHydrationWarning>
        <summary>Detalle punto a punto ({series.length})</summary>
        <ul>
          {series.map((point, index) => (
            <li key={point.date}>
              <span>{point.date}</span>{" "}
              <input
                aria-label={`Saldo de ${point.date} en euros`}
                disabled={actionsDisabled || point.excluded}
                min={0}
                onChange={(event) => {
                  const euros = Number.parseFloat(event.target.value);
                  if (Number.isFinite(euros)) {
                    applyEdit(index, { balanceMinor: Math.round(euros * 100) });
                  }
                }}
                step={0.01}
                type="number"
                value={point.balanceMinor === null ? "" : point.balanceMinor / 100}
              />
              <label>
                <input
                  checked={point.excluded ?? false}
                  disabled={actionsDisabled}
                  onChange={(event) =>
                    applyEdit(index, { excluded: event.target.checked })
                  }
                  type="checkbox"
                />
                Excluir
              </label>
              <span>
                {point.origin === "user"
                  ? "Corregido por ti"
                  : "Extraído por el asistente"}
                {point.reason === undefined ? "" : ` · ${point.reason}`}
                {point.driftMinor === null || point.driftMinor === undefined
                  ? ""
                  : ` · Desvío ${formatPositionMoney(point.driftMinor)}`}
              </span>
            </li>
          ))}
        </ul>
      </details>
      <p className="assistantProposalFolio">{proposal.folio}</p>
      {membershipNotice === null ? null : (
        <p className={membershipNotice.className}>{membershipNotice.text}</p>
      )}
      {result ? (
        <p
          aria-live="polite"
          className={
            result.status === "applied"
              ? historyReconstructedCopy(result).className
              : "assistantError"
          }
          role="status"
        >
          {result.status === "applied"
            ? historyReconstructedCopy(result).text
            : result.status === "discarded"
              ? "Propuesta descartada."
              : result.message}
        </p>
      ) : mutationsDisabled ? (
        <p className="assistantError">{mutationsDisabledMessage}</p>
      ) : null}
      <div className="assistantProposalActions">
        <button
          disabled={actionsDisabled || !canConfirm}
          onClick={() =>
            startTransition(async () =>
              setResult(
                await confirmCorrectionProposalAction(proposal.draft, editedRows),
              ),
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
              setResult(await discardCorrectionProposalAction(proposal.draft)),
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
