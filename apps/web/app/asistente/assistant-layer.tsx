"use client";

import { useChat } from "@ai-sdk/react";
import { DEMO_DISABLED_MESSAGE } from "@web/demo/write-guard-messages";
import { PremiumNotice } from "@web/entitlements/premium-notice";
import { formatMoneyMinor } from "@worthline/domain";
import type { UIMessage } from "ai";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useTransition,
} from "react";
import { computeCorrectionGate, editCorrectionPoint } from "./anchor-correction-gate";
import {
  extractEmbeddedQuickActions,
  parseBalanceHistoryProposal,
  parseCorrectionProposal,
  parseEarlyRepaymentProposal,
  parseHoldingCreationProposal,
  parseHoldingTrashProposal,
  parseMixedDocumentProposal,
  parseOperationProposal,
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
import { assistantErrorMessage } from "./assistant-error-message";
import { AssistantTextPart } from "./assistant-markdown";
import AssistantMessages from "./assistant-messages";
import { assistantPendingLabel } from "./assistant-pending";
import { parseAttachmentPreviewCard } from "./attachment-chat";
import AttachmentExtractionPreview from "./attachment-extraction-preview";
import { userTurnText } from "./attachment-notice";
import { balanceCurvePolyline } from "./balance-curve-polyline";
import { confirmBalanceHistoryProposalAction } from "./balance-history-proposal-action";
import type { BalanceHistoryProposal } from "./balance-history-proposal-contract";
import {
  anchorDriftSentence,
  reconciliationSentence,
  redeclarationSentence,
} from "./balance-reconciliation";
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
  confirmEarlyRepaymentProposalAction,
  discardEarlyRepaymentProposalAction,
} from "./early-repayment-proposal-action";
import type { EarlyRepaymentProposal } from "./early-repayment-proposal-contract";
import {
  FABRICATED_PROPOSAL_NOTE,
  messagesWithFabricatedProposal,
} from "./fabricated-proposal";
import {
  confirmHoldingCreationProposalAction,
  discardHoldingCreationProposalAction,
} from "./holding-creation-proposal-action";
import type { HoldingCreationProposal } from "./holding-creation-proposal-contract";
import { labelsByPublicHoldingId } from "./holding-id-prose";
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
import {
  confirmOperationProposalAction,
  discardOperationProposalAction,
} from "./operation-proposal-action";
import type { OperationProposal } from "./operation-proposal-contract";
import { parsePaywallPartData } from "./paywall-part";
import {
  confirmPropertyValuationProposalAction,
  discardPropertyValuationProposalAction,
} from "./property-valuation-proposal-action";
import type { PropertyValuationProposal } from "./property-valuation-proposal-contract";
import { proposalImpactHeader } from "./proposal-impact-header";
import {
  hasUnvalidatedProvenance,
  UNVALIDATED_PROVENANCE_LABEL,
  UNVALIDATED_PROVENANCE_NOTE,
} from "./proposal-provenance";
import { mergeQuickActions, splitProseActionBlock } from "./prose-actions";
import QuickActionChips from "./quick-action-chips";
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
  reconcileAmbiguityMark,
  reconcileDestinationLabel,
  reconcileDocumentLine,
  reconcileFidelityMark,
  reconcileImpactCaption,
  reconcileMovementLine,
} from "./reconcile-row-copy";
import { withoutRepeatedProse } from "./repeated-prose";
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

/** The `suggest_actions` output of ONE message, re-validated client-side. */
function toolQuickActions(message: UIMessage): QuickAction[] {
  let actions: QuickAction[] = [];
  for (const part of message.parts) {
    if (part.type === "tool-suggest_actions" && "output" in part) {
      actions = parseQuickActions((part.output as { actions?: unknown } | null)?.actions);
    }
  }
  return actions;
}

/**
 * The prose of one text part with both duplicate action channels removed, and the
 * chips recovered from them: the trailing `{"actions":[…]}` JSON some turns print
 * instead of calling the tool, and the «Acciones recomendadas:» markdown list the
 * model writes ALONGSIDE the tool call. `toolActions` are that same message's
 * chips, which is how a bullet repeating one of them resolves to it.
 */
function proseAndActions(
  text: string,
  toolActions: readonly QuickAction[],
): { cleaned: string; prose: QuickAction[]; embedded: QuickAction[] } {
  const embedded = extractEmbeddedQuickActions(text);
  const prose = splitProseActionBlock(embedded.cleaned, toolActions);
  return { cleaned: prose.cleaned, prose: prose.actions, embedded: embedded.actions };
}

/**
 * The prose to print for each text part of ONE turn, by part index.
 *
 * Two trims, in the order the reader's eye needs them: each part loses its duplicate
 * action channels, and then the TURN loses the blocks it wrote twice (#1317) — a
 * proposal turn restates its whole summary in the step the SDK opens after
 * `suggest_actions`. De-duplicating the CLEANED text is what makes the two agree: an
 * action block trimmed off one copy must not be what stops it from matching the other.
 *
 * Assistant turns only. The user's own words are never reinterpreted (#1047), and a
 * person who repeats themselves is not a defect to correct.
 */
function printableProseByPart(
  message: UIMessage,
  toolActions: readonly QuickAction[],
): Map<number, string> {
  const indices: number[] = [];
  const cleaned: string[] = [];
  message.parts.forEach((part, index) => {
    if (part.type !== "text") return;
    indices.push(index);
    cleaned.push(proseAndActions(part.text, toolActions).cleaned);
  });
  const printable =
    message.role === "assistant" ? withoutRepeatedProse(cleaned) : cleaned;
  return new Map(indices.map((index, at) => [index, printable[at] ?? ""]));
}

/**
 * The typed quick actions the model proposed on the CURRENT turn (#631, ADR
 * 0053): the newest assistant message's `suggest_actions` output, re-validated
 * client-side so only the internal-only typed set ever renders. Older turns'
 * chips fall away as the conversation moves on.
 *
 * The prose block goes FIRST in the merge: those are the follow-ups in the order
 * the reader just read them, and the ones they repeat collapse onto the tool's own
 * chips rather than showing twice.
 */
function currentQuickActions(messages: UIMessage[]): QuickAction[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;

    const toolActions = toolQuickActions(message);
    let prose: QuickAction[] = [];
    let embedded: QuickAction[] = [];

    for (const part of message.parts) {
      if (part.type === "text" && typeof part.text === "string") {
        ({ prose, embedded } = proseAndActions(part.text, toolActions));
      }
    }

    // The embedded JSON stays what it always was — a fallback for the turn that
    // printed its actions instead of calling the tool, never an addition to them.
    const fromText = prose.length > 0 ? prose : toolActions.length > 0 ? [] : embedded;
    return mergeQuickActions(fromText, toolActions);
  }
  return [];
}

function formatPositionMoney(amountMinor: number): string {
  return formatMoneyMinor({ amountMinor, currency: "EUR" });
}

/**
 * What a card says about a fund the confirm will leave OUT because its identifier
 * names more than one holding (#1366). The chat has nowhere to ask "which of the
 * two is it", and confirming would let the file overwrite the wrong broker's
 * history — so the fund is left out, the card points at the surface where the
 * choice exists, and it prints NONE of the fund's figures: they all belong to the
 * first candidate, the very default this fix exists to stop passing off as the
 * answer.
 */
function ambiguousFundNote(isin: string, claimants: number): string {
  return `${isin} está en ${claimants} de tus inversiones: se queda fuera — elige cuál en Importar extracto.`;
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
  const caption = reconcileImpactCaption(impact);
  const header = proposalImpactHeader(impact, formatPositionMoney, {
    ...(caption ? { caption } : {}),
  });
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
          Descartar la propuesta
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
function EarlyRepaymentProposalCard({
  mutationsDisabled,
  mutationsDisabledMessage,
  proposal,
}: {
  mutationsDisabled: boolean;
  mutationsDisabledMessage: string;
  proposal: EarlyRepaymentProposal;
}) {
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
function OperationProposalCard({
  mutationsDisabled,
  mutationsDisabledMessage,
  proposal,
}: {
  mutationsDisabled: boolean;
  mutationsDisabledMessage: string;
  proposal: OperationProposal;
}) {
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
  const canConfirm = gate.canConfirm;
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
  // La misma puerta de #1422, en la otra lane del mismo documento: exigir que el
  // extremo cuadre para dejar confirmar dejaba el botón muerto sin salida ninguna.
  // El veredicto se dice; aplicar es decisión del usuario.
  const confirmDisabled = pending || mutationsDisabled || result?.status === "applied";
  const balanceHistoryDrift = anchorDriftSentence(
    proposal.reconciliation,
    formatPositionMoney,
  );
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
        {formatPositionMoney(proposal.reconciliation.expectedMinor)}
      </p>
      <p className={proposal.reconciliation.matches ? "assistantOk" : "assistantWarning"}>
        {reconciliationSentence(proposal.reconciliation, formatPositionMoney)}
      </p>
      {balanceHistoryDrift === null ? null : (
        <p className="assistantWarning">{balanceHistoryDrift}</p>
      )}
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
 * The app contradicting its own assistant (#1262).
 *
 * Printed when a turn CLAIMS to have prepared a proposal and carries none. It is
 * the app speaking, not the model, so it is set apart the way a proposal is — a
 * paper entry opened by a heavy rule (canon §4) — and labelled in words, never by
 * colour alone (canon §6: oro = aviso).
 */
function FabricatedProposalNote() {
  return (
    <div className="assistantFakeProposal" role="note">
      <p className="assistantWarning">
        <strong>Aviso de worthline.</strong> {FABRICATED_PROPOSAL_NOTE}
      </p>
    </div>
  );
}

/**
 * The proposal card a tool answer unfolds into, or `null` when the answer is not a
 * proposal (every read tool runs silently) or does not parse as one.
 *
 * A plain function and not a component because the caller has to KNOW there is a
 * card before deciding what to wrap it in: the provenance mark of #1257 opens a
 * paper entry, and an entry with a stamp and no card would be the app pointing at
 * nothing.
 */
function proposalCardFor({
  mutationsDisabled,
  mutationsDisabledMessage,
  name,
  part,
}: {
  mutationsDisabled: boolean;
  mutationsDisabledMessage: string;
  name: string;
  part: UIMessage["parts"][number];
}): React.ReactNode | null {
  if (name === "propose_statement_import" && "output" in part) {
    const proposal = parseStatementImportProposal(part.output);
    return proposal ? (
      <StatementProposalCard
        mutationsDisabled={mutationsDisabled}
        mutationsDisabledMessage={mutationsDisabledMessage}
        proposal={proposal}
      />
    ) : null;
  }
  if (
    (name === "propose_correction" ||
      name === "propose_reconstruction" ||
      // Una enmienda (#1423) devuelve la MISMA propuesta de corrección, con la
      // serie enmendada: su tarjeta es la de siempre, o no habría tarjeta.
      name === "propose_reconstruction_amendment") &&
    "output" in part
  ) {
    const proposal = parseCorrectionProposal(part.output);
    if (!proposal) return null;
    return proposal.mode === "reconstruir" ? (
      <ReconstructionProposalCard
        mutationsDisabled={mutationsDisabled}
        mutationsDisabledMessage={mutationsDisabledMessage}
        proposal={proposal}
      />
    ) : (
      <CorrectionProposalCard
        mutationsDisabled={mutationsDisabled}
        mutationsDisabledMessage={mutationsDisabledMessage}
        proposal={proposal}
      />
    );
  }
  if (name === "propose_early_repayment" && "output" in part) {
    const proposal = parseEarlyRepaymentProposal(part.output);
    return proposal ? (
      <EarlyRepaymentProposalCard
        mutationsDisabled={mutationsDisabled}
        mutationsDisabledMessage={mutationsDisabledMessage}
        proposal={proposal}
      />
    ) : null;
  }
  if (name === "propose_operation" && "output" in part) {
    const proposal = parseOperationProposal(part.output);
    return proposal ? (
      <OperationProposalCard
        mutationsDisabled={mutationsDisabled}
        mutationsDisabledMessage={mutationsDisabledMessage}
        proposal={proposal}
      />
    ) : null;
  }
  if (name === "propose_holding" && "output" in part) {
    const proposal = parseHoldingCreationProposal(part.output);
    return proposal ? (
      <HoldingCreationProposalCard
        mutationsDisabled={mutationsDisabled}
        mutationsDisabledMessage={mutationsDisabledMessage}
        proposal={proposal}
      />
    ) : null;
  }
  if (name === "propose_holding_removal" && "output" in part) {
    const proposal = parseHoldingTrashProposal(part.output, "holding_removal");
    return proposal ? (
      <HoldingTrashProposalCard
        mutationsDisabled={mutationsDisabled}
        mutationsDisabledMessage={mutationsDisabledMessage}
        proposal={proposal}
      />
    ) : null;
  }
  if (name === "propose_holding_restoration" && "output" in part) {
    const proposal = parseHoldingTrashProposal(part.output, "holding_restoration");
    return proposal ? (
      <HoldingTrashProposalCard
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
        mutationsDisabled={mutationsDisabled}
        proposal={proposal}
      />
    ) : null;
  }
  if (name === "propose_reconcile" && "output" in part) {
    const proposal = parseReconcileProposal(part.output);
    return proposal ? (
      <ReconcileProposalCard
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
        mutationsDisabled={mutationsDisabled}
        mutationsDisabledMessage={mutationsDisabledMessage}
        proposal={proposal}
      />
    ) : null;
  }
  // Read tools run silently; only proposal cards surface tool activity.
  return null;
}

/**
 * A proposal card, and the provenance mark above it when the server stamped the
 * turn it was born in (#1257).
 *
 * Marked, the two become ONE paper entry: the wrapper takes over the heavy rule
 * that opens a proposal (canon §4) so the stamp reads as the entry's first printed
 * line — above the bold headline the model writes, where it cannot be pushed off the
 * screen. Labelled in words, never by colour alone (canon §6: oro = aviso).
 *
 * Unmarked — the ordinary conversation — it renders the card and nothing else.
 */
function ProposalEntry({
  children,
  marked,
}: {
  children: React.ReactNode;
  marked: boolean;
}) {
  if (!marked) return children;
  return (
    <div className="assistantProposalOrigin">
      {/* `note`, like the app's other aside about a proposal (#1262): it is worthline
          speaking beside the card, not part of the model's turn. */}
      <p className="assistantWarning" role="note">
        <strong>{UNVALIDATED_PROVENANCE_LABEL}.</strong> {UNVALIDATED_PROVENANCE_NOTE}
      </p>
      {children}
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
  busy,
  pendingLabel,
}: {
  messages: UIMessage[];
  error: Error | undefined;
  mutationsDisabled: boolean;
  mutationsDisabledMessage: string;
  endRef: React.RefObject<HTMLDivElement | null>;
  busy: boolean;
  pendingLabel: string | null;
}) {
  // Memoised because the panel re-renders on every keystroke in the composer, and
  // this reads every text part of every turn.
  const fabricated = useMemo(
    () => messagesWithFabricatedProposal(messages, busy),
    [messages, busy],
  );
  // The holding names this conversation read, so the assistant's prose can name a
  // holding where it wrote its id (#1263). Memoised for the same reason: the panel
  // re-renders on every keystroke and this walks every tool output of every turn.
  const holdingLabels = useMemo(() => labelsByPublicHoldingId(messages), [messages]);
  return (
    <>
      {messages.map((message) => {
        // This turn's own chips, so a repeated bullet in its prose resolves to the
        // chip it was describing instead of blocking the trim of the whole block.
        const messageActions =
          message.role === "assistant" ? toolQuickActions(message) : [];
        const prose = printableProseByPart(message, messageActions);
        return (
          <div className={`assistantMsg ${message.role}`} key={message.id}>
            {message.parts.map((part, i) => {
              if (part.type === "text") {
                const text = prose.get(i) ?? "";
                // Nothing left to print: the part was a repeat, or was entirely the
                // action block that became chips.
                if (text.trim() === "") return null;
                return (
                  <AssistantTextPart
                    holdingLabels={holdingLabels}
                    key={`${message.id}-${i}`}
                    role={message.role}
                    text={text}
                  />
                );
              }
              if (part.type === "data-attachment-extraction") {
                // Never `null` for a payload with anything paintable in it: a card
                // from a newer server degrades rather than disappearing (#1261).
                const card = parseAttachmentPreviewCard(part.data);
                return card ? (
                  <AttachmentExtractionPreview card={card} key={`${message.id}-${i}`} />
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
                const card = proposalCardFor({
                  mutationsDisabled,
                  mutationsDisabledMessage,
                  name,
                  part,
                });
                if (card === null) return null;
                // The provenance mark (#1257) is read off the server's own tool output,
                // by key — never from the prose the model wrote on the card.
                return (
                  <ProposalEntry
                    key={`${message.id}-${i}`}
                    marked={"output" in part && hasUnvalidatedProvenance(part.output)}
                  >
                    {card}
                  </ProposalEntry>
                );
              }
              return null;
            })}
            {fabricated.has(message.id) ? <FabricatedProposalNote /> : null}
          </div>
        );
      })}
      {pendingLabel === null ? null : <AssistantPendingNotice label={pendingLabel} />}
      {error ? (
        <p className="assistantError" role="alert">
          {assistantErrorMessage(error)}
        </p>
      ) : null}
      <div ref={endRef} />
    </>
  );
}

/**
 * The visible twin of the panel's `srOnly` live region (#1286). `aria-hidden`
 * precisely because that region already announces the same fact: a screen reader
 * must hear «el asistente está respondiendo» once, not twice.
 *
 * Reuses the `.navPending` ring (#607) rather than inventing a second spinner
 * idiom, so a slow turn and a slow navigation read the same way.
 */
function AssistantPendingNotice({ label }: { label: string }) {
  return (
    <p aria-hidden="true" className="assistantPending">
      <span className="navPending" />
      {label}
    </p>
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
  initialOpen = false,
  onboardingManualHref = "/patrimonio/anadir",
  onboardingSkipAction,
  onboardingCompleteAction,
}: {
  mutationsDisabled?: boolean;
  mutationsDisabledMessage?: string;
  variant?: "floating" | "onboarding";
  /**
   * Whether the floating panel opens on mount. The lazy launcher (#1192) passes
   * this `true` when the panel is opened for the first time, so the heavy layer
   * chunk — which only loads on that first open — comes up already showing the
   * panel instead of its FAB. Once mounted, the layer owns its open/close state
   * as before (the launcher hands over completely).
   */
  initialOpen?: boolean;
  onboardingManualHref?: string;
  onboardingSkipAction?: (formData: FormData) => void | Promise<void>;
  onboardingCompleteAction?: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const { messages, sendMessage, status, error } = useChat({
    transport: assistantChatTransport,
  });
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
  // Computed once for both surfaces: the floating panel and the onboarding screen
  // must not disagree about whether a turn is in flight (#1286).
  const pendingLabel = assistantPendingLabel({ messages, status });
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
    void sendMessage(
      {
        role: "user",
        parts: [
          { type: "text", text: userTurnText(text, selectedAttachment?.name ?? null) },
        ],
      },
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
      { role: "user", parts: [{ type: "text", text: userTurnText("", file.name) }] },
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
                busy={busy}
                pendingLabel={pendingLabel}
              />
            </ProposalAppliedContext.Provider>
          </AssistantMessages>

          <QuickActionChips actions={quickActions} onRun={seed} />

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
          busy={busy}
          pendingLabel={pendingLabel}
        />
      </AssistantMessages>

      <QuickActionChips actions={quickActions} onRun={seed} />

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
