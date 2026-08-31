/**
 * What THIS turn grounds a write on, and the tools that enforce it (#1697, extracted
 * from `route.ts`).
 *
 * One module because every line of it answers the same question — what may a write in
 * this turn point at — and the answers come from three different places: the turn's own
 * extraction, the user's own keyboard, and the history the chosen model can actually
 * see. Only the route knows all three, which is why the derivation lives on this side
 * of the seam and the chat tools only enforce (#1248, PRD #1241).
 */

import {
  type AttachmentPreviewData,
  hasUnstructuredEvidenceInHistory,
  isValidatedDocument,
  validatedAttachmentsForTools,
  validatedDocumentsForTools,
} from "@web/asistente/attachment-chat";
import type { UnstructuredReading } from "@web/asistente/attachment-turn";
import { chatAsOf } from "@web/asistente/chat-clock";
import { chatToolStores, createChatTools } from "@web/asistente/chat-tools";
import { groundedHoldingIdsInHistory } from "@web/asistente/holding-id-provenance";
import { raiseMaintainerAlert } from "@web/asistente/maintainer-alert-store";
import {
  NO_TYPED_BALANCE_SERIES,
  typedBalanceSeriesInTurn,
} from "@web/asistente/typed-balance-series";
import { typedHoldingEventInTurn } from "@web/asistente/typed-holding-event";
import { typedTransferInTurn } from "@web/asistente/typed-transfer";
import { unvalidatedEvidenceGateApplies } from "@web/asistente/unvalidated-evidence-gate";
import { withStore } from "@web/store";
import type { StoreTarget } from "@web/store-resolver";
import type { UIMessage } from "ai";

/**
 * The tools factory for one turn: hand it the history a given provider will read, get
 * the tools that provider may call.
 *
 * A factory rather than a value because since #1408 the history differs per provider,
 * and the write gates take their allowlists from the history the model can SEE (#1263,
 * #1373) — deriving them once from the unfitted history would let a write name a
 * document that provider was never handed.
 */
export type TurnToolsFactory = (
  history: UIMessage[],
) => ReturnType<typeof createChatTools>;

export function buildTurnToolsFactory(input: {
  ingestionAllowed: boolean;
  /** The RAW history the browser sent, before any fitting. */
  messages: UIMessage[];
  preview: AttachmentPreviewData | null;
  target: StoreTarget;
  unstructured: UnstructuredReading | null;
}): TurnToolsFactory {
  const { ingestionAllowed, messages, preview, target, unstructured } = input;
  // Maintainer alerts persist only for a real workspace (ADR 0064). Demo is
  // read-only and local dev has no control plane, so the closure is bound only
  // when authenticated; otherwise the tool reports the alert as unavailable.
  const workspaceId = target.kind === "authenticated" ? target.workspaceId : null;
  // The unvalidated-evidence boundary (#1248, PRD #1241). An unreadable attachment is
  // deliberately NOT evidence — the model then holds no document at all, so the source
  // is the user's own text (the manual path). The history trace closes the two-turn
  // bypass; the exemption is this turn's own extraction, never a client-supplied
  // preview (see the gate module).
  const hasUnvalidatedEvidence =
    unstructured !== null || hasUnstructuredEvidenceInHistory(messages);
  const unvalidatedEvidence = unvalidatedEvidenceGateApplies({
    hasUnvalidatedEvidence,
    hasValidatedDocumentInThisTurn: isValidatedDocument(preview),
  });
  // The user's own keyboard as a way out of that gate (#1418). Read from the RAW
  // history, not from the fitted one the model gets: what grounds these rows is what
  // the user wrote, and a per-provider truncation of his message must not change the
  // series worthline read off it.
  //
  // Only parsed when the gate actually bites. Not for the cost — one message is
  // nothing — but because that is the only turn where this series means anything: an
  // ordinary turn already builds from the model's rows, and a value that could not
  // change any outcome is a value nobody should have to reason about.
  const typedBalanceSeries = unvalidatedEvidence
    ? typedBalanceSeriesInTurn(messages)
    : NO_TYPED_BALANCE_SERIES;
  // The traspaso dictated this turn (#1482). Read on EVERY turn, unlike the series
  // above: this is not an escape from a gate, it is the only source the lane has — its
  // importe and date are not tool arguments at all. From the RAW history for the same
  // reason: what grounds the figures is what the person wrote, and a per-provider
  // truncation of their message must not change what worthline read in it.
  const typedTransfer = typedTransferInTurn(messages, chatAsOf(target));
  // The operation dictated this turn (#1466). Read on every turn like the traspaso
  // above, and for the same reason: it is not an escape from a gate but the second
  // source the lane has, and the only one when no justificante was uploaded. From the
  // RAW history too — what grounds the figures is what the person wrote, and a
  // per-provider truncation of their message must not change what worthline read.
  const typedHoldingEvent = typedHoldingEventInTurn(messages, chatAsOf(target));

  return (history: UIMessage[]) =>
    createChatTools({
      ingestionAllowed,
      unvalidatedEvidence,
      // The premise, not the verdict: the provenance mark on the card (#1257) marks
      // the turn the proposal was born in, and a validated document lifts the gate
      // without taking the unreadable file out of the model's context.
      hasUnvalidatedEvidence,
      // The documents the model was actually handed (#1373). The reconcile lane takes
      // its rows from them instead of from what the model typed, so a row that no
      // extraction contains cannot become a write. Read from the FITTED history for
      // the same reason as the grounded ids: what grounds a write is what the model
      // sees, and since #1408 that differs per provider.
      validatedDocuments: validatedDocumentsForTools(history, preview),
      // Same list, with file names, for get_extracted_document (#1492).
      validatedAttachments: validatedAttachmentsForTools(history, preview),
      // The series the user typed this turn (#1418): it reopens the debt-history lanes
      // the gate closed, and it is what those lanes build from.
      typedBalanceSeries,
      // The traspaso the user dictated this turn (#1482): the ONE source of its importe
      // and its date, so `propose_transfer` never builds from the model's arguments.
      typedTransfer,
      // The operation the user dictated this turn (#1466): the second door of
      // `propose_operation`, open only when no validated justificante is on the table.
      typedHoldingEvent,
      // Holding-id provenance (#1263): the ids worthline itself put in the history the
      // model is about to read — a payload dropped by the tool ceiling (#1260) or a
      // turn dropped by the prose budget (#1408) is no longer in its context either,
      // so it has to read again.
      groundedHoldingIds: groundedHoldingIdsInHistory(history),
      // One line per refused call, with the offending strings: this is the frequency
      // of the invention, and it is invisible otherwise — the turn simply carries on
      // without the proposal. Unlike the history repairs above it cannot inflate with
      // the length of the thread: a tool call happens once, in this turn.
      onUngroundedHoldingId: (rejection) =>
        console.info("Assistant pointed a write at an id it never read", rejection),
      // The maintainer alert is the only forensic channel there is (ADR 0064), so a
      // gate that can drop one must say when it did: an over-blocking guard is
      // otherwise invisible by construction (#1347).
      onMaintainerAlertRefused: (rejection) =>
        console.info(
          "Assistant raised a maintainer alert with no discrepancy",
          rejection,
        ),
      runWithStore: (run) => withStore((store) => run(chatToolStores(store)), target),
      asOf: chatAsOf(target),
      ...(workspaceId === null
        ? {}
        : {
            raiseMaintainerAlert: (alert) =>
              raiseMaintainerAlert({ workspaceId, ...alert }),
          }),
    });
}
