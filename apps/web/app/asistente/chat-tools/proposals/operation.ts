import { resolveInternalHoldingId } from "@web/agent-view/scope-resolution";
import { OPERATION_PROPOSAL_SCHEMA } from "@web/asistente/chat-tools/schemas/operations";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import {
  holdingEventInContext,
  OPERATION_KIND_CLAIMS,
  resolveOperationEvent,
} from "@web/asistente/operation-document-frontier";
import { buildOperationProposal } from "@web/asistente/operation-proposals";
import {
  PAYWALL_OPERATION_MESSAGE,
  premiumRequired,
} from "@web/entitlements/paywall-copy";
import { type ToolSet, tool } from "ai";

/**
 * One dated operation against its justificante (#1374): the app checks every
 * observed figure against the validated extraction and writes the document's, not
 * the model's. The direction is the one judgement the paper cannot make.
 */
export function operationProposalTools(turn: ChatToolTurn): ToolSet {
  const { ingestionGated, input } = turn;

  return {
    propose_operation: tool({
      description:
        "Anota UNA operación fechada (compra, venta o aportación) en una inversión que YA EXISTE, a partir de su JUSTIFICANTE: el apunte que worthline ya haya extraído y validado (documentType holding_event en los DATOS ESTRUCTURADOS). Es el caso «añádeme esta compra» con el recibo delante. " +
        "Tú decides `holdingId` (la posición destino) y `kind`: 'buy', 'sell', o 'contribution' para una aportación a un plan (se anota como compra y la tarjeta dice «aportación»). " +
        "El resto son los hechos OBSERVADOS del documento tal cual —date, amount y currency en unidades del documento (125.00 EUR, NO céntimos), y si los imprime isin, units, pricePerUnit y fees—: la app los COMPRUEBA contra él, escribe los del documento y RECHAZA la llamada si alguno no cuadra. No calcules ninguno; el valor actual de la posición no es un campo porque nadie tiene que rellenarlo. " +
        // The app's OTHER refusals (fuente conectada, divisa, ISIN contradictorio,
        // duplicado, sobreventa, fecha futura) are deliberately NOT listed here: the
        // floor is paid on every turn and a rejection only when it fires, and each one
        // answers with an actionable message anyway. A description carries this tool's
        // argument semantics, not the app's catalogue of refusals (#1342).
        // The traspaso pointer is the sibling-tools rule of #1423 applied here, and it
        // earns its characters: without it the model books a traspaso as a venta plus a
        // compra, which realizes a plusvalía that never happened and eats a year of
        // cupo de aportación — the exact failure PRD #1393 exists to end.
        "NO es ésta: un traspaso entre dos inversiones → propose_transfer (no es una venta más una compra); la cartera entera → propose_reconcile; un extracto con muchas órdenes → propose_statement_import; la posición aún no existe → propose_holding; el valor o el nombre están mal → propose_correction.",
      inputSchema: OPERATION_PROPOSAL_SCHEMA,
      execute: (args) => {
        if (ingestionGated) return premiumRequired(PAYWALL_OPERATION_MESSAGE);
        // `required` in a `jsonSchema()` is not validated at runtime, so the direction
        // is checked HERE — and never defaulted. It is the one judgement the document
        // cannot make (ADR 0067's #1374 amendment), so an absent one means the model
        // must read the paper again, exactly as `propose_early_repayment` refuses to
        // infer a `mode`. Defaulting to «buy» would let code pick a direction.
        const kind =
          args.kind !== undefined && OPERATION_KIND_CLAIMS.has(args.kind)
            ? args.kind
            : null;
        if (kind === null) {
          return Promise.resolve({
            error: "operation_kind_required",
            message:
              "Falta decir si el justificante es una compra, una venta o una aportación " +
              "('buy', 'sell' o 'contribution'). No lo elijo yo: lo dice el papel.",
          });
        }
        const publicHoldingId = args.holdingId?.trim();
        if (!publicHoldingId) {
          return Promise.resolve({
            error: "operation_holding_required",
            message:
              "Falta la posición en la que anotar la operación. Lee la cartera y pasa el " +
              "identificador que te devuelva.",
          });
        }
        // The document-only frontier (#1374): the fact comes from the extraction, the
        // model only points at it and says which way it runs. Checked BEFORE the store
        // is opened — a call with nothing to stand on is refused, not half-resolved
        // against live data. No unvalidated-evidence gate is needed on top: without a
        // validated document there is no fact at all (see UNVALIDATED_EVIDENCE_CLASSES).
        const resolved = resolveOperationEvent(
          {
            kind,
            ...(typeof args.date === "string" ? { date: args.date } : {}),
            ...(typeof args.amount === "number" ? { amount: args.amount } : {}),
            ...(typeof args.currency === "string" ? { currency: args.currency } : {}),
            ...(typeof args.isin === "string" ? { isin: args.isin } : {}),
            ...(typeof args.units === "number" ? { units: args.units } : {}),
            ...(typeof args.pricePerUnit === "number"
              ? { pricePerUnit: args.pricePerUnit }
              : {}),
            ...(typeof args.fees === "number" ? { fees: args.fees } : {}),
          },
          holdingEventInContext(input.validatedDocuments ?? []),
        );
        if (!resolved.ok) return Promise.resolve(resolved.error);
        return input.runWithStore(async (store) => {
          if (!store.assistantProposals || !store.assets || !store.operations) {
            return { error: "proposal_persistence_unavailable" };
          }
          const assetId = await resolveInternalHoldingId(
            store.agentView,
            publicHoldingId,
          );
          const built = await buildOperationProposal(
            {
              agentView: store.agentView,
              assets: store.assets,
              assistantProposals: store.assistantProposals,
              operations: store.operations,
            },
            {
              assetId,
              event: resolved.event,
              kind,
              publicHoldingId,
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
