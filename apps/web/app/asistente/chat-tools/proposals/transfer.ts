import { resolveInternalHoldingId } from "@web/agent-view/scope-resolution";
import type { ChatToolsInput } from "@web/asistente/chat-tools/input";
import { TRANSFER_PROPOSAL_SCHEMA } from "@web/asistente/chat-tools/schemas/operations";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import type { ProposalRefusal } from "@web/asistente/proposal-refusal";
import {
  transferDocumentInContext,
  transferFromDocument,
} from "@web/asistente/transfer-document-source";
import {
  buildTransferProposal,
  type TransferSource,
} from "@web/asistente/transfer-proposals";
import {
  type TypedTransfer,
  typedTransferGapMessage,
} from "@web/asistente/typed-transfer";
import {
  PAYWALL_OPERATION_MESSAGE,
  premiumRequired,
} from "@web/entitlements/paywall-copy";
import { type ToolSet, tool } from "ai";

/**
 * One traspaso between two existing investments (PRD #1393, #1482): two legs tied
 * together, not a venta plus a compra. The importe, the date and the participaciones
 * are read by worthline — off the bank's confirmation it validated (#1799), or off the
 * user's own message — so there is no field for a remembered figure.
 */
export function transferProposalTools(turn: ChatToolTurn): ToolSet {
  const { ingestionGated, input } = turn;

  return {
    propose_transfer: tool({
      description:
        "Anota UN TRASPASO entre dos inversiones que YA EXISTEN, desde su justificante (documentType transfer en los DATOS ESTRUCTURADOS) o desde lo que el usuario te cuente por el chat («he traspasado hoy 1.018,67 € del fondo A al fondo B»): UN movimiento con dos patas atadas, no una venta más una compra. " +
        "Tú decides las dos posiciones y nada más: `originHoldingId` y `destinationHoldingId`. " +
        // The three consequences of the instrument (no plusvalía, cost travels, no cupo
        // spent) are NOT here: the card prints them for the user
        // (TRANSFER_NEUTRALITY_NOTE), and the floor is paid on every turn while card
        // copy is paid when there is a card — the #1342 trade. Nor is «the ids come
        // from a read»: that is the prompt's own cross-tool rule (#1263). Nor, since
        // #1799, how the VL is derived from stated participaciones: the gap refusal and
        // the no-price refusal both say it, and they are paid only when they fire.
        "El importe, la fecha y las participaciones NO son argumentos: los lee la app del justificante o, si no lo hay, del mensaje del usuario —incluido «todo»—, y si faltan o son ambiguos te devuelve qué pedirle. " +
        "NO es ésta: la posición de destino aún no existe → primero `propose_holding` y después el traspaso; una compra, una venta o una aportación → `propose_operation`.",
      inputSchema: TRANSFER_PROPOSAL_SCHEMA,
      execute: (args) => {
        if (ingestionGated) return premiumRequired(PAYWALL_OPERATION_MESSAGE);
        const originHoldingId = args.originHoldingId?.trim();
        const destinationHoldingId = args.destinationHoldingId?.trim();
        if (!originHoldingId || !destinationHoldingId) {
          return Promise.resolve({
            error: "transfer_holdings_required",
            message:
              "Un traspaso tiene dos posiciones: de dónde sale y a dónde entra. Lee la " +
              "cartera y pasa los dos identificadores que te devuelva.",
          });
        }
        // The evidence frontier (#1482, #1418's doctrine, #1799): the importe and the
        // date come from what worthline read, never from the arguments — so a turn
        // where it read nothing is refused BEFORE the store is opened.
        const read = transferSource(input);
        if (!read.ok) return Promise.resolve(read.refusal);
        return input.runWithStore(async (store) => {
          if (!store.assistantProposals || !store.assets || !store.operations) {
            return { error: "proposal_persistence_unavailable" };
          }
          const [originAssetId, destinationAssetId] = await Promise.all([
            resolveInternalHoldingId(store.agentView, originHoldingId),
            resolveInternalHoldingId(store.agentView, destinationHoldingId),
          ]);
          const built = await buildTransferProposal(
            {
              agentView: store.agentView,
              assets: store.assets,
              assistantProposals: store.assistantProposals,
              operations: store.operations,
            },
            {
              destinationAssetId,
              destinationHolding: destinationHoldingId,
              originAssetId,
              originHolding: originHoldingId,
              source: read.source,
              transfer: read.transfer,
              ...(args.summary === undefined ? {} : { summary: args.summary }),
            },
            input.asOf,
          );
          return built.ok ? built.proposal : { error: built.error };
        });
      },
    }),
  };
}

/**
 * Which traspaso this call may build from. The validated confirmation wins whenever
 * there is one — the operation's rule (#1374, #1466): it is the bank's own paper, read
 * by worthline, and a figure the person typed beside it is the weaker evidence. With no
 * such document the lane reads the user's message exactly as before, and a message that
 * stated nothing since the last traspaso card has nothing to read (#1798): both figures
 * are asked for, never the ones that card already spent.
 */
function transferSource(
  input: ChatToolsInput,
):
  | { ok: true; transfer: TypedTransfer; source: TransferSource }
  | { ok: false; refusal: ProposalRefusal | { error: string; message: string } } {
  const document = transferDocumentInContext(input.validatedAttachments ?? []);
  if (document !== null) {
    const fromDocument = transferFromDocument(document);
    if (!fromDocument.ok) return fromDocument;
    return {
      ok: true,
      source: {
        currency: fromDocument.currency,
        fileName: document.fileName,
        from: "document",
      },
      transfer: fromDocument.transfer,
    };
  }
  const typed = input.typedTransfer;
  if (typed === undefined || typed.status !== "read") {
    return {
      ok: false,
      refusal: {
        error: "transfer_not_in_message",
        message: typedTransferGapMessage(
          typed?.status === "incomplete" ? typed.missing : ["amount", "date"],
        ),
      },
    };
  }
  return {
    ok: true,
    source: {
      from: "message",
      ...(typed.earlierMessage === undefined
        ? {}
        : { earlierMessage: typed.earlierMessage }),
    },
    transfer: typed.transfer,
  };
}
