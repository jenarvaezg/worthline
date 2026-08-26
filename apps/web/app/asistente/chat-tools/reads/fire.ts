import { isAgentViewErrorEnvelope } from "@web/agent-view/read-backend";
import {
  catalog,
  chatRead,
  EMPTY_WORKSPACE,
  resolveScopeId,
} from "@web/asistente/chat-tools/reading";
import {
  CONTRIBUTION_PLAN_SCHEMA,
  SCOPE_ONLY_SCHEMA,
} from "@web/asistente/chat-tools/schemas/reads";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import { type ToolSet, tool } from "ai";

/**
 * The FIRE reads (PRD #421): current state, the projection, the contribution plan
 * and the intermediate goals. Every figure comes from agent-view — the model never
 * re-derives a FIRE number, it reads and compares.
 */
export function fireReadTools(turn: ChatToolTurn): ToolSet {
  const { catalogRead, input } = turn;

  return {
    get_fire_context: tool({
      description:
        "Contexto FIRE actual del scope: config y supuestos, número FIRE, activos elegibles, " +
        "reservas de objetivos aplicadas solo sobre capital elegible, brecha, progreso y " +
        "activos excluidos con su motivo. Solo estado actual.",
      inputSchema: SCOPE_ONLY_SCHEMA,
      execute: (args) =>
        chatRead(input, async (store) => {
          const scopeId = await resolveScopeId(store, args.scopeId);
          if (!scopeId) return EMPTY_WORKSPACE;
          const result = await catalogRead(
            catalog.get_fire_context,
            { scopeId },
            store.agentView,
          );
          if (isAgentViewErrorEnvelope(result)) return result;
          return result.data;
        }),
    }),
    get_fire_projection: tool({
      description:
        "Proyecta cuándo el scope alcanza FIRE en escenarios optimista/base/pesimista " +
        "desde el elegible ajustado por reservas de objetivos elegibles (años, edad, " +
        "activos finales, trayectoria anual). `unconfigured` sin config FIRE.",
      inputSchema: SCOPE_ONLY_SCHEMA,
      execute: (args) =>
        chatRead(input, async (store) => {
          const scopeId = await resolveScopeId(store, args.scopeId);
          if (!scopeId) return EMPTY_WORKSPACE;
          const result = await catalogRead(
            catalog.get_fire_projection,
            { scopeId },
            store.agentView,
          );
          if (isAgentViewErrorEnvelope(result)) return result;
          return result.data;
        }),
    }),
    get_contribution_plan: tool({
      description:
        "Lee el plan de aportaciones del scope: contribuciones recurrentes, reparto " +
        "mensual previsto, pendientes/backlog de reconciliación y proyección what-if " +
        "bajo el plan (growthAssumption flat|historical). Toda la respuesta es previsión, " +
        "no verdad ejecutada; las operaciones confirmadas siguen en get_operations. NO da " +
        "la capacidad de ahorro del FIRE: esa vive en get_fire_projection.",
      inputSchema: CONTRIBUTION_PLAN_SCHEMA,
      execute: (args) =>
        chatRead(input, async (store) => {
          const scopeId = await resolveScopeId(store, args.scopeId);
          if (!scopeId) return EMPTY_WORKSPACE;
          const result = await catalogRead(
            catalog.get_contribution_plan,
            {
              scopeId,
              ...(args.month === undefined ? {} : { month: args.month }),
              ...(args.growthAssumption === undefined
                ? {}
                : { growthAssumption: args.growthAssumption }),
              ...(args.reconciliationWindowDays === undefined
                ? {}
                : { reconciliationWindowDays: args.reconciliationWindowDays }),
            },
            store.agentView,
          );
          if (isAgentViewErrorEnvelope(result)) return result;
          return result.data;
        }),
    }),
    list_goals: tool({
      description:
        "Lista los objetivos intermedios del scope: importe objetivo, fecha, prioridad, " +
        "posiciones asignadas, capital reservado y ratio de financiación. FIRE solo resta " +
        "reservas en horizonte respaldadas por holdings elegibles.",
      inputSchema: SCOPE_ONLY_SCHEMA,
      execute: (args) =>
        chatRead(input, async (store) => {
          const scopeId = await resolveScopeId(store, args.scopeId);
          if (!scopeId) return EMPTY_WORKSPACE;
          const result = await catalogRead(
            catalog.list_goals,
            { scopeId },
            store.agentView,
          );
          if (isAgentViewErrorEnvelope(result)) return result;
          return result.data;
        }),
    }),
  };
}
