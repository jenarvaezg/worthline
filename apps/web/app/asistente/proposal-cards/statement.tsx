"use client";

import {
  confirmStatementImportProposalAction,
  discardStatementImportProposalAction,
} from "@web/asistente/statement-import-proposal-action";
import type { StatementImportProposal } from "@web/asistente/statement-import-proposals";
import {
  INITIAL_STATEMENT_PROPOSAL_DISCARD_STATE,
  reduceStatementProposalDiscard,
} from "@web/asistente/statement-proposal-discard-state";
import { useEffect, useReducer, useRef, useState, useTransition } from "react";
import {
  ambiguousFundNote,
  formatPositionMoney,
  proposalResultMessage,
} from "./card-copy";
import type { ProposalCardGate } from "./gate";
import { ProposalMutationStatus } from "./mutation-status";

export function StatementProposalCard({
  mutationsDisabled,
  mutationsDisabledMessage,
  proposal,
}: ProposalCardGate & { proposal: StatementImportProposal }) {
  const [discardState, dispatchDiscard] = useReducer(
    reduceStatementProposalDiscard,
    INITIAL_STATEMENT_PROPOSAL_DISCARD_STATE,
  );
  const discardStatusRef = useRef<HTMLParagraphElement>(null);
  const discardButtonRef = useRef<HTMLButtonElement>(null);
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof confirmStatementImportProposalAction>
  > | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (discardState.status === "discarding" || discardState.status === "discarded") {
      discardStatusRef.current?.focus();
    } else if (discardState.status === "error") {
      discardButtonRef.current?.focus();
    }
  }, [discardState.status]);

  if (discardState.status === "discarding" || discardState.status === "discarded") {
    return (
      <p aria-live="polite" ref={discardStatusRef} role="status" tabIndex={-1}>
        {discardState.status === "discarding"
          ? "Descartando propuesta…"
          : "Propuesta descartada."}
      </p>
    );
  }

  const blockedMessage = mutationsDisabled ? mutationsDisabledMessage : null;
  const confirmDisabled = pending || result?.status === "applied" || mutationsDisabled;

  function confirm() {
    startTransition(async () => {
      setResult(await confirmStatementImportProposalAction(proposal.draft));
    });
  }

  function discard() {
    dispatchDiscard({ type: "start" });
    startTransition(async () => {
      const discardResult = await discardStatementImportProposalAction(proposal.draft);
      dispatchDiscard(
        discardResult.status === "discarded"
          ? { type: "succeed" }
          : { type: "fail", message: discardResult.message },
      );
    });
  }

  return (
    <div className="assistantProposal">
      <ProposalMutationStatus pending={pending} result={result} />
      <p className="assistantProposalKind">Propuesta de importación de extracto</p>
      <ul>
        {proposal.funds.map((fund) => (
          <li key={fund.isin}>
            <strong>
              {fund.bucket !== "matched"
                ? fund.suggestedName || fund.isin
                : fund.ambiguous
                  ? fund.isin
                  : fund.existingName}
            </strong>
            <span>
              {fund.bucket === "matched" ? "Existente" : "Nuevo"} · {fund.executedCount}{" "}
              movimientos
            </span>
            {fund.bucket === "matched" && fund.ambiguous ? (
              // No position line: this fund is NOT being imported, and the only
              // figures on hand are the first candidate's — the very default this
              // fix exists to stop passing off as the answer (#1366).
              <span className="assistantWarning">
                {ambiguousFundNote(fund.isin, fund.choices.length)}
              </span>
            ) : (
              <>
                <span>
                  Posición: {fund.positionImpact.beforeUnits} →{" "}
                  {fund.positionImpact.afterUnits} (
                  {formatPositionMoney(fund.positionImpact.beforeValueMinor)} →{" "}
                  {formatPositionMoney(fund.positionImpact.afterValueMinor)})
                </span>
                {fund.positionImpact.flags.length > 0 ? (
                  <span>Avisos: {fund.positionImpact.flags.join(", ")}</span>
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>
      {discardState.status === "error" ? (
        <p className="assistantError">{discardState.message}</p>
      ) : null}
      {result ? (
        <p className={result.status === "applied" ? "assistantOk" : "assistantError"}>
          {result.status === "applied"
            ? `Importación aplicada (${result.included} fondos, ${result.created} nuevos).`
            : proposalResultMessage(result, "")}
        </p>
      ) : blockedMessage ? (
        <p className="assistantError">{blockedMessage}</p>
      ) : null}
      <div className="assistantProposalActions">
        <button disabled={confirmDisabled} onClick={confirm} type="button">
          Confirmar
        </button>
        <button
          className="secondary"
          disabled={confirmDisabled}
          onClick={discard}
          ref={discardButtonRef}
          type="button"
        >
          Descartar
        </button>
      </div>
    </div>
  );
}
