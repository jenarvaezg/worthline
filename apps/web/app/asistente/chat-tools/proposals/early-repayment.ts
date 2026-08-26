import { resolveInternalHoldingId } from "@web/agent-view/scope-resolution";
import { EARLY_REPAYMENT_PROPOSAL_SCHEMA } from "@web/asistente/chat-tools/schemas/debt";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import { buildEarlyRepaymentProposal } from "@web/asistente/early-repayment-proposals";
import { type ToolSet, tool } from "ai";

/** The early repayment already made: one dated lump against one amortizable debt. */
export function earlyRepaymentProposalTools(turn: ChatToolTurn): ToolSet {
  const { input, withProposalBudget } = turn;

  return {
    propose_early_repayment: tool({
      description:
        "Prepara una propuesta para registrar UNA amortización anticipada YA HECHA sobre UNA deuda amortizable. Solo amortizables: en revolving/informal usa propose_correction (balance anchor). " +
        "amountMinor va en CÉNTIMOS enteros (91,32 € → 9132); si el importe que lees tiene decimales, conviértelo a céntimos exactos y no lo redondees. La app RECHAZA un importe que supere el saldo vivo del préstamo en esa fecha en más de una cuota: eso es un error de unidad (euros escritos como céntimos), no una cancelación. " +
        "mode: 'reduce-term' (misma cuota, el préstamo acaba antes: la pantalla dice que se acorta el plazo o que se reduce la ÚLTIMA cuota) o 'reduce-payment' (mismo plazo, la cuota baja). Si la pantalla no lo dice, PREGUNTA al usuario: no lo elijas por él. " +
        "observedMonthlyPaymentMinor: la cuota que se lee en la pantalla, en céntimos, si consta — la app la reconcilia con la que calcula el plan y avisa si no cuadran. " +
        "No calcules tú el efecto: la app calcula saldo antes/después, cuota y fecha de fin resultantes, y avisa de que una anticipada se aplica en el LÍMITE DE MES (la fecha del pago no es necesariamente la cuota que el usuario cree). Editar o borrar una anticipada ya registrada NO está en el chat: sigue en /patrimonio.",
      inputSchema: EARLY_REPAYMENT_PROPOSAL_SCHEMA,
      // Whitelisted single fact (#1248): a dated lump is verifiable at a glance in
      // the preview, so it may be born from unvalidated evidence — capped at one
      // proposal per turn. NOT premium-gated at the tool, like its whitelist
      // siblings: the attachment lane is already gated upstream in the chat route,
      // and a repayment the user simply TELLS the assistant about is the same
      // manual fact `/patrimonio/[id]/editar` takes for free.
      execute: (args) =>
        withProposalBudget(() =>
          input.runWithStore(async (store) => {
            if (!store.assistantProposals || !store.liabilities) {
              return { error: "proposal_persistence_unavailable" };
            }
            const liabilityId = await resolveInternalHoldingId(
              store.agentView,
              args.liabilityId ?? "",
            );
            const built = await buildEarlyRepaymentProposal(
              {
                assistantProposals: store.assistantProposals,
                liabilities: store.liabilities,
              },
              { ...args, liabilityId, publicHoldingId: args.liabilityId ?? "" },
              input.asOf,
            );
            return built.ok ? built.proposal : { error: built.error };
          }),
        ),
    }),
  };
}
