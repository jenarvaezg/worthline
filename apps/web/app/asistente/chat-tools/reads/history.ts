import { clampPositiveLimit } from "@web/agent-view/pagination";
import { isAgentViewErrorEnvelope } from "@web/agent-view/read-backend";
import {
  DEFAULT_SNAPSHOT_LIMIT,
  MAX_SNAPSHOT_LIMIT,
  MAX_SNAPSHOT_LIMIT_WITH_HOLDING_ROWS,
} from "@web/agent-view/snapshot-history";
import {
  catalog,
  chatRead,
  EMPTY_WORKSPACE,
  resolveScopeId,
} from "@web/asistente/chat-tools/reading";
import { SNAPSHOT_HISTORY_SCHEMA } from "@web/asistente/chat-tools/schemas/reads";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import { type ToolSet, tool } from "ai";

/** The snapshot-history read: the scope's series, priced by how much it breaks down. */
export function historyReadTools(turn: ChatToolTurn): ToolSet {
  const { catalogRead, input } = turn;

  return {
    get_snapshot_history: tool({
      description:
        "Historial de snapshots de patrimonio del scope (cierres mensuales por defecto, o cada " +
        "snapshot con granularity=raw), con filtros de fecha y paginación por cursor. " +
        "`includeHoldingRows` decide el coste: `none` (por defecto, la más barata) para la forma " +
        "de la serie; `summary` (≈3×) para la composición por tramo de liquidez; `full` (≈8×) " +
        `solo para mirar posición a posición. Con los dos últimos la página se acota a ${MAX_SNAPSHOT_LIMIT_WITH_HOLDING_ROWS} ` +
        "snapshots (meta.holdingRowsWindow lo dice y el resto sigue en meta.nextCursor), así que " +
        "elige QUÉ desglosas: sort=-date para los más recientes, o from/to para tu rango. Para " +
        "UNA posición usa get_holding_detail, no el histórico entero.",
      inputSchema: SNAPSHOT_HISTORY_SCHEMA,
      execute: (args) =>
        chatRead(input, async (store) => {
          const scopeId = await resolveScopeId(store, args.scopeId);
          if (!scopeId) return EMPTY_WORKSPACE;
          const limit = clampPositiveLimit(args.limit, {
            defaultLimit: DEFAULT_SNAPSHOT_LIMIT,
            maxLimit: MAX_SNAPSHOT_LIMIT,
            onInvalid: "reject",
          });
          const result = await catalogRead(
            catalog.get_snapshot_history,
            {
              scopeId,
              granularity: args.granularity ?? "monthly-close",
              sort: args.sort ?? "date",
              limit,
              includeHoldingRows: args.includeHoldingRows ?? "none",
              ...(args.from === undefined ? {} : { from: args.from }),
              ...(args.to === undefined ? {} : { to: args.to }),
              ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
            },
            store.agentView,
          );
          if (isAgentViewErrorEnvelope(result)) return result;
          return { entries: result.data, meta: result.meta };
        }),
    }),
  };
}
