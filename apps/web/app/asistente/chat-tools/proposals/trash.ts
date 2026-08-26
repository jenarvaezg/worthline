import { HOLDING_TRASH_PROPOSAL_SCHEMA } from "@web/asistente/chat-tools/schemas/holdings";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import {
  buildHoldingRemovalProposal,
  buildHoldingRestorationProposal,
} from "@web/asistente/holding-trash-proposals";
import { type ToolSet, tool } from "ai";

/**
 * The papelera pair: a reversible baja and its mirror restoration, both applied as
 * one atomic batch after confirmation. Hard-delete stays out of the chat.
 */
export function trashProposalTools(turn: ChatToolTurn): ToolSet {
  const { input, withProposalBudget } = turn;

  return {
    propose_holding_removal: tool({
      description:
        "Prepara una propuesta de BAJA reversible (soft delete a la papelera) de UNO O VARIOS holdings manuales. Es el caso «quita/borra estos activos». Se aplica en lote atómico tras confirmar; nada se pierde (se puede restaurar con propose_holding_restoration). " +
        "Si el usuario nombra una posición que no has leído (típico: «el fondo que está a 0 €», que get_financial_context ordena última y deja fuera de su corte), búscala PRIMERO con find_holdings. " +
        "El hard-delete y vaciar la papelera NO están soportados por el chat: siguen en la UI del producto.",
      inputSchema: HOLDING_TRASH_PROPOSAL_SCHEMA,
      // `neutral` in the gate's classification and still budgeted (#1246 review).
      // Classification and cap answer different questions: a trash proposal is born
      // from ids already read and is reversible, so it does NOT belong on the reject
      // list — but it also takes a LIST of holdings, which made it the one proposal
      // family with no per-turn cap while unvalidated evidence was on the table.
      // Capping is not reclassifying.
      execute: (args) =>
        withProposalBudget(() =>
          input.runWithStore(async (store) => {
            if (!store.assistantProposals) {
              return { error: "proposal_persistence_unavailable" };
            }
            const built = await buildHoldingRemovalProposal(
              {
                agentView: store.agentView,
                assistantProposals: store.assistantProposals,
              },
              args.holdingIds ?? [],
              input.asOf,
            );
            return built.ok ? built.proposal : { error: built.error };
          }),
        ),
    }),
    propose_holding_restoration: tool({
      description:
        "Prepara una propuesta de RESTAURACIÓN (espejo de la baja) de UNO O VARIOS holdings que están EN LA PAPELERA. Se aplica en lote atómico tras confirmar. " +
        "Restaurar un holding que NO está en la papelera es un error: comprueba la papelera antes con get_trash_summary, que es de donde salen sus ids.",
      inputSchema: HOLDING_TRASH_PROPOSAL_SCHEMA,
      // Budgeted for the same reason as its mirror above: `neutral` class, capped
      // shape (#1246 review).
      execute: (args) =>
        withProposalBudget(() =>
          input.runWithStore(async (store) => {
            if (!store.assistantProposals) {
              return { error: "proposal_persistence_unavailable" };
            }
            const built = await buildHoldingRestorationProposal(
              {
                agentView: store.agentView,
                assistantProposals: store.assistantProposals,
              },
              args.holdingIds ?? [],
              input.asOf,
            );
            return built.ok ? built.proposal : { error: built.error };
          }),
        ),
    }),
  };
}
