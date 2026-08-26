import {
  type AgentViewCalculationTrace,
  type AgentViewHoldingDetail,
  AgentViewHttpError,
} from "@web/agent-view/contract";
import { isAgentViewErrorEnvelope } from "@web/agent-view/read-backend";
import {
  buildMaintainerAlertPayload,
  isMaintainerAlertCategory,
  type MaintainerAlertDeclaredFigure,
} from "@web/asistente/maintainer-alert";
import {
  maintainerAlertRefusalFor,
  maintainerAlertRefused,
} from "@web/asistente/maintainer-alert-evidence";
import type { RaisedMaintainerAlert } from "@worthline/db";
import { type ToolSet, tool } from "ai";
import { catalog } from "./reading";
import { RAISE_MAINTAINER_ALERT_SCHEMA } from "./schemas/maintainer";
import type { ChatToolTurn } from "./turn";

/**
 * The maintainer-only forensic alert (#1050, ADR 0064). Not a proposal and not a
 * support channel: it demands a real numeric discrepancy and the code REFUSES a
 * payload without one (#1347), because the failure mode of over-blocking is silence
 * in the very channel whose job is to break silence.
 *
 * The payload is assembled with RAW money — never `formatChatMoney` — so
 * declared-vs-computed on /admin is exact.
 */
export function maintainerAlertTools(turn: ChatToolTurn): ToolSet {
  const { catalogRead, input } = turn;

  return {
    raise_maintainer_alert: tool({
      description:
        "Levanta una ALERTA FORENSE SOLO-MANTENEDOR sobre un bug de cálculo de worthline. " +
        "category: `infidelity` (un saldo persistido que la config actual ya no reproduce — " +
        "fidelity.faithful=false), `residual` (residuo inexplicado por encima de la tolerancia tras " +
        "verificar la config) o `sync_source` (el olor es de fuente conectada/sync, no de cálculo). " +
        "summary lleva tu diagnóstico; si aplica, declaredBalanceMinor (céntimos)/declaredDate/" +
        "declaredSource, extractedData (datos estructurados del documento, NUNCA el binario) y " +
        "conversationRef. La app adjunta sola el snapshot de config y la traza de cálculo completa. " +
        "NO es un canal de soporte ni una petición de funcionalidad: exige un descuadre real de " +
        "cifras y el código la RECHAZA si el payload no lo trae.",
      inputSchema: RAISE_MAINTAINER_ALERT_SCHEMA,
      execute: async (args) => {
        const raise = input.raiseMaintainerAlert;
        if (!raise) return { error: "maintainer_alert_unavailable" };
        if (!isMaintainerAlertCategory(args.category)) {
          return {
            error: { code: "bad_request", message: `Unknown category: ${args.category}` },
          };
        }

        // Assemble the forensic payload from the read store with RAW money
        // (never `formatChatMoney`), so declared-vs-computed on /admin is exact.
        const payload = await input.runWithStore(async (store) => {
          let detail: AgentViewHoldingDetail | null = null;
          try {
            const detailResult = await catalogRead(
              catalog.get_holding_detail,
              { holdingId: args.holdingId },
              store.agentView,
            );
            if (!isAgentViewErrorEnvelope(detailResult)) detail = detailResult.data;
          } catch (error) {
            if (!(error instanceof AgentViewHttpError)) throw error;
          }

          let calculationTrace: AgentViewCalculationTrace | null = null;
          let calculationTraceUnavailable: string | undefined;
          try {
            const traceResult = await catalogRead(
              catalog.get_calculation_trace,
              {
                holdingId: args.holdingId,
                ...(args.declaredBalanceMinor === undefined
                  ? {}
                  : { declaredBalanceMinor: args.declaredBalanceMinor }),
                ...(args.declaredDate === undefined
                  ? {}
                  : { declaredDate: args.declaredDate }),
              },
              store.agentView,
            );
            if (isAgentViewErrorEnvelope(traceResult)) {
              calculationTraceUnavailable = traceResult.error.message;
            } else {
              calculationTrace = traceResult.data;
            }
          } catch (error) {
            if (error instanceof AgentViewHttpError) {
              calculationTraceUnavailable = error.message;
            } else {
              throw error;
            }
          }

          let declared: MaintainerAlertDeclaredFigure | undefined;
          if (args.declaredBalanceMinor !== undefined) {
            const currency =
              calculationTrace?.currentValue.currency ??
              detail?.currentValue.currency ??
              "EUR";
            declared = {
              balanceMinor: args.declaredBalanceMinor,
              currency,
              date: args.declaredDate ?? input.asOf,
              source: args.declaredSource ?? "declarado por el usuario",
            };
          }

          return buildMaintainerAlertPayload({
            category: args.category,
            summary: args.summary,
            raisedAt: new Date().toISOString(),
            detail,
            calculationTrace,
            ...(calculationTraceUnavailable === undefined
              ? {}
              : { calculationTraceUnavailable }),
            ...(declared === undefined ? {} : { declared }),
            ...(args.extractedData === undefined
              ? {}
              : { extractedData: args.extractedData }),
            ...(args.conversationRef === undefined
              ? {}
              : { conversationRef: args.conversationRef }),
          });
        });

        // Admission control (#1347): the three categories describe discrepancies
        // of MAGNITUDES, so an alert with no discrepancy in it is not an alert —
        // it is a support ticket, and there is no support desk to route it to.
        const refusal = maintainerAlertRefusalFor(payload);
        if (refusal) {
          input.onMaintainerAlertRefused?.({ category: args.category, refusal });
          return maintainerAlertRefused(refusal);
        }

        let raised: RaisedMaintainerAlert | null;
        try {
          raised = await raise({
            holdingId: args.holdingId,
            category: args.category,
            payload,
          });
        } catch {
          // A control-plane write failure must never kill the chat turn — the
          // repair path is unaffected and the agent reports honestly (#1050).
          return { status: "unpersisted", reason: "control_plane_error" };
        }
        if (raised === null) {
          return { status: "unpersisted", reason: "control_plane_unavailable" };
        }
        return {
          status: "raised",
          alertId: raised.alert.id,
          alertStatus: raised.alert.status,
          category: raised.alert.category,
          occurrenceCount: raised.alert.occurrenceCount,
          created: raised.created,
          regressionOf: raised.alert.supersedesAlertId,
        };
      },
    }),
  };
}
