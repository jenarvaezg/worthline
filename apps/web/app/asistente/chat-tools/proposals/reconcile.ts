import { RECONCILE_PROPOSAL_SCHEMA } from "@web/asistente/chat-tools/schemas/documents";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import {
  positionsMovementsInContext,
  resolveReconcileDocument,
} from "@web/asistente/reconcile-document-frontier";
import { buildReconcileProposal } from "@web/asistente/reconcile-proposals";
import { brokerTransactionsInContext } from "@web/asistente/statement-from-transactions-document";
import { unvalidatedEvidenceRejected } from "@web/asistente/unvalidated-evidence-gate";
import {
  PAYWALL_RECONCILE_MESSAGE,
  premiumRequired,
} from "@web/entitlements/paywall-copy";
import { type ToolSet, tool } from "ai";

/**
 * The portfolio reconcile (#1108, #1373): a SELECTION over a document worthline
 * validated, never a batch of rows the model writes.
 */
export function reconcileProposalTools(turn: ChatToolTurn): ToolSet {
  const { ingestionGated, input, unvalidatedEvidence } = turn;

  return {
    propose_reconcile: tool({
      description:
        "Prepara UNA propuesta de RECONCILE de cartera SOBRE un documento «posiciones + movimientos» que worthline ya haya extraído y validado (documentType positions_movements en los DATOS ESTRUCTURADOS). Solo SELECCIONAS filas de ese documento: en holdings pasa el nombre (y el ISIN si lo trae) TAL CUAL los diga el documento, o no pases ninguna para llevarlas todas. Los importes, los tiers de fidelidad y los movimientos los toma la app del documento, así que no los recalcules ni los rellenes con cifras de la cartera. Si no hay documento validado, o si una fila no está en él, la app RECHAZA la llamada: una operación puntual sobre una inversión que ya existe no se anota por aquí. La app fusiona con la cartera viva: crea los holdings nuevos, actualiza los coincidentes con sus movimientos, deja el resto — todo o nada. El usuario reasigna los matches dudosos en el preview antes de confirmar. v1 escribe solo familias de inversión (fondo/etf/acción/índice/plan de pensiones/cripto) en EUR; para otras familias usa el alta por chat (propose_holding), no ésta.",
      inputSchema: RECONCILE_PROPOSAL_SCHEMA,
      execute: (args) => {
        if (ingestionGated) return premiumRequired(PAYWALL_RECONCILE_MESSAGE);
        if (unvalidatedEvidence) return unvalidatedEvidenceRejected();
        // The document-only frontier (#1373): the rows come from the extraction, the
        // model only picks among them. Checked BEFORE the store is opened — a call
        // with nothing to stand on is refused, not half-resolved against live data.
        const documents = input.validatedDocuments ?? [];
        const resolved = resolveReconcileDocument(
          (args.holdings ?? []).map((holding) => ({
            ...(typeof holding.name === "string" ? { name: holding.name } : {}),
            ...(typeof holding.isin === "string" ? { isin: holding.isin } : {}),
            ...(typeof holding.value === "number" ? { value: holding.value } : {}),
          })),
          positionsMovementsInContext(documents),
          {
            hasBrokerTransactions: brokerTransactionsInContext(documents) !== null,
          },
        );
        if (!resolved.ok) return Promise.resolve(resolved.error);
        return input.runWithStore(async (store) => {
          if (
            !store.assistantProposals ||
            !store.assets ||
            !store.liabilities ||
            !store.workspace
          ) {
            return { error: "proposal_persistence_unavailable" };
          }
          const built = await buildReconcileProposal(
            {
              agentView: store.agentView,
              assets: store.assets,
              assistantProposals: store.assistantProposals,
              liabilities: store.liabilities,
              workspace: store.workspace,
              ...(store.connectedSources
                ? { connectedSources: store.connectedSources }
                : {}),
            },
            resolved.document,
            input.asOf,
            args.documentName ?? "cartera.xlsx",
          );
          return built.ok ? built.proposal : { error: built.error };
        });
      },
    }),
  };
}
