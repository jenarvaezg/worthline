import { resolveInternalHoldingId } from "@web/agent-view/scope-resolution";
import {
  PROPERTY_ACQUISITION_PROPOSAL_SCHEMA,
  PROPERTY_VALUATION_PROPOSAL_SCHEMA,
} from "@web/asistente/chat-tools/schemas/housing";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import { buildPropertyAcquisitionProposal } from "@web/asistente/property-acquisition-proposals";
import { buildPropertyValuationProposal } from "@web/asistente/property-valuation-proposals";
import { type ToolSet, tool } from "ai";

/**
 * The two housing anchors a proposal can move, and they are NOT the same fact: a
 * tasación read off an extracted document adds one more point to the curve, while
 * the acquisition (#1563) moves the single anchor that decides from when the
 * property exists in the history — and with it whether the mortgage it secures
 * shows up at all (#1437).
 */
export function housingAnchorProposalTools(turn: ChatToolTurn): ToolSet {
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
    propose_property_acquisition: tool({
      description:
        "Prepara una propuesta para CORREGIR la fecha y el precio de adquisición de UN inmueble que el usuario declara. No añade una tasación: MUEVE el ancla de adquisición, la que decide desde cuándo el inmueble —y la deuda que garantiza— aparece en el histórico; para una tasación posterior usa propose_property_valuation_anchor. " +
        "acquisitionValueMinor va en CÉNTIMOS enteros (150.253,03 € → 15025303): la app rechaza un importe con decimales en vez de redondearlo, y acquisitionDate (YYYY-MM-DD) no puede ser futura. La curva de valor la recalcula la app.",
      inputSchema: PROPERTY_ACQUISITION_PROPOSAL_SCHEMA,
      // Whitelisted single fact (#1248): a date and a price are verified at a glance
      // in the preview — the ALLOWED side of the frontier, named as such in #1437's
      // own open question — so the lane may be born from unvalidated evidence,
      // capped at one proposal per turn.
      execute: (args) =>
        withProposalBudget(() =>
          input.runWithStore(async (store) => {
            if (!store.assistantProposals || !store.assets)
              return { error: "proposal_persistence_unavailable" };
            const assetId = await resolveInternalHoldingId(
              store.agentView,
              args.assetId ?? "",
            );
            const built = await buildPropertyAcquisitionProposal(
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
