import { HOLDING_CREATION_PROPOSAL_SCHEMA } from "@web/asistente/chat-tools/schemas/holdings";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import { buildHoldingCreationProposal } from "@web/asistente/holding-creation-proposals";
import { type ToolSet, tool } from "ai";

/**
 * The alta «por estado actual» (#1105, ADR 0056): one manual holding born at today's
 * value or balance — never an empty holding, never invented history.
 */
export function holdingCreationProposalTools(turn: ChatToolTurn): ToolSet {
  const { input, withProposalBudget } = turn;

  return {
    propose_holding: tool({
      description:
        "Prepara una propuesta de ALTA «por estado actual»: UN holding manual por su valor/saldo de HOY (ADR 0056: nunca un holding vacío, nunca historia inventada). Corregir o dar de baja uno existente tienen sus propias tools. " +
        "family + instrument deben concordar: stored (current_account/term_deposit/precious_metal/vehicle/other) → currentValueMinor; appreciating (property) → currentValueMinor + isPrimaryResidence, y si el usuario dice cuándo lo compró y por cuánto, acquisitionDate (YYYY-MM-DD) + acquisitionValueMinor (céntimos) JUNTOS: sin ellos el inmueble nace hoy y una hipoteca anterior no puede reconstruirse contra él (pregúntalos siempre que haya una hipoteca de años atrás); debt (mortgage/loan/credit_card) → balanceMinor (+ debtModel si lo conoces); investment (fund/etf/stock/index/pension_plan/crypto) → isin/providerSymbol opcionales y, para valorar la apertura de hoy, openingValueMinor (céntimos: el efectivo de la orden, o el valor de HOY si es lo único que hay) + pricePerUnit; sin apertura crea un contenedor vacío. " +
        "Si el usuario SOLO sabe el valor total de hoy (típico de cartera gestionada), pasa openingValueMinor sin pricePerUnit ni units: con providerSymbol la app deriva los títulos con la cotización en vivo, y sin símbolo lo registra como 1 participación al valor total. NUNCA dejes la apertura vacía cuando el usuario haya dado un importe: una tarjeta «Sin valoración de apertura» suma 0 €. " +
        "Si el documento dice los TÍTULOS y la COMISIÓN (toda confirmación de compra los dice), pásalos en units y feesMinor (céntimos): se guardan tal cual y el coste sale exacto; sin units quedan derivadas y falsas. Si units × pricePerUnit + feesMinor no cuadra con openingValueMinor, la app avisa sin bloquear. " +
        "La propuesta devuelta puede traer `duplicate` (ya existe un holding con ese nombre/ISIN): adviértelo SIEMPRE en tu texto y pregunta si es de verdad otro distinto; si es el mismo y quiere ponerlo al día, recomienda descartar la tarjeta y actualizar el existente, nunca crear un duplicado.",
      inputSchema: HOLDING_CREATION_PROPOSAL_SCHEMA,
      execute: (args) =>
        withProposalBudget(() =>
          input.runWithStore(async (store) => {
            if (
              !store.assistantProposals ||
              !store.liabilities ||
              !store.assets ||
              !store.workspace
            ) {
              return { error: "proposal_persistence_unavailable" };
            }
            const built = await buildHoldingCreationProposal(
              {
                agentView: store.agentView,
                assets: store.assets,
                assistantProposals: store.assistantProposals,
                liabilities: store.liabilities,
                workspace: store.workspace,
              },
              args,
              input.asOf,
            );
            return built.ok ? built.proposal : { error: built.error };
          }),
        ),
    }),
  };
}
