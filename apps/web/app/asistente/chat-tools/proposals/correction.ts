import { resolveInternalHoldingId } from "@web/agent-view/scope-resolution";
import { CORRECTION_PROPOSAL_SCHEMA } from "@web/asistente/chat-tools/schemas/holdings";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import { buildCorrectionProposal } from "@web/asistente/correction-proposals";
import { type ToolSet, tool } from "ai";

/**
 * The «Solo desde hoy» correction (#1051, ADR 0056) for ONE badly modelled holding:
 * the app diagnoses which primitive to write from the holding's live state.
 */
export function correctionProposalTools(turn: ChatToolTurn): ToolSet {
  const { input, withProposalBudget } = turn;

  return {
    propose_correction: tool({
      description:
        "Prepara una propuesta de CORRECCIÓN «Solo desde hoy» para UN holding mal modelado. " +
        "correction.kind: 'declare_balance' (deuda: declara el saldo real hoy; en amortizable envía endDate y exactamente uno de annualRate o monthlyPaymentMinor → re-baseline ADR 0056; en revolving/informal → balance anchor), " +
        "'declare_value' (activo: valueMinor real de hoy → valuation anchor), " +
        "'change_debt_model' (debtModel destino cuando el modelo era el error), " +
        "'edit_config' (name, ownership, cadence, o plan.{annualInterestRate,termMonths,firstPaymentDate}), " +
        "'edit_identity' (RELLENAR el isin y/o providerSymbol VACÍOS de una inversión: si ya tiene valor NO se cambia desde aquí, la app lo rechaza y manda a la ficha). " +
        "Para el símbolo resuélvelo antes con search_market_symbol y no lo inventes; la app comprueba que cotiza y rechaza el que revaloraría un alta «por valor total» a UNA participación. " +
        "Split, alta o baja → wizard o papelera, no esta tool.",
      inputSchema: CORRECTION_PROPOSAL_SCHEMA,
      execute: (args) =>
        withProposalBudget(() =>
          input.runWithStore(async (store) => {
            if (!store.assistantProposals || !store.liabilities || !store.assets) {
              return { error: "proposal_persistence_unavailable" };
            }
            if (!args.correction?.kind) return { error: "correction_kind_required" };
            const internalId = await resolveInternalHoldingId(
              store.agentView,
              args.holdingId ?? "",
            );
            const built = await buildCorrectionProposal(
              {
                agentView: store.agentView,
                assets: store.assets,
                assistantProposals: store.assistantProposals,
                liabilities: store.liabilities,
                ...(store.operations ? { operations: store.operations } : {}),
              },
              {
                correction: args.correction,
                holdingId: internalId,
                publicHoldingId: args.holdingId ?? "",
                ...(args.summary === undefined ? {} : { summary: args.summary }),
              },
              input.asOf,
            );
            return built.ok ? built.proposal : { error: built.error };
          }),
        ),
    }),
  };
}
