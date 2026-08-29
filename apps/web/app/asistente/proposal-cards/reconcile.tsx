"use client";

import { instrumentLabel } from "@web/asistente/instrument-labels";
import { proposalImpactHeader } from "@web/asistente/proposal-impact-header";
import {
  discardReconcileRow,
  effectiveDecision,
  isRowWritable,
  type ReconcileRow,
  reassignRowToCandidate,
  reassignRowToNew,
  reconcileImpact,
  reconcileSummary,
  restoreReconcileRow,
} from "@web/asistente/reconcile-plan";
import {
  confirmReconcileProposalAction,
  discardReconcileProposalAction,
} from "@web/asistente/reconcile-proposal-action";
import {
  type ReconcileCuration,
  type ReconcileProposal,
  reconcileFolio,
} from "@web/asistente/reconcile-proposal-contract";
import {
  reconcileAmbiguityMark,
  reconcileDestinationLabel,
  reconcileDocumentLine,
  reconcileFidelityMark,
  reconcileImpactCaption,
  reconcileMovementLine,
} from "@web/asistente/reconcile-row-copy";
import { useState } from "react";
import { formatPositionMoney } from "./card-copy";
import type { ProposalCardGate } from "./gate";
import { ProposalMutationStatus } from "./mutation-status";
import { ProposalActions } from "./proposal-actions";
import { useProposalMutation } from "./proposal-mutation";
import { ProposalOutcome } from "./proposal-outcome";

/**
 * The row's editable decision (#1373). It used to be a rank of look-alike buttons —
 * «Crear nuevo» first and in primary ink, then one «Actualizar «X»» per candidate
 * INCLUDING the one already chosen, which was a filled, principal-looking button
 * whose click changed nothing a user could see. So it stops being buttons at all:
 * choosing a destination is a choice among alternatives, and native radios say which
 * one is live without colour being the only signal, with no affordance that promises
 * an action and performs none. The candidates come first and «Crear nuevo» last —
 * creating is the option that would duplicate the holding, so it is not the default
 * shape of the row, and Confirmar stays the card's only primary.
 *
 * A row taken out of the batch has its choices INERT rather than live: the pure
 * reassign helpers put a row back in when it is given a destination, and a group of
 * enabled radios that silently re-includes the row — while the control next to it
 * still offers to re-include it, and no radio reads as chosen — is the same hidden
 * effect this component was rebuilt to remove. Out of the batch, the way back is the
 * one control that says so.
 */
function ReconcileRowChoices({
  disabled,
  groupName,
  onCreate,
  onUpdate,
  row,
}: {
  disabled: boolean;
  groupName: string;
  onCreate: () => void;
  onUpdate: (holdingId: string) => void;
  row: ReconcileRow;
}) {
  const decision = effectiveDecision(row);
  return (
    <span
      aria-label={`Destino de ${row.name}`}
      className="assistantRowChoices"
      role="radiogroup"
    >
      {row.match.candidates.map((candidate) => (
        <label className="assistantRowChoice" key={candidate.holdingId}>
          <input
            checked={decision === "update" && row.match.target === candidate.holdingId}
            disabled={disabled}
            name={groupName}
            onChange={() => onUpdate(candidate.holdingId)}
            type="radio"
          />
          Actualizar «{candidate.name}»
        </label>
      ))}
      <label className="assistantRowChoice">
        <input
          checked={decision === "create"}
          disabled={disabled}
          name={groupName}
          onChange={onCreate}
          type="radio"
        />
        Crear nuevo
      </label>
    </span>
  );
}

/**
 * Reconcile por documento (#1108, PRD #1103 S5): the impact header leads
 * (patrimonio neto antes → después), then each row printing what the DOCUMENT says,
 * which holding it will write to, and the movements it will add — reassignable in
 * place (actualizar ↔ crear ↔ quitar del lote), never blocking on a doubtful match;
 * folio «Propuesta de reconcile · N holdings». Reuses the `.assistantProposal`
 * anatomy — no new card. The rows are editable client state; Confirmar sends the
 * curated decisions to the atomic apply.
 *
 * The three lines per row are the fix of #1373: the document text and the target
 * holding used to be one sentence, so a model that typed the name of the wrong
 * pension plan produced a row whose title and whose «Actualizar «…»» agreed with
 * each other and with nothing else — and the movements, the only place the 125 € of
 * the document appeared, were summarized as a fidelity tier.
 */
export function ReconcileProposalCard({
  proposal,
  ...gate
}: ProposalCardGate & { proposal: ReconcileProposal }) {
  const [rows, setRows] = useState<ReconcileRow[]>(proposal.rows);

  // Confirmar sends the CURATED decisions, so the thunk is built over this render's
  // rows: what the user sees is what the atomic apply receives.
  const curation: ReconcileCuration[] = rows.map((row) => {
    const decision = effectiveDecision(row);
    return decision === "update" && row.match.target
      ? { decision, rowId: row.rowId, target: row.match.target }
      : { decision, rowId: row.rowId };
  });
  const mutation = useProposalMutation(gate, {
    confirm: () => confirmReconcileProposalAction(proposal.draft, curation),
    discard: () => discardReconcileProposalAction(proposal.draft),
  });
  const actionsDisabled = mutation.actionsDisabled;

  const summary = reconcileSummary(rows);
  const impact = reconcileImpact(rows, proposal.netWorthBeforeMinor);
  const caption = reconcileImpactCaption(impact);
  const header = proposalImpactHeader(impact, formatPositionMoney, {
    ...(caption ? { caption } : {}),
  });
  const folio = reconcileFolio(summary.active);

  return (
    <div className="assistantProposal">
      <ProposalMutationStatus pending={mutation.pending} result={mutation.result} />
      <p className="assistantProposalKind">{folio}</p>
      <strong>{header.headline}</strong>
      <p className={header.increases ? "assistantOk" : "assistantError"}>
        {header.deltaLabel}
      </p>
      <ul>
        {rows.map((row) => (
          <li key={row.rowId}>
            <strong>{reconcileDocumentLine(row)}</strong>
            <span>
              En el documento · {instrumentLabel(row.instrument)} ·{" "}
              {reconcileFidelityMark(row.fidelity)}
              {row.uncertain ? " · dudoso" : ""}
            </span>
            <span>
              {reconcileDestinationLabel(row)}
              {reconcileAmbiguityMark(row)}
              {!row.excluded && !isRowWritable(row) ? " · fuera de alcance" : ""}
            </span>
            {/* The evidence, line by line: what confirm will write on this holding. */}
            {row.movements.map((movement, index) => (
              <span
                className="assistantRowMovement"
                key={`${movement.date}-${movement.kind}-${index}`}
              >
                {reconcileMovementLine(movement)}
              </span>
            ))}
            <ReconcileRowChoices
              disabled={actionsDisabled || row.excluded}
              groupName={`reconcile-${proposal.draft.proposalId}-${row.rowId}`}
              onCreate={() => setRows(reassignRowToNew(rows, row.rowId))}
              onUpdate={(holdingId) =>
                setRows(reassignRowToCandidate(rows, row.rowId, holdingId))
              }
              row={row}
            />
            <span className="assistantRowAside">
              <button
                disabled={actionsDisabled}
                onClick={() =>
                  setRows(
                    row.excluded
                      ? restoreReconcileRow(rows, row.rowId)
                      : discardReconcileRow(rows, row.rowId),
                  )
                }
                type="button"
              >
                {/* Never «Descartar»: that word belongs to the whole proposal below. */}
                {row.excluded
                  ? "Volver a incluir esta fila"
                  : "Quitar esta fila del lote"}
              </button>
            </span>
          </li>
        ))}
      </ul>
      <ProposalOutcome
        applied={(result) =>
          `Cartera cuadrada: ${result.created} creados, ${result.updated} actualizados.`
        }
        mutation={mutation}
      />
      {/* Never «Descartar» alone: that word belongs to the row control above. */}
      <ProposalActions
        confirmDisabled={summary.active === 0}
        discardLabel="Descartar la propuesta"
        mutation={mutation}
      />
    </div>
  );
}
