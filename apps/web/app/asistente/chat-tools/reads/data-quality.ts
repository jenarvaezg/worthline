import {
  DEFAULT_DATA_QUALITY_LIMIT,
  MAX_DATA_QUALITY_LIMIT,
} from "@web/agent-view/data-quality";
import { clampPositiveLimit } from "@web/agent-view/pagination";
import { isAgentViewErrorEnvelope } from "@web/agent-view/read-backend";
import {
  catalog,
  chatRead,
  EMPTY_WORKSPACE,
  resolveScopeId,
} from "@web/asistente/chat-tools/reading";
import { DATA_QUALITY_SCHEMA } from "@web/asistente/chat-tools/schemas/reads";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import { type ToolSet, tool } from "ai";

/** The data-health read (PRD #654): every quality signal, normalized. */
export function dataQualityReadTools(turn: ChatToolTurn): ToolSet {
  const { catalogRead, input } = turn;

  return {
    get_data_quality: tool({
      description:
        "Señales de calidad de datos del scope: avisos de dominio, precios/sincronizaciones " +
        "obsoletos o fallidos, configuración ausente, historial escaso, carteras gestionadas " +
        "cuyo valor se aparta del saldo declarado y activos en la papelera con saldo vivo. " +
        "Filtra por categoría o severidad.",
      inputSchema: DATA_QUALITY_SCHEMA,
      execute: (args) =>
        chatRead(input, async (store) => {
          const scopeId = await resolveScopeId(store, args.scopeId);
          if (!scopeId) return EMPTY_WORKSPACE;
          const limit = clampPositiveLimit(args.limit, {
            defaultLimit: DEFAULT_DATA_QUALITY_LIMIT,
            maxLimit: MAX_DATA_QUALITY_LIMIT,
            onInvalid: "reject",
          });
          const result = await catalogRead(
            catalog.get_data_quality,
            {
              scopeId,
              limit,
              ...(args.category === undefined ? {} : { category: args.category }),
              ...(args.severity === undefined ? {} : { severity: args.severity }),
              ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
            },
            store.agentView,
          );
          if (isAgentViewErrorEnvelope(result)) return result;
          return { signals: result.data, meta: result.meta };
        }),
    }),
  };
}
