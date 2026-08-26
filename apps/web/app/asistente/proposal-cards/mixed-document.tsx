"use client";

import { balanceCurvePolyline } from "@web/asistente/balance-curve-polyline";
import { confirmMixedDocumentProposalAction } from "@web/asistente/mixed-document-proposal-action";
import type { MixedDocumentProposal } from "@web/asistente/mixed-document-proposals";
import { useState, useTransition } from "react";
import { ambiguousFundNote, formatPositionMoney } from "./card-copy";
import type { ProposalCardGate } from "./gate";
import { ProposalMutationStatus } from "./mutation-status";

export function MixedDocumentProposalCard({
  mutationsDisabled,
  mutationsDisabledMessage,
  proposal,
}: ProposalCardGate & { proposal: MixedDocumentProposal }) {
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof confirmMixedDocumentProposalAction>
  > | null>(null);
  const [pending, startTransition] = useTransition();
  const label = {
    debt_balance_history: "Historial de deuda",
    investment_statement: "Inversión",
    property_valuation: "Tasación inmobiliaria",
  } as const;
  return (
    <div className="assistantProposal">
      <ProposalMutationStatus pending={pending} result={result} />
      <p className="assistantProposalKind">Propuesta de documento mixto · todo o nada</p>
      <ul>
        {proposal.sections.map((section, index) => {
          const trust = section.preview.trust;
          return (
            <li key={`${section.kind}-${section.assetKey}-${index}`}>
              <strong>{label[section.kind]}</strong>
              {section.kind === "investment_statement" ? (
                <>
                  {section.preview.funds.map((fund) =>
                    // Left out of the import, so it gets the note and none of the
                    // first candidate's figures (#1366).
                    fund.bucket === "matched" && fund.ambiguous ? (
                      <span className="assistantWarning" key={fund.isin}>
                        {ambiguousFundNote(fund.isin, fund.choices.length)}
                      </span>
                    ) : (
                      <span key={fund.isin}>
                        {fund.bucket === "matched"
                          ? fund.existingName
                          : fund.suggestedName || fund.isin}
                        : {fund.executedCount} movimientos · posición{" "}
                        {fund.positionImpact.beforeUnits} →{" "}
                        {fund.positionImpact.afterUnits} (
                        {formatPositionMoney(fund.positionImpact.beforeValueMinor)} →{" "}
                        {formatPositionMoney(fund.positionImpact.afterValueMinor)})
                        {fund.positionImpact.flags.length > 0
                          ? ` · Avisos: ${fund.positionImpact.flags.join(", ")}`
                          : ""}
                      </span>
                    ),
                  )}
                </>
              ) : section.kind === "debt_balance_history" ? (
                <>
                  <span>{section.preview.liability.name}</span>
                  <span>
                    {section.preview.points.length} puntos · saldo resultante{" "}
                    {formatPositionMoney(section.preview.reconciliation.resultingMinor)} /
                    ancla{" "}
                    {formatPositionMoney(section.preview.reconciliation.expectedMinor)}
                  </span>
                  <span>
                    Curva {section.preview.curve[0]?.date}:{" "}
                    {section.preview.curve[0]
                      ? formatPositionMoney(section.preview.curve[0].balanceMinor)
                      : "—"}{" "}
                    → {section.preview.curve.at(-1)?.date}:{" "}
                    {section.preview.curve.at(-1)
                      ? formatPositionMoney(section.preview.curve.at(-1)!.balanceMinor)
                      : "—"}
                  </span>
                  <svg
                    aria-label={`Curva completa del saldo de ${section.preview.liability.name}`}
                    role="img"
                    viewBox="0 0 100 100"
                  >
                    <polyline
                      fill="none"
                      points={balanceCurvePolyline(section.preview.curve)}
                      stroke="currentColor"
                      strokeWidth="2"
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                  {section.preview.points
                    .filter((point) => point.status === "excluded")
                    .map((point) => (
                      <span key={point.date}>
                        Aviso {point.date}: {point.reason ?? "punto excluido"}
                      </span>
                    ))}
                </>
              ) : (
                <>
                  <span>{section.preview.property.name}</span>
                  {section.preview.anchors.map((anchor) => (
                    <span key={anchor.valuationDate}>
                      Ancla {anchor.valuationDate}:{" "}
                      {formatPositionMoney(anchor.valueMinor)}
                    </span>
                  ))}
                  <span>
                    Curva {section.preview.curve[0]?.date}:{" "}
                    {section.preview.curve[0]
                      ? formatPositionMoney(section.preview.curve[0].valueMinor)
                      : "—"}{" "}
                    → {section.preview.curve.at(-1)?.date}:{" "}
                    {section.preview.curve.at(-1)
                      ? formatPositionMoney(section.preview.curve.at(-1)!.valueMinor)
                      : "—"}
                  </span>
                  <svg
                    aria-label={`Curva completa del valor de ${section.preview.property.name}`}
                    role="img"
                    viewBox="0 0 100 100"
                  >
                    <polyline
                      fill="none"
                      points={balanceCurvePolyline(
                        section.preview.curve.map((point) => ({
                          balanceMinor: point.valueMinor,
                        })),
                      )}
                      stroke="currentColor"
                      strokeWidth="2"
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                </>
              )}
              <span>
                {trust.tier === "reconciled"
                  ? "Reconciliado"
                  : trust.tier === "mismatch"
                    ? "No cuadra con el ancla"
                    : "No verificado"}
                {trust.requiresReview ? " · Requiere revisión" : ""}
              </span>
            </li>
          );
        })}
      </ul>
      {result ? (
        <p className={result.status === "applied" ? "assistantOk" : "assistantError"}>
          {result.status === "applied"
            ? `Propuesta aplicada (${result.sections} dominios).`
            : result.message}
        </p>
      ) : mutationsDisabled ? (
        <p className="assistantError">{mutationsDisabledMessage}</p>
      ) : null}
      <button
        disabled={pending || mutationsDisabled || result?.status === "applied"}
        onClick={() =>
          startTransition(async () =>
            setResult(await confirmMixedDocumentProposalAction(proposal.draft)),
          )
        }
        type="button"
      >
        {pending ? "Guardando…" : "Confirmar todo"}
      </button>
    </div>
  );
}
