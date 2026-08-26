import {
  DEFAULT_POSITION_LIMIT,
  MAX_POSITION_LIMIT,
} from "@web/agent-view/connected-source-positions";
import { clampPositiveLimit } from "@web/agent-view/pagination";
import { isAgentViewErrorEnvelope } from "@web/agent-view/read-backend";
import { catalog, chatRead } from "@web/asistente/chat-tools/reading";
import {
  CONNECTED_SOURCE_POSITIONS_SCHEMA,
  EMPTY_SCHEMA,
  SOURCE_ID_SCHEMA,
} from "@web/asistente/chat-tools/schemas/reads";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import { type ToolSet, tool } from "ai";

/**
 * The connected-source reads (PRD #160/#1000): which sources exist, how fresh each
 * one is, and the positions it materializes. Never a credential, never a payload.
 */
export function sourceReadTools(turn: ChatToolTurn): ToolSet {
  const { catalogRead, input } = turn;

  return {
    list_connected_sources: tool({
      description:
        "Fuentes conectadas del workspace: id `wl_src_…`, adaptador, etiqueta, última " +
        "sincronización y las posiciones `wl_hld_…` que materializa. Sin credenciales.",
      inputSchema: EMPTY_SCHEMA,
      execute: () =>
        chatRead(input, async (store) => {
          const result = await catalogRead(
            catalog.list_connected_sources,
            {},
            store.agentView,
          );
          if (isAgentViewErrorEnvelope(result)) return result;
          return result.data;
        }),
    }),
    get_source_freshness: tool({
      description:
        "Frescura de valoración de una fuente conectada por su id `wl_src_…`: estado " +
        "(fresh/stale/failed/manual) y cuándo se obtuvo. Sin credenciales ni payload.",
      inputSchema: SOURCE_ID_SCHEMA,
      execute: (args) =>
        chatRead(input, async (store) => {
          const result = await catalogRead(
            catalog.get_source_freshness,
            { sourceId: args.sourceId },
            store.agentView,
          );
          if (isAgentViewErrorEnvelope(result)) return result;
          return result.data;
        }),
    }),
    get_connected_source_positions: tool({
      description:
        "Posiciones de fuente conectada (monedas / saldos) proyectadas en una posición o una " +
        "fuente. Aporta EXACTAMENTE UNO de holdingId (`wl_hld_…`) o sourceId (`wl_src_…`).",
      inputSchema: CONNECTED_SOURCE_POSITIONS_SCHEMA,
      execute: (args) =>
        chatRead(input, async (store) => {
          const limit = clampPositiveLimit(args.limit, {
            defaultLimit: DEFAULT_POSITION_LIMIT,
            maxLimit: MAX_POSITION_LIMIT,
            onInvalid: "reject",
          });
          const result = await catalogRead(
            catalog.get_connected_source_positions,
            {
              ...(args.holdingId === undefined ? {} : { holdingId: args.holdingId }),
              ...(args.sourceId === undefined ? {} : { sourceId: args.sourceId }),
              limit,
              ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
            },
            store.agentView,
          );
          if (isAgentViewErrorEnvelope(result)) return result;
          if (args.holdingId !== undefined) {
            return { positions: result.data, meta: result.meta };
          }
          return { groups: result.data, meta: result.meta };
        }),
    }),
  };
}
