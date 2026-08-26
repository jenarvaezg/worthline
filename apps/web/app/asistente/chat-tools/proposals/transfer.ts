import { resolveInternalHoldingId } from "@web/agent-view/scope-resolution";
import { TRANSFER_PROPOSAL_SCHEMA } from "@web/asistente/chat-tools/schemas/operations";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import { buildTransferProposal } from "@web/asistente/transfer-proposals";
import { typedTransferGapMessage } from "@web/asistente/typed-transfer";
import {
  PAYWALL_OPERATION_MESSAGE,
  premiumRequired,
} from "@web/entitlements/paywall-copy";
import { type ToolSet, tool } from "ai";

/**
 * One traspaso between two existing investments (PRD #1393, #1482): two legs tied
 * together, not a venta plus a compra. The importe, the date and the participaciones
 * are read off the user's own message, so there is no field for a remembered figure.
 */
export function transferProposalTools(turn: ChatToolTurn): ToolSet {
  const { ingestionGated, input } = turn;

  return {
    propose_transfer: tool({
      description:
        "Anota UN TRASPASO entre dos inversiones que YA EXISTEN, cuando el usuario te lo cuenta por el chat («he traspasado hoy 1.018,67 € del fondo A al fondo B»): UN movimiento con dos patas atadas, no una venta más una compra. " +
        "Tú decides las dos posiciones y nada más: `originHoldingId` y `destinationHoldingId`. " +
        // The three consequences of the instrument (no plusvalía, cost travels, no cupo
        // spent) are NOT here: the card prints them for the user
        // (TRANSFER_NEUTRALITY_NOTE), and the floor is paid on every turn while card
        // copy is paid when there is a card — the #1342 trade. Nor is «the ids come
        // from a read»: that is the prompt's own cross-tool rule (#1263).
        "El importe, la fecha y las participaciones NO son argumentos: los lee la app del mensaje del usuario, tal cual los escriba —incluido «todo»—, y si faltan o son ambiguos te devuelve qué pedirle. Si el usuario escribe las participaciones que salieron, la app deriva de ellas el valor liquidativo; si no, usa el precio que ya tiene de cada posición. " +
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
        // The user's-own-message frontier (#1482, #1418's doctrine): the importe and the
        // date come from the parse, never from the arguments — so a turn where the app
        // read nothing is refused BEFORE the store is opened, naming what is missing.
        const typed = input.typedTransfer;
        if (typed === undefined || typed.status !== "read") {
          return Promise.resolve({
            error: "transfer_not_in_message",
            message: typedTransferGapMessage(
              typed === undefined ? ["amount", "date"] : typed.missing,
            ),
          });
        }
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
              transfer: typed.transfer,
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
