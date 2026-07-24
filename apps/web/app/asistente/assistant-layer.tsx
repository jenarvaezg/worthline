"use client";

import { useChat } from "@ai-sdk/react";
import { DEMO_DISABLED_MESSAGE } from "@web/demo/write-guard-messages";
import { PremiumNotice } from "@web/entitlements/premium-notice";
import { formatMoneyMinor } from "@worthline/domain";
import type { UIMessage } from "ai";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  useTransition,
} from "react";
import { editCorrectionPoint } from "./anchor-correction-gate";
import {
  extractEmbeddedQuickActions,
  parseBalanceHistoryProposal,
  parseCorrectionProposal,
  parseHoldingCreationProposal,
  parseHoldingTrashProposal,
  parseMixedDocumentProposal,
  parsePropertyValuationProposal,
  parseQuickActions,
  parseReconcileProposal,
  parseStatementImportProposal,
  type QuickAction,
} from "./assistant-actions";
import AssistantAttachmentControl, {
  ASSISTANT_ATTACHMENT_ACCEPT,
} from "./assistant-attachment-control";
import { assistantChatTransport } from "./assistant-chat-transport";
import { AssistantTextPart } from "./assistant-markdown";
import AssistantMessages from "./assistant-messages";
import { parseAttachmentPreviewData } from "./attachment-chat";
import AttachmentExtractionPreview from "./attachment-extraction-preview";
import { balanceCurvePolyline } from "./balance-curve-polyline";
import { confirmBalanceHistoryProposalAction } from "./balance-history-proposal-action";
import type { BalanceHistoryProposal } from "./balance-history-proposal-contract";
import {
  confirmCorrectionProposalAction,
  discardCorrectionProposalAction,
} from "./correction-proposal-action";
import type {
  AnchorOnlyCorrectionProposal,
  CorrectionProposal,
  ReconstructionCorrectionProposal,
} from "./correction-proposal-contract";
import {
  confirmHoldingCreationProposalAction,
  discardHoldingCreationProposalAction,
} from "./holding-creation-proposal-action";
import type { HoldingCreationProposal } from "./holding-creation-proposal-contract";
import {
  holdingTrashImpactHeader,
  holdingTrashWarnings,
} from "./holding-trash-card-model";
import {
  confirmHoldingRemovalProposalAction,
  confirmHoldingRestorationProposalAction,
  discardHoldingRemovalProposalAction,
  discardHoldingRestorationProposalAction,
} from "./holding-trash-proposal-action";
import type { HoldingTrashProposal } from "./holding-trash-proposal-contract";
import { instrumentLabel } from "./instrument-labels";
import { confirmMixedDocumentProposalAction } from "./mixed-document-proposal-action";
import type { MixedDocumentProposal } from "./mixed-document-proposals";
import {
  ProposalAppliedContext,
  useNotifyProposalApplied,
} from "./onboarding-completion";
import { parsePaywallPartData } from "./paywall-part";
import {
  confirmPropertyValuationProposalAction,
  discardPropertyValuationProposalAction,
} from "./property-valuation-proposal-action";
import type { PropertyValuationProposal } from "./property-valuation-proposal-contract";
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
} from "./reconcile-plan";
import {
  confirmReconcileProposalAction,
  discardReconcileProposalAction,
} from "./reconcile-proposal-action";
import {
  type ReconcileCuration,
  type ReconcileProposal,
  reconcileFolio,
} from "./reconcile-proposal-contract";
import {
  deriveScreenContext,
  isAssistantSurface,
  isOnboardingSurface,
  ONBOARDING_RERUN_PARAM,
  type ScreenSection,
} from "./screen-context";
import {
  confirmStatementImportProposalAction,
  discardStatementImportProposalAction,
} from "./statement-import-proposal-action";
import type { StatementImportProposal } from "./statement-import-proposals";
import {
  INITIAL_STATEMENT_PROPOSAL_DISCARD_STATE,
  reduceStatementProposalDiscard,
} from "./statement-proposal-discard-state";
import { suggestedPrompts } from "./suggested-prompts";

/** Human-readable section names for screen-reader context announcements (#633). */
const SECTION_LABEL: Record<ScreenSection, string> = {
  resumen: "Resumen",
  patrimonio: "Patrimonio",
  historico: "Histórico",
  objetivos: "Objetivos",
  ajustes: "Ajustes",
  otra: "worthline",
};

/**
 * The opening turn seeded when the panel is entered in onboarding re-run mode
 * (PRD #1167 S3, #1170) from the /patrimonio shortcut. The `repasar` flag in the
 * URL puts the assistant in the reconcile-first onboarding mode (system prompt),
 * and this first user turn kicks off the flow so the panel is not a silent box.
 */
const ONBOARDING_RERUN_SEED =
  "Quiero repasar mi cartera y ponerla al día con un extracto o documento nuevo.";

/**
 * The typed quick actions the model proposed on the CURRENT turn (#631, ADR
 * 0053): the newest assistant message's `suggest_actions` output, re-validated
 * client-side so only the internal-only typed set ever renders. Older turns'
 * chips fall away as the conversation moves on.
 */
function currentQuickActions(messages: UIMessage[]): QuickAction[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;

    let toolActions: QuickAction[] = [];
    let textActions: QuickAction[] = [];

    for (const part of message.parts) {
      if (part.type === "tool-suggest_actions" && "output" in part) {
        toolActions = parseQuickActions(
          (part.output as { actions?: unknown } | null)?.actions,
        );
      }
      if (part.type === "text" && typeof part.text === "string") {
        textActions = extractEmbeddedQuickActions(part.text).actions;
      }
    }

    if (toolActions.length > 0) return toolActions;
    if (textActions.length > 0) return textActions;
    return [];
  }
  return [];
}

function formatPositionMoney(amountMinor: number): string {
  return formatMoneyMinor({ amountMinor, currency: "EUR" });
}

function ProposalMutationStatus({
  pending,
  result,
}: {
  pending: boolean;
  result: { status: string } | null;
}) {
  // Every proposal card renders this, so it is the one place that sees an
  // `applied` transition for any kind — the onboarding surface listens here to
  // stamp `onboarded_at` on the first confirmed proposal (#1169).
  useNotifyProposalApplied(result?.status);
  return (
    <p aria-live="polite" className="srOnly" role="status">
      {pending ? "Guardando…" : result?.status === "applied" ? "Guardado." : ""}
    </p>
  );
}

/**
 * Alta «por estado actual» (#1105, PRD #1103 S2): the impact header leads
 * (patrimonio neto antes → después), then the holding row, then the informative
 * duplicate warning (never blocks), then Confirmar / Descartar.
 */
function HoldingCreationProposalCard({
  mutationsDisabled,
  mutationsDisabledMessage,
  proposal,
}: {
  mutationsDisabled: boolean;
  mutationsDisabledMessage: string;
  proposal: HoldingCreationProposal;
}) {
  const [result, setResult] = useState<
    | Awaited<ReturnType<typeof confirmHoldingCreationProposalAction>>
    | Awaited<ReturnType<typeof discardHoldingCreationProposalAction>>
    | null
  >(null);
  const [pending, startTransition] = useTransition();
  const settled = result?.status === "applied" || result?.status === "discarded";
  const actionsDisabled = pending || mutationsDisabled || settled;
  const increases = proposal.impact.deltaMinor >= 0;
  const deltaLabel = `${increases ? "+" : "−"}${formatPositionMoney(
    Math.abs(proposal.impact.deltaMinor),
  )}`;
  // `beforeMinor === null` means the net-worth read degraded — show the known
  // delta but never fabricate a total the card never read (ADR 0048).
  const totalKnown =
    proposal.impact.beforeMinor !== null && proposal.impact.afterMinor !== null;
  return (
    <div className="assistantProposal">
      <ProposalMutationStatus pending={pending} result={result} />
      <p className="assistantProposalKind">{proposal.folio}</p>
      {/* Impact first: what confirming does to the household net worth. */}
      <strong>
        {totalKnown
          ? `Patrimonio neto ${formatPositionMoney(
              proposal.impact.beforeMinor as number,
            )} → ${formatPositionMoney(proposal.impact.afterMinor as number)}`
          : `Impacto en el patrimonio: ${deltaLabel} (total no disponible ahora)`}
      </strong>
      <p className={increases ? "assistantOk" : "assistantError"}>{deltaLabel}</p>
      <ul>
        <li>
          <strong>{proposal.holding.name}</strong>{" "}
          <span>
            {proposal.holding.instrumentLabel} · {proposal.holding.detail}
            {proposal.holding.providerSymbol
              ? ` · Símbolo ${proposal.holding.providerSymbol}`
              : ""}
          </span>
        </li>
      </ul>
      {proposal.priceTrackingWarning ? (
        <p className="assistantWarning">{proposal.priceTrackingWarning}</p>
      ) : null}
      {proposal.duplicate ? (
        <p className="assistantError">
          Ya tienes «{proposal.duplicate.name}»
          {proposal.duplicate.confidence === "strong"
            ? " (coincidencia fuerte)"
            : " (mismo nombre)"}
          . Puedes crearlo igualmente si es otro distinto.
        </p>
      ) : null}
      <p className="assistantProposalFolio">{proposal.folio}</p>
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

/**
 * Baja / restauración (#1106, PRD #1103 S3, superficie B): the same anatomy as
 * the alta — impact header leads (patrimonio neto antes → después), then the
 * batch of holdings, then the informative warnings (orphan pair, shared
 * ownership, live-holding duplicate — never block), then Confirmar / Descartar.
 * One card serves both mirror kinds; `operation` picks the server actions and
 * the wording. Display logic lives in the pure `holding-trash-card-model`.
 */
function HoldingTrashProposalCard({
  mutationsDisabled,
  mutationsDisabledMessage,
  proposal,
}: {
  mutationsDisabled: boolean;
  mutationsDisabledMessage: string;
  proposal: HoldingTrashProposal;
}) {
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
      <p className="assistantProposalFolio">{proposal.folio}</p>
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

/** The es-ES fidelity mark a reconcile row shows (decision #1090, ADR 0048). */
function reconcileFidelityMark(fidelity: ReconcileRow["fidelity"]): string {
  if (fidelity === "movements") return "con movimientos";
  if (fidelity === "declared_cost") return "coste declarado";
  return "sin coste real";
}

/** The es-ES decision line a reconcile row shows. */
function reconcileDecisionLabel(row: ReconcileRow): string {
  const decision = effectiveDecision(row);
  if (decision === "leave") return "Dejar";
  if (decision === "create") return `Crear «${row.name}»`;
  const target = row.match.candidates.find((c) => c.holdingId === row.match.target);
  return `Actualizar «${target?.name ?? row.name}»`;
}

/**
 * Reconcile por documento (#1108, PRD #1103 S5): the impact header leads
 * (patrimonio neto antes → después, estimado sobre las altas), then each row with
 * its decision and fidelity tier, reassignable in place (crear ↔ actualizar ↔
 * descartar), never blocking on a doubtful match; folio «Propuesta de reconcile ·
 * N holdings». Reuses the `.assistantProposal` anatomy — no new card. The rows are
 * editable client state; Confirmar sends the curated decisions to the atomic apply.
 */
function ReconcileProposalCard({
  mutationsDisabled,
  mutationsDisabledMessage,
  proposal,
}: {
  mutationsDisabled: boolean;
  mutationsDisabledMessage: string;
  proposal: ReconcileProposal;
}) {
  const [rows, setRows] = useState<ReconcileRow[]>(proposal.rows);
  const [result, setResult] = useState<
    | Awaited<ReturnType<typeof confirmReconcileProposalAction>>
    | Awaited<ReturnType<typeof discardReconcileProposalAction>>
    | null
  >(null);
  const [pending, startTransition] = useTransition();
  const settled = result?.status === "applied" || result?.status === "discarded";
  const actionsDisabled = pending || mutationsDisabled || settled;

  const summary = reconcileSummary(rows);
  const impact = reconcileImpact(rows, proposal.netWorthBeforeMinor);
  const increases = impact.deltaMinor >= 0;
  const deltaLabel = `${increases ? "+" : "−"}${formatPositionMoney(
    Math.abs(impact.deltaMinor),
  )}${impact.partial ? " · estimado sobre las altas" : ""}`;
  const totalKnown = impact.beforeMinor !== null && impact.afterMinor !== null;
  const folio = reconcileFolio(summary.active);

  const curation: ReconcileCuration[] = rows.map((row) => {
    const decision = effectiveDecision(row);
    return decision === "update" && row.match.target
      ? { decision, rowId: row.rowId, target: row.match.target }
      : { decision, rowId: row.rowId };
  });

  return (
    <div className="assistantProposal">
      <ProposalMutationStatus pending={pending} result={result} />
      <p className="assistantProposalKind">{folio}</p>
      <strong>
        {totalKnown
          ? `Patrimonio neto ${formatPositionMoney(
              impact.beforeMinor as number,
            )} → ${formatPositionMoney(impact.afterMinor as number)}`
          : `Impacto en el patrimonio: ${deltaLabel} (total no disponible ahora)`}
      </strong>
      <p className={increases ? "assistantOk" : "assistantError"}>{deltaLabel}</p>
      <ul>
        {rows.map((row) => (
          <li key={row.rowId}>
            <strong>{row.name}</strong>{" "}
            <span>
              {instrumentLabel(row.instrument)} · {reconcileFidelityMark(row.fidelity)} ·{" "}
              {reconcileDecisionLabel(row)}
              {row.uncertain ? " · dudoso" : ""}
              {!row.excluded && !isRowWritable(row) ? " · fuera de alcance" : ""}
            </span>
            <span className="assistantProposalActions">
              {effectiveDecision(row) !== "create" || row.excluded ? (
                <button
                  disabled={actionsDisabled}
                  onClick={() => setRows(reassignRowToNew(rows, row.rowId))}
                  type="button"
                >
                  Crear nuevo
                </button>
              ) : null}
              {row.match.candidates.map((candidate) => (
                <button
                  disabled={actionsDisabled}
                  key={candidate.holdingId}
                  onClick={() =>
                    setRows(reassignRowToCandidate(rows, row.rowId, candidate.holdingId))
                  }
                  type="button"
                >
                  Actualizar «{candidate.name}»
                </button>
              ))}
              {row.excluded ? (
                <button
                  disabled={actionsDisabled}
                  onClick={() => setRows(restoreReconcileRow(rows, row.rowId))}
                  type="button"
                >
                  Recuperar
                </button>
              ) : (
                <button
                  className="secondary"
                  disabled={actionsDisabled}
                  onClick={() => setRows(discardReconcileRow(rows, row.rowId))}
                  type="button"
                >
                  Descartar
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className="assistantProposalFolio">{folio}</p>
      {result ? (
        <p
          aria-live="polite"
          className={result.status === "applied" ? "assistantOk" : "assistantError"}
          role="status"
        >
          {result.status === "applied"
            ? `Cartera cuadrada: ${result.created} creados, ${result.updated} actualizados.`
            : result.status === "discarded"
              ? "Propuesta descartada."
              : result.message}
        </p>
      ) : mutationsDisabled ? (
        <p className="assistantError">{mutationsDisabledMessage}</p>
      ) : null}
      <div className="assistantProposalActions">
        <button
          disabled={actionsDisabled || summary.active === 0}
          onClick={() =>
            startTransition(async () =>
              setResult(await confirmReconcileProposalAction(proposal.draft, curation)),
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
              setResult(await discardReconcileProposalAction(proposal.draft)),
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

function MixedDocumentProposalCard({
  mutationsDisabled,
  mutationsDisabledMessage,
  proposal,
}: {
  mutationsDisabled: boolean;
  mutationsDisabledMessage: string;
  proposal: MixedDocumentProposal;
}) {
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
                  {section.preview.funds.map((fund) => (
                    <span key={fund.isin}>
                      {fund.bucket === "matched"
                        ? fund.existingName
                        : fund.suggestedName || fund.isin}
                      : {fund.executedCount} movimientos · posición{" "}
                      {fund.positionImpact.beforeUnits} → {fund.positionImpact.afterUnits}{" "}
                      ({formatPositionMoney(fund.positionImpact.beforeValueMinor)} →{" "}
                      {formatPositionMoney(fund.positionImpact.afterValueMinor)})
                      {fund.positionImpact.flags.length > 0
                        ? ` · Avisos: ${fund.positionImpact.flags.join(", ")}`
                        : ""}
                    </span>
                  ))}
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

function proposalResultMessage(
  result: { status: string; message?: string; included?: number; created?: number },
  appliedMessage: string,
): string {
  if (result.status === "applied") return appliedMessage;
  return result.message ?? "No se pudo aplicar la propuesta.";
}

function StatementProposalCard({
  mutationsDisabled,
  mutationsDisabledMessage,
  proposal,
}: {
  mutationsDisabled: boolean;
  mutationsDisabledMessage: string;
  proposal: StatementImportProposal;
}) {
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
              {fund.bucket === "matched"
                ? fund.existingName
                : fund.suggestedName || fund.isin}
            </strong>
            <span>
              {fund.bucket === "matched" ? "Existente" : "Nuevo"} · {fund.executedCount}{" "}
              movimientos
            </span>
            <span>
              Posición: {fund.positionImpact.beforeUnits} →{" "}
              {fund.positionImpact.afterUnits} (
              {formatPositionMoney(fund.positionImpact.beforeValueMinor)} →{" "}
              {formatPositionMoney(fund.positionImpact.afterValueMinor)})
            </span>
            {fund.positionImpact.flags.length > 0 ? (
              <span>Avisos: {fund.positionImpact.flags.join(", ")}</span>
            ) : null}
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

/** The guarantee sentence of superficie C «Ancla primero», by gate state. */
function guaranteeMessage(state: CorrectionProposal["guarantee"]["state"]): string {
  switch (state) {
    case "declared":
      return "Hecho declarado por ti — la historia anterior queda intacta.";
    case "reconciled":
      return "Reconciliado con el saldo conocido.";
    case "mismatch":
      return "No cuadra con el saldo conocido — revisa los puntos.";
    case "unverified":
      return "No verificado — revisa cada punto antes de confirmar.";
  }
}

function CorrectionProposalCard({
  mutationsDisabled,
  mutationsDisabledMessage,
  proposal,
}: {
  mutationsDisabled: boolean;
  mutationsDisabledMessage: string;
  proposal: AnchorOnlyCorrectionProposal;
}) {
  const [result, setResult] = useState<
    | Awaited<ReturnType<typeof confirmCorrectionProposalAction>>
    | Awaited<ReturnType<typeof discardCorrectionProposalAction>>
    | null
  >(null);
  const [pending, startTransition] = useTransition();
  const verified =
    proposal.guarantee.state === "declared" || proposal.guarantee.state === "reconciled";
  const settled = result?.status === "applied" || result?.status === "discarded";
  const actionsDisabled = pending || mutationsDisabled || settled;
  return (
    <div className="assistantProposal">
      <ProposalMutationStatus pending={pending} result={result} />
      <p className="assistantProposalKind">Corrección · Solo desde hoy</p>
      <strong>{proposal.summary}</strong>
      {/* Superficie C: the guarantee leads; the point-by-point diff follows. */}
      <p className={verified ? "assistantOk" : "assistantError"}>
        {guaranteeMessage(proposal.guarantee.state)}
      </p>
      <ul>
        {proposal.edits.map((edit, index) => (
          <li key={`${edit.label}-${index}`}>
            <span>{edit.label}</span>{" "}
            <span>
              {edit.before} → {edit.after}
            </span>
            <span>
              {edit.origin === "user" ? "Corregido por ti" : "Propuesto por el asistente"}
            </span>
          </li>
        ))}
      </ul>
      <p className="assistantProposalFolio">{proposal.folio}</p>
      {result ? (
        <p
          aria-live="polite"
          className={result.status === "applied" ? "assistantOk" : "assistantError"}
          role="status"
        >
          {result.status === "applied"
            ? "Corrección aplicada."
            : result.status === "discarded"
              ? "Propuesta descartada."
              : result.message}
        </p>
      ) : mutationsDisabled ? (
        <p className="assistantError">{mutationsDisabledMessage}</p>
      ) : null}
      <div className="assistantProposalActions">
        <button
          disabled={actionsDisabled || !verified}
          onClick={() =>
            startTransition(async () =>
              setResult(await confirmCorrectionProposalAction(proposal.draft)),
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

/**
 * Superficie C «Ancla primero», reconstruct depth (#1053): the guarantee leads,
 * an orienting stepped curve follows, and the point-by-point series is folded
 * below with per-point amount edit / exclusion. The confirm gate (canConfirm) and
 * the exclusions/edits run through the pure `anchor-correction-gate` module; the
 * confirm re-sends the kept series so the server re-projects it against live data.
 */
function ReconstructionProposalCard({
  mutationsDisabled,
  mutationsDisabledMessage,
  proposal,
}: {
  mutationsDisabled: boolean;
  mutationsDisabledMessage: string;
  proposal: ReconstructionCorrectionProposal;
}) {
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

  // Pristine, the engine's reconciliation from the build is both the guarantee
  // and the gate. After an edit the strong check moves fully server-side — the
  // confirm re-projects the kept series and reconciles its endpoint against live
  // data (a naive last-point check would wrongly block a statement dated before
  // today), so we allow the attempt whenever a point remains and surface the
  // server's verdict in the result.
  const verified = !dirty && proposal.guarantee.state === "reconciled";
  const canConfirm = dirty
    ? editedRows.length > 0
    : proposal.guarantee.state === "reconciled";
  const settled = result?.status === "applied" || result?.status === "discarded";
  const actionsDisabled = pending || mutationsDisabled || settled;

  return (
    <div className="assistantProposal">
      <ProposalMutationStatus pending={pending} result={result} />
      <p className="assistantProposalKind">Corrección · Reconstruir historia</p>
      <strong>{proposal.summary}</strong>
      {/* Superficie C: the guarantee leads, the point-by-point detail folds below. */}
      <p className={verified ? "assistantOk" : dirty ? "" : "assistantError"}>
        {dirty
          ? "Editaste la serie — se recomprobará con el motor al confirmar."
          : guaranteeMessage(proposal.guarantee.state)}
      </p>
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
      {!dirty && "resultingMinor" in proposal.guarantee ? (
        <p>
          Reconciliación:{" "}
          {proposal.guarantee.resultingMinor === null
            ? "—"
            : formatPositionMoney(proposal.guarantee.resultingMinor)}{" "}
          / {formatPositionMoney(proposal.anchorMinor)} ·{" "}
          {proposal.guarantee.state === "reconciled"
            ? "Cuadra en el extremo"
            : "No cuadra en el extremo"}
        </p>
      ) : null}
      <details>
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
      {result ? (
        <p
          aria-live="polite"
          className={result.status === "applied" ? "assistantOk" : "assistantError"}
          role="status"
        >
          {result.status === "applied"
            ? "Historia reconstruida."
            : result.status === "discarded"
              ? "Propuesta descartada."
              : result.message}
        </p>
      ) : mutationsDisabled ? (
        <p className="assistantError">{mutationsDisabledMessage}</p>
      ) : null}
      <div className="assistantProposalActions">
        <button
          disabled={actionsDisabled || !canConfirm || editedRows.length === 0}
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

function BalanceHistoryProposalCard({
  mutationsDisabled,
  mutationsDisabledMessage,
  proposal,
}: {
  mutationsDisabled: boolean;
  mutationsDisabledMessage: string;
  proposal: BalanceHistoryProposal;
}) {
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof confirmBalanceHistoryProposalAction>
  > | null>(null);
  const [pending, startTransition] = useTransition();
  const confirmDisabled =
    pending ||
    mutationsDisabled ||
    !proposal.reconciliation.matches ||
    result?.status === "applied";
  return (
    <div className="assistantProposal">
      <ProposalMutationStatus pending={pending} result={result} />
      <p className="assistantProposalKind">Propuesta de historial de deuda</p>
      <strong>{proposal.liability.name}</strong>
      <svg
        aria-label="Curva resultante del saldo de la deuda"
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
      <ul>
        {proposal.points.map((point) => (
          <li key={point.date}>
            <span>{point.date}</span>{" "}
            <span>{formatPositionMoney(point.balanceMinor)}</span>
            <span>
              {point.status === "accepted"
                ? "Incluido"
                : point.status === "skipped"
                  ? "Ya existente"
                  : `Excluido: ${point.reason ?? "saldo no aplicable"}`}
              {point.driftMinor === null
                ? ""
                : ` · Desvío ${formatPositionMoney(point.driftMinor)}`}
            </span>
          </li>
        ))}
      </ul>
      <p>
        Reconciliación: {formatPositionMoney(proposal.reconciliation.resultingMinor)} /{" "}
        {formatPositionMoney(proposal.reconciliation.expectedMinor)} ·{" "}
        {proposal.reconciliation.matches ? "Cuadra exactamente" : "No cuadra"}
      </p>
      {result ? (
        <p
          aria-live="polite"
          className={result.status === "applied" ? "assistantOk" : "assistantError"}
          role="status"
        >
          {result.status === "applied"
            ? `Historial aplicado (${result.created} saldos).`
            : result.message}
        </p>
      ) : mutationsDisabled ? (
        <p className="assistantError">{mutationsDisabledMessage}</p>
      ) : null}
      <button
        disabled={confirmDisabled}
        onClick={() =>
          startTransition(async () =>
            setResult(await confirmBalanceHistoryProposalAction(proposal.draft)),
          )
        }
        type="button"
      >
        {pending ? "Guardando…" : "Confirmar"}
      </button>
    </div>
  );
}

function PropertyValuationProposalCard({
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

/**
 * The rendered conversation turns — message parts and the proposal cards they
 * unfold into. Extracted so the floating panel (#628) and the full-screen
 * onboarding surface (#1168) render the SAME turns with zero duplication: every
 * proposal the assistant learns to make surfaces in onboarding for free.
 */
function ConversationParts({
  messages,
  error,
  mutationsDisabled,
  mutationsDisabledMessage,
  endRef,
}: {
  messages: UIMessage[];
  error: Error | undefined;
  mutationsDisabled: boolean;
  mutationsDisabledMessage: string;
  endRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <>
      {messages.map((message) => (
        <div className={`assistantMsg ${message.role}`} key={message.id}>
          {message.parts.map((part, i) => {
            if (part.type === "text") {
              const { cleaned } = extractEmbeddedQuickActions(part.text);
              return (
                <AssistantTextPart
                  key={`${message.id}-${i}`}
                  role={message.role}
                  text={cleaned}
                />
              );
            }
            if (part.type === "data-attachment-extraction") {
              const preview = parseAttachmentPreviewData(part.data);
              return preview ? (
                <AttachmentExtractionPreview
                  key={`${message.id}-${i}`}
                  preview={preview}
                />
              ) : null;
            }
            if (part.type === "data-paywall") {
              const paywall = parsePaywallPartData(part.data);
              return paywall ? (
                <PremiumNotice key={`${message.id}-${i}`} message={paywall.message} />
              ) : null;
            }
            if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
              const name =
                "toolName" in part ? String(part.toolName) : part.type.slice(5);
              // suggest_actions renders as chips below, not as tool activity.
              if (name === "suggest_actions") return null;
              if (name === "propose_statement_import" && "output" in part) {
                const proposal = parseStatementImportProposal(part.output);
                return proposal ? (
                  <StatementProposalCard
                    key={`${message.id}-${i}`}
                    mutationsDisabled={mutationsDisabled}
                    mutationsDisabledMessage={mutationsDisabledMessage}
                    proposal={proposal}
                  />
                ) : null;
              }
              if (
                (name === "propose_correction" || name === "propose_reconstruction") &&
                "output" in part
              ) {
                const proposal = parseCorrectionProposal(part.output);
                if (!proposal) return null;
                return proposal.mode === "reconstruir" ? (
                  <ReconstructionProposalCard
                    key={`${message.id}-${i}`}
                    mutationsDisabled={mutationsDisabled}
                    mutationsDisabledMessage={mutationsDisabledMessage}
                    proposal={proposal}
                  />
                ) : (
                  <CorrectionProposalCard
                    key={`${message.id}-${i}`}
                    mutationsDisabled={mutationsDisabled}
                    mutationsDisabledMessage={mutationsDisabledMessage}
                    proposal={proposal}
                  />
                );
              }
              if (name === "propose_holding" && "output" in part) {
                const proposal = parseHoldingCreationProposal(part.output);
                return proposal ? (
                  <HoldingCreationProposalCard
                    key={`${message.id}-${i}`}
                    mutationsDisabled={mutationsDisabled}
                    mutationsDisabledMessage={mutationsDisabledMessage}
                    proposal={proposal}
                  />
                ) : null;
              }
              if (name === "propose_holding_removal" && "output" in part) {
                const proposal = parseHoldingTrashProposal(
                  part.output,
                  "holding_removal",
                );
                return proposal ? (
                  <HoldingTrashProposalCard
                    key={`${message.id}-${i}`}
                    mutationsDisabled={mutationsDisabled}
                    mutationsDisabledMessage={mutationsDisabledMessage}
                    proposal={proposal}
                  />
                ) : null;
              }
              if (name === "propose_holding_restoration" && "output" in part) {
                const proposal = parseHoldingTrashProposal(
                  part.output,
                  "holding_restoration",
                );
                return proposal ? (
                  <HoldingTrashProposalCard
                    key={`${message.id}-${i}`}
                    mutationsDisabled={mutationsDisabled}
                    mutationsDisabledMessage={mutationsDisabledMessage}
                    proposal={proposal}
                  />
                ) : null;
              }
              if (name === "propose_balance_history_import" && "output" in part) {
                const proposal = parseBalanceHistoryProposal(part.output);
                return proposal ? (
                  <BalanceHistoryProposalCard
                    key={`${message.id}-${i}`}
                    mutationsDisabled={mutationsDisabled}
                    mutationsDisabledMessage={mutationsDisabledMessage}
                    proposal={proposal}
                  />
                ) : null;
              }
              if (name === "propose_property_valuation_anchor" && "output" in part) {
                const proposal = parsePropertyValuationProposal(part.output);
                return proposal ? (
                  <PropertyValuationProposalCard
                    key={`${message.id}-${i}`}
                    mutationsDisabled={mutationsDisabled}
                    proposal={proposal}
                  />
                ) : null;
              }
              if (name === "propose_reconcile" && "output" in part) {
                const proposal = parseReconcileProposal(part.output);
                return proposal ? (
                  <ReconcileProposalCard
                    key={`${message.id}-${i}`}
                    mutationsDisabled={mutationsDisabled}
                    mutationsDisabledMessage={mutationsDisabledMessage}
                    proposal={proposal}
                  />
                ) : null;
              }
              if (name === "propose_mixed_document_import" && "output" in part) {
                const proposal = parseMixedDocumentProposal(part.output);
                return proposal ? (
                  <MixedDocumentProposalCard
                    key={`${message.id}-${i}`}
                    mutationsDisabled={mutationsDisabled}
                    mutationsDisabledMessage={mutationsDisabledMessage}
                    proposal={proposal}
                  />
                ) : null;
              }
              // Read tools run silently; only proposal cards surface tool activity.
              return null;
            }
            return null;
          })}
        </div>
      ))}
      {error ? (
        <p className="assistantError" role="alert">
          El asistente no ha podido responder. Vuelve a intentarlo.
        </p>
      ) : null}
      <div ref={endRef} />
    </>
  );
}

/**
 * The message composer: attachment control plus the text input row. Shared by
 * the floating panel and the onboarding surface (#1168).
 */
function Composer({
  busy,
  attachment,
  setAttachment,
  draft,
  setDraft,
  inputRef,
  onSubmit,
  placeholder,
}: {
  busy: boolean;
  attachment: File | null;
  setAttachment: (file: File | null) => void;
  draft: string;
  setDraft: (value: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSubmit: (e: React.FormEvent) => void;
  placeholder: string;
}) {
  return (
    <form className="assistantComposer" onSubmit={onSubmit}>
      <AssistantAttachmentControl
        disabled={busy}
        file={attachment}
        onChange={setAttachment}
        onRemove={() => setAttachment(null)}
      />
      <div className="assistantInputRow">
        <input
          aria-label="Mensaje para el asistente"
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          ref={inputRef}
          value={draft}
        />
        <button
          disabled={busy || (draft.trim() === "" && attachment === null)}
          type="submit"
        >
          Enviar
        </button>
      </div>
    </form>
  );
}

/**
 * The financial assistant's contextual layer (#629, container decided in S0
 * #628): a FAB opens an overlay side panel (desktop) / bottom sheet (mobile)
 * that survives in-app navigation because it mounts in the root layout. The
 * conversation is ephemeral — client state only, nothing persisted (#627).
 *
 * On the dedicated onboarding route (#1168) the SAME layer renders a full-screen
 * «estreno» presentation instead — a dominant drop-zone, a welcome first turn,
 * and two deliberately discreet escapes («a mano» / «lo haré luego»). It reuses
 * the conversation and composer above, so anything the assistant learns to
 * propose enriches onboarding for free (the whole point of «cero motor nuevo»).
 *
 * Styles live in globals.css (`assistant*` / `onboarding*` classes, tokens).
 */

export default function AssistantLayer({
  mutationsDisabled = false,
  mutationsDisabledMessage = DEMO_DISABLED_MESSAGE,
  variant = "floating",
  onboardingManualHref = "/patrimonio/anadir",
  onboardingSkipAction,
  onboardingCompleteAction,
}: {
  mutationsDisabled?: boolean;
  mutationsDisabledMessage?: string;
  variant?: "floating" | "onboarding";
  onboardingManualHref?: string;
  onboardingSkipAction?: (formData: FormData) => void | Promise<void>;
  onboardingCompleteAction?: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const { messages, sendMessage, status, error } = useChat({
    transport: assistantChatTransport,
  });
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rerunRequested = searchParams.get(ONBOARDING_RERUN_PARAM) === "1";
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  // Set the instant BEFORE we close so focus returns to the trigger, not the
  // top of the page — but never steals focus on first mount (#633, a11y).
  const closingRef = useRef(false);

  const busy = status === "submitted" || status === "streaming";
  const quickActions = currentQuickActions(messages);
  // Prompts depend only on the section, which comes from the pathname; recomputed
  // on every navigation so the starter set matches the surface underneath (#632).
  const section = deriveScreenContext(pathname, "").section;
  const prompts = suggestedPrompts({
    route: pathname,
    section,
    holdingId: null,
    view: {},
  });

  const close = useCallback(() => {
    closingRef.current = true;
    setOpen(false);
  }, []);

  // Stamp `onboarded_at` on the first confirmed proposal (#1169). Guarded to fire
  // the set-once mark at most once per session, even if several cards apply; the
  // server action is itself idempotent (COALESCE), so this is belt-and-braces.
  const onboardedRef = useRef(false);
  const handleProposalApplied = useCallback(() => {
    if (onboardedRef.current || !onboardingCompleteAction) return;
    onboardedRef.current = true;
    void onboardingCompleteAction();
  }, [onboardingCompleteAction]);

  function seed(text: string) {
    if (busy) return;
    void sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }

  function runAction(action: QuickAction) {
    if (action.type === "openInternalSource") {
      // Client navigation only — the panel is mounted in the root layout, so the
      // conversation survives the route change underneath it (S0 decision).
      router.push(action.href);
      return;
    }
    seed(action.prompt);
  }

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else if (closingRef.current) {
      fabRef.current?.focus();
      closingRef.current = false;
    }
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the conversation grows or settles
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, status, error]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, open]);

  useEffect(() => {
    if (!isAssistantSurface(pathname) && open) setOpen(false);
  }, [open, pathname]);

  // Re-run onboarding entry (#1170): the /patrimonio shortcut navigates here with
  // `?repasar=1`, which puts the turn in the reconcile-first onboarding mode (the
  // system prompt derives it from the flag in the screen context). Open the panel
  // and, on a fresh conversation, seed the opening turn so it is not a silent box.
  // The flag is a ONE-SHOT activation: once consumed we strip it from the URL so
  // the re-run framing does not stick to every later /patrimonio turn. Since the
  // transport reads `window.location` directly, this takes effect on the next
  // turn. Never in the onboarding variant — the /bienvenida estreno surface owns
  // its own full-screen entry.
  const rerunConsumedRef = useRef(false);
  useEffect(() => {
    if (variant !== "floating" || !rerunRequested || rerunConsumedRef.current) return;
    rerunConsumedRef.current = true;
    setOpen(true);
    if (messages.length === 0) {
      void sendMessage({
        role: "user",
        parts: [{ type: "text", text: ONBOARDING_RERUN_SEED }],
      });
    }
    const url = new URL(window.location.href);
    url.searchParams.delete(ONBOARDING_RERUN_PARAM);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [rerunRequested, variant, messages.length, sendMessage]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if ((text === "" && attachment === null) || busy) return;
    const selectedAttachment = attachment;
    const visibleText =
      text || (selectedAttachment ? `Adjunto: ${selectedAttachment.name}` : "");
    void sendMessage(
      { role: "user", parts: [{ type: "text", text: visibleText }] },
      selectedAttachment ? { body: { attachment: selectedAttachment } } : undefined,
    );
    setDraft("");
    setAttachment(null);
  }

  // The onboarding drop-zone is the hero action (#1168): a dropped document
  // sends straight away, so arriving with a statement in hand needs no typing.
  function sendAttachment(file: File) {
    if (busy) return;
    void sendMessage(
      { role: "user", parts: [{ type: "text", text: `Adjunto: ${file.name}` }] },
      { body: { attachment: file } },
    );
  }

  if (variant === "onboarding") {
    const hasConversation = messages.length > 0;
    return (
      <main aria-label="Bienvenida a worthline" className="onboardingSurface">
        <p aria-live="polite" className="srOnly" role="status">
          {busy
            ? "El asistente está respondiendo."
            : "Onboarding de worthline. Arrastra tus extractos o cuéntame qué tienes."}
        </p>

        <header className="coverSurface coverMasthead onboardingMasthead">
          <p className="empezarEyebrow">Patrimonio neto</p>
          <h1>worthline</h1>
        </header>

        <div className="onboardingBody">
          {hasConversation ? null : (
            <div className="onboardingWelcome">
              <h2>Vamos a componer tu patrimonio.</h2>
              <p>
                Arrastra aquí tus extractos, PDFs o tu Excel —o cuéntame qué tienes— y lo
                convierto en tu patrimonio, contigo, en unos minutos.
              </p>

              <label
                className={`onboardingDrop${dragActive ? " dragging" : ""}`}
                htmlFor="onboarding-drop-input"
                onDragLeave={() => setDragActive(false)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragActive(false);
                  const file = e.dataTransfer.files?.[0];
                  if (file) sendAttachment(file);
                }}
              >
                <span className="onboardingDropTitle">
                  Arrastra un documento o pulsa para elegirlo
                </span>
                <span className="onboardingDropHint">
                  Captura, CSV, XLSX o PDF de tu banco o bróker
                </span>
                <input
                  accept={ASSISTANT_ATTACHMENT_ACCEPT}
                  className="srOnly"
                  disabled={busy}
                  id="onboarding-drop-input"
                  onChange={(e) => {
                    const file = e.currentTarget.files?.[0];
                    if (file) sendAttachment(file);
                  }}
                  type="file"
                  value=""
                />
              </label>

              {prompts.length > 0 ? (
                <div
                  aria-label="O cuéntamelo por escrito"
                  className="assistantPrompts"
                  role="group"
                >
                  {prompts.map((p) => (
                    <button
                      className="assistantChip"
                      key={p.id}
                      onClick={() => seed(p.prompt)}
                      type="button"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )}

          <AssistantMessages>
            {/* Confirming the first proposal here stamps onboarded (#1169); the
                floating panel provides no listener, so it never fires there. */}
            <ProposalAppliedContext.Provider value={handleProposalApplied}>
              <ConversationParts
                endRef={endRef}
                error={error}
                messages={messages}
                mutationsDisabled={mutationsDisabled}
                mutationsDisabledMessage={mutationsDisabledMessage}
              />
            </ProposalAppliedContext.Provider>
          </AssistantMessages>

          {quickActions.length > 0 ? (
            <div
              aria-label="Acciones sugeridas"
              className="assistantActions"
              role="group"
            >
              {quickActions.map((action, i) => (
                <button
                  className={`assistantChip ${action.type}`}
                  key={`${action.label}-${i}`}
                  onClick={() => runAction(action)}
                  type="button"
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}

          <Composer
            attachment={attachment}
            busy={busy}
            draft={draft}
            inputRef={inputRef}
            onSubmit={submit}
            placeholder="Cuéntame qué tienes…"
            setAttachment={setAttachment}
            setDraft={setDraft}
          />

          {/* Escapes deliberadamente discretos (#1130): a mano y «lo haré luego».
              Nunca un «plan B» ruidoso; siempre accesibles. */}
          <nav aria-label="Otras formas de empezar" className="onboardingEscapes">
            <Link href={onboardingManualHref}>Prefiero cargarlo a mano</Link>
            {onboardingSkipAction ? (
              <form action={onboardingSkipAction}>
                <button type="submit">Lo haré luego</button>
              </form>
            ) : (
              <Link href="/app">Lo haré luego</Link>
            )}
          </nav>
        </div>
      </main>
    );
  }

  // The floating layer never shows on the onboarding route — that surface is the
  // onboarding variant above, mounted by the route itself.
  if (!isAssistantSurface(pathname) || isOnboardingSurface(pathname)) {
    return null;
  }

  if (!open) {
    return (
      <button
        aria-label="Abrir asistente"
        className="assistantFab"
        onClick={() => setOpen(true)}
        ref={fabRef}
        type="button"
      >
        ✳
      </button>
    );
  }

  return (
    <section aria-label="Asistente financiero" className="assistantPanel" role="dialog">
      {/* Polite live region: announces streaming and the current screen context
          so the layer is not a silent state change for screen readers (#633). */}
      <p aria-live="polite" className="srOnly" role="status">
        {busy
          ? "El asistente está respondiendo."
          : `Asistente abierto sobre ${SECTION_LABEL[section]}.`}
      </p>

      <header className="assistantHead">
        <h2>Asistente</h2>
        <button aria-label="Cerrar asistente" onClick={close} type="button">
          ×
        </button>
      </header>

      <AssistantMessages>
        {messages.length === 0 ? (
          <div className="assistantHint">
            <p>Pregunta sobre tu patrimonio: cifras, deudas, liquidez, exposición…</p>
            <div
              aria-label="Preguntas sugeridas"
              className="assistantPrompts"
              role="group"
            >
              {prompts.map((p) => (
                <button
                  className="assistantChip"
                  key={p.id}
                  onClick={() => seed(p.prompt)}
                  type="button"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <ConversationParts
          endRef={endRef}
          error={error}
          messages={messages}
          mutationsDisabled={mutationsDisabled}
          mutationsDisabledMessage={mutationsDisabledMessage}
        />
      </AssistantMessages>

      {quickActions.length > 0 ? (
        <div aria-label="Acciones sugeridas" className="assistantActions" role="group">
          {quickActions.map((action, i) => (
            <button
              className={`assistantChip ${action.type}`}
              key={`${action.label}-${i}`}
              onClick={() => runAction(action)}
              type="button"
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}

      <Composer
        attachment={attachment}
        busy={busy}
        draft={draft}
        inputRef={inputRef}
        onSubmit={submit}
        placeholder="Pregunta sobre esta pantalla…"
        setAttachment={setAttachment}
        setDraft={setDraft}
      />
    </section>
  );
}
