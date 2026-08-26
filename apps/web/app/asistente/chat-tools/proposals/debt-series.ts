import { resolveInternalHoldingId } from "@web/agent-view/scope-resolution";
import { buildBalanceHistoryProposal } from "@web/asistente/balance-history-proposals";
import {
  BALANCE_HISTORY_PROPOSAL_SCHEMA,
  RECONSTRUCTION_AMENDMENT_SCHEMA,
  RECONSTRUCTION_PROPOSAL_SCHEMA,
} from "@web/asistente/chat-tools/schemas/debt";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import {
  buildReconstructionAmendment,
  buildReconstructionProposal,
} from "@web/asistente/reconstruction-proposals";
import { isSeriesRefusal } from "@web/asistente/unvalidated-evidence-gate";
import {
  PAYWALL_STATEMENT_MESSAGE,
  premiumRequired,
} from "@web/entitlements/paywall-copy";
import { type ToolSet, tool } from "ai";

/**
 * The observed-balance series lanes (ADR 0056/0071): importing a cuadro de
 * amortización, reconstructing a badly modelled debt's whole history, and amending
 * the reconstruction already on screen without re-emitting the series (#1423).
 *
 * All three build from what {@link ChatToolTurn.debtSeriesRows} resolved, so a lane
 * can never take rows the evidence frontier closed.
 */
export function debtSeriesProposalTools(turn: ChatToolTurn): ToolSet {
  const { debtSeriesRows, ingestionGated, input, withProposalBudget } = turn;

  return {
    propose_balance_history_import: tool({
      description:
        "Prepara una propuesta para una deuda amortizable inequívoca a partir de saldos observados en un cuadro de amortización. " +
        "No infieras capital, plazo ni cuota: envía solo fecha, saldo en céntimos y, si consta, tipo anual. " +
        "Los saldos marcados projected son la previsión del documento, no observaciones: envíalos igual —la app los excluye y lo dice en la tarjeta— pero no los cites como hechos. " +
        "La app calcula la curva y la reconcilia con el saldo conocido antes de confirmar.",
      inputSchema: BALANCE_HISTORY_PROPOSAL_SCHEMA,
      execute: (args) => {
        const series = debtSeriesRows("propose_balance_history_import", args);
        if (isSeriesRefusal(series)) return series;
        return input.runWithStore(async (store) => {
          if (!store.assistantProposals || !store.liabilities) {
            return { error: "proposal_persistence_unavailable" };
          }
          const liabilityId = await resolveInternalHoldingId(
            store.agentView,
            args.liabilityId ?? "",
          );
          const built = await buildBalanceHistoryProposal(
            {
              assistantProposals: store.assistantProposals,
              liabilities: store.liabilities,
            },
            {
              ...args,
              liabilityId,
              rows: series.rows,
              ...(series.documentName === undefined
                ? {}
                : { documentName: series.documentName }),
            },
            input.asOf,
          );
          return built.ok ? built.proposal : { error: built.error };
        });
      },
    }),
    propose_reconstruction: tool({
      description:
        "Prepara una propuesta de CORRECCIÓN «Reconstruir historia» para UNA deuda amortizable mal modelada, a partir de una serie de saldos fechados observados en un extracto o cuadro de amortización — normalmente extraídos de un adjunto (PDF u hoja de cálculo incluidos). " +
        "Envía solo fecha (YYYY-MM-DD) y saldo observado en céntimos; NO infieras capital, plazo, cuota ni tipo (la app re-deriva el tipo de la curva vigente). " +
        "La app reconstruye la curva como cadena de re-baselines (ADR 0056), la reconcilia con el saldo conocido y muestra la superficie C con edición punto a punto; la confirmación re-proyecta la serie y aplica un único lote atómico. " +
        "Para CAMBIAR una propuesta que ya está en pantalla (quitar puntos, reincluirlos, corregir un importe) no la reemitas recortada: enmiéndala con propose_reconstruction_amendment.",
      inputSchema: RECONSTRUCTION_PROPOSAL_SCHEMA,
      execute: (args) => {
        if (ingestionGated) return premiumRequired(PAYWALL_STATEMENT_MESSAGE);
        const series = debtSeriesRows("propose_reconstruction", args);
        if (isSeriesRefusal(series)) return series;
        return input.runWithStore(async (store) => {
          if (!store.assistantProposals || !store.liabilities) {
            return { error: "proposal_persistence_unavailable" };
          }
          const liabilityId = await resolveInternalHoldingId(
            store.agentView,
            args.holdingId ?? "",
          );
          const built = await buildReconstructionProposal(
            {
              assistantProposals: store.assistantProposals,
              liabilities: store.liabilities,
            },
            {
              liabilityId,
              publicHoldingId: args.holdingId ?? "",
              rows: series.rows,
              ...(args.summary === undefined ? {} : { summary: args.summary }),
              ...(series.documentName === undefined
                ? {}
                : { documentName: series.documentName }),
            },
            input.asOf,
          );
          return built.ok ? built.proposal : { error: built.error };
        });
      },
    }),
    propose_reconstruction_amendment: tool({
      description:
        "ENMIENDA la propuesta de reconstrucción que ya está en pantalla, sin reenviar la serie: es la tool para «quita los puntos estimados a partir de agosto de 2026» o «ese saldo era 145.500 €». " +
        "Pasa el proposalId que devolvió propose_reconstruction (o la última enmienda) y una lista corta de operaciones: 'exclude'/'include' con `date` (un punto) o con `from`/`to` (rango inclusive, ambos opcionales: «a partir de» es solo `from`); 'set_balance' con `date` y `balanceMinor` en céntimos. Fechas AAAA-MM-DD que existan en la serie. " +
        "La tarjeta ya trae por cada punto una casilla «Excluir» y su importe editable: si esta tool no puede con lo que te piden, ésa es la ÚNICA excepción a no hablar de la interfaz — dile que los desmarque ahí.",
      inputSchema: RECONSTRUCTION_AMENDMENT_SCHEMA,
      execute: (args) => {
        // El muro de pago ANTES del cupo del turno: una tool cerrada no puede gastar
        // —ni devolver— un hueco del presupuesto de propuestas.
        if (ingestionGated) return premiumRequired(PAYWALL_STATEMENT_MESSAGE);
        return withProposalBudget(() =>
          input.runWithStore(async (store) => {
            if (!store.assistantProposals || !store.liabilities) {
              return { error: "proposal_persistence_unavailable" };
            }
            const built = await buildReconstructionAmendment(
              {
                assistantProposals: store.assistantProposals,
                liabilities: store.liabilities,
              },
              {
                operations: args.operations ?? [],
                proposalId: args.proposalId ?? "",
                ...(args.summary === undefined ? {} : { summary: args.summary }),
              },
              input.asOf,
            );
            return built.ok ? built.proposal : { error: built.error };
          }),
        );
      },
    }),
  };
}
