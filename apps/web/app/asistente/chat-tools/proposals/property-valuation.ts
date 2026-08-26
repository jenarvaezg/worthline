import { resolveInternalHoldingId } from "@web/agent-view/scope-resolution";
import { PROPERTY_VALUATION_PROPOSAL_SCHEMA } from "@web/asistente/chat-tools/schemas/documents";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import { buildPropertyValuationProposal } from "@web/asistente/property-valuation-proposals";
import { type ToolSet, tool } from "ai";

/** The property-valuation anchor: one dated tasación read off an extracted document. */
export function propertyValuationProposalTools(turn: ChatToolTurn): ToolSet {
  const { input, withProposalBudget } = turn;

  return {
    propose_property_valuation_anchor: tool({
      description:
        "Prepara una propuesta de ancla de tasación para un inmueble inequívoco a partir de un documento ya extraído por el seam de adjuntos. Pasa nombre y SHA-256 reales del documento, y extrae únicamente fecha y valor total en céntimos; la app calcula la curva y la marca como no verificada.",
      inputSchema: PROPERTY_VALUATION_PROPOSAL_SCHEMA,
      execute: (args) =>
        withProposalBudget(() =>
          input.runWithStore(async (store) => {
            if (!store.assistantProposals || !store.assets)
              return { error: "proposal_persistence_unavailable" };
            const assetId = await resolveInternalHoldingId(
              store.agentView,
              args.assetId ?? "",
            );
            const built = await buildPropertyValuationProposal(
              { assistantProposals: store.assistantProposals, assets: store.assets },
              { ...args, assetId },
              input.asOf,
            );
            return built.ok ? built.proposal : { error: built.error };
          }),
        ),
    }),
  };
}
