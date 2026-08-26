import {
  DEFAULT_OPERATION_LIMIT,
  MAX_OPERATION_LIMIT,
} from "@web/agent-view/holding-operations";
import {
  DEFAULT_HOLDING_MATCH_LIMIT,
  MAX_HOLDING_MATCH_LIMIT,
} from "@web/agent-view/holding-search";
import { clampPositiveLimit } from "@web/agent-view/pagination";
import { isAgentViewErrorEnvelope } from "@web/agent-view/read-backend";
import { DEFAULT_TRASH_LIMIT, MAX_TRASH_LIMIT } from "@web/agent-view/trash-summary";
import {
  catalog,
  chatRead,
  EMPTY_WORKSPACE,
  resolveScopeId,
} from "@web/asistente/chat-tools/reading";
import {
  CALCULATION_TRACE_SCHEMA,
  HOLDING_ID_SCHEMA,
  HOLDING_OPERATIONS_SCHEMA,
  HOLDING_SEARCH_SCHEMA,
  TRASH_SUMMARY_SCHEMA,
} from "@web/asistente/chat-tools/schemas/reads";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import { type ToolSet, tool } from "ai";

/**
 * The per-holding reads: finding one, its detail, the debt engine's own trace, its
 * operations, its price freshness, and the papelera.
 */
export function holdingReadTools(turn: ChatToolTurn): ToolSet {
  const { catalogRead, input } = turn;

  return {
    get_trash_summary: tool({
      description:
        "Posiciones borradas (papelera) del scope, recuperables y fuera del contexto " +
        "financiero principal: id, etiqueta, dirección, valor guardado y fecha de borrado.",
      inputSchema: TRASH_SUMMARY_SCHEMA,
      execute: (args) =>
        chatRead(input, async (store) => {
          const scopeId = await resolveScopeId(store, args.scopeId);
          if (!scopeId) return EMPTY_WORKSPACE;
          const limit = clampPositiveLimit(args.limit, {
            defaultLimit: DEFAULT_TRASH_LIMIT,
            maxLimit: MAX_TRASH_LIMIT,
            onInvalid: "reject",
          });
          const result = await catalogRead(
            catalog.get_trash_summary,
            {
              scopeId,
              limit,
              ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
            },
            store.agentView,
          );
          if (isAgentViewErrorEnvelope(result)) return result;
          return { holdings: result.data, meta: result.meta };
        }),
    }),
    find_holdings: tool({
      description:
        "Busca posiciones VIVAS del scope por nombre, símbolo o ISIN (subcadena, sin distinguir " +
        "mayúsculas ni acentos) sobre TODAS ellas, incluidas las que valen 0 € — que " +
        "get_financial_context ordena últimas y deja fuera de su corte. Úsala SIEMPRE que el " +
        "usuario nombre una posición que no hayas visto en una lectura («el fondo a 0 €», un " +
        "ticker, parte de una etiqueta), y nunca concluyas que no existe sin haberla buscado " +
        "aquí. Devuelve el id que necesita una corrección o una baja, etiqueta, dirección, " +
        "instrumento, valor, por qué campo casó (`label`/`providerSymbol`/`isin`), la " +
        "identidad si consta (`isin`, `providerSymbol`, `units` netas) y `connectedSource`. " +
        "Ordena por valor absoluto descendente y acota (meta.truncated avisa si el tope dejó " +
        "fuera coincidencias: afina la búsqueda). La papelera se busca con get_trash_summary.",
      inputSchema: HOLDING_SEARCH_SCHEMA,
      execute: (args) =>
        chatRead(input, async (store) => {
          const scopeId = await resolveScopeId(store, args.scopeId);
          if (!scopeId) return EMPTY_WORKSPACE;
          const limit = clampPositiveLimit(args.limit, {
            defaultLimit: DEFAULT_HOLDING_MATCH_LIMIT,
            maxLimit: MAX_HOLDING_MATCH_LIMIT,
            onInvalid: "reject",
          });
          const result = await catalogRead(
            catalog.find_holdings,
            { limit, query: args.query ?? "", scopeId },
            store.agentView,
          );
          if (isAgentViewErrorEnvelope(result)) return result;
          return { matches: result.data, meta: result.meta };
        }),
    }),
    get_holding_detail: tool({
      description:
        "Detalle completo de UNA posición por su id `wl_hld_…`: valor, propiedad, instrumento, " +
        "su identidad (`isin`, `providerSymbol`, `units` netas), método de valoración, tramo de " +
        "liquidez, plan de amortización o anclas de valoración, y avisos de calidad. También sus " +
        "COBROS declarados con su cadencia y sus `expenses` (los gastos de un alquiler; `null` = " +
        "ninguno declarado, y entonces el FIRE descarta esa renta y usa el retorno del tramo, " +
        "ADR 0076). " +
        "Los hechos ausentes se marcan, nunca se inventan. Para una LISTA (todos los fondos, todos los " +
        "ISIN, todas las participaciones) usa get_financial_context con `holdingLimit` alto: " +
        "una llamada por posición se queda a medias y acaba dando por no registrado lo que " +
        "solo estaba sin leer.",
      inputSchema: HOLDING_ID_SCHEMA,
      execute: (args) =>
        chatRead(input, async (store) => {
          const result = await catalogRead(
            catalog.get_holding_detail,
            { holdingId: args.holdingId },
            store.agentView,
          );
          if (isAgentViewErrorEnvelope(result)) return result;
          return result.data;
        }),
    }),
    get_calculation_trace: tool({
      description:
        "Traza de cálculo de una deuda: el cuadro del motor — para una deuda amortizable, las " +
        "fronteras de cuota con el desglose interés/principal y los eventos (revisiones de tipo, " +
        "amortizaciones anticipadas) enganchados a cada frontera; para revolving/informal, sus " +
        "anclas de saldo — más la reconciliación por fecha del saldo vivo recomputado frente al " +
        "persistido en snapshot, el check de infidelidad (saldos persistidos que la config " +
        "actual ya no reproduce) y la tolerancia de modelado max(1 €, 0,05 % del saldo). Pasa " +
        "declaredBalanceMinor (céntimos) y declaredDate (YYYY-MM-DD) opcional para obtener el " +
        "residuo de una cifra citada por el usuario y si está dentro de tolerancia. Nunca " +
        "rehagas tú la aritmética de amortización. Solo deudas con modelo configurado.",
      inputSchema: CALCULATION_TRACE_SCHEMA,
      execute: (args) =>
        chatRead(input, async (store) => {
          const result = await catalogRead(
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
          if (isAgentViewErrorEnvelope(result)) return result;
          return result.data;
        }),
    }),
    get_operations: tool({
      description:
        "Operaciones (compras y ventas) de una posición de inversión por su id `wl_hld_…`, " +
        "con filtros de fecha y paginación; más recientes primero. Rechaza posiciones no de inversión.",
      inputSchema: HOLDING_OPERATIONS_SCHEMA,
      execute: (args) =>
        chatRead(input, async (store) => {
          const limit = clampPositiveLimit(args.limit, {
            defaultLimit: DEFAULT_OPERATION_LIMIT,
            maxLimit: MAX_OPERATION_LIMIT,
            onInvalid: "reject",
          });
          const result = await catalogRead(
            catalog.get_operations,
            {
              holdingId: args.holdingId,
              sort: args.sort ?? "-date",
              limit,
              ...(args.from === undefined ? {} : { from: args.from }),
              ...(args.to === undefined ? {} : { to: args.to }),
              ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
            },
            store.agentView,
          );
          if (isAgentViewErrorEnvelope(result)) return result;
          return { operations: result.data, meta: result.meta };
        }),
    }),
    get_price_freshness: tool({
      description:
        "Frescura del precio en caché de una posición por su id `wl_hld_…`: estado " +
        "(fresh/stale/failed/manual), cuándo se obtuvo y la fuente. Sin cifra de precio. " +
        "`freshness: null` si no hay cotización en caché, nunca un valor inventado.",
      inputSchema: HOLDING_ID_SCHEMA,
      execute: (args) =>
        chatRead(input, async (store) => {
          const result = await catalogRead(
            catalog.get_price_freshness,
            { holdingId: args.holdingId },
            store.agentView,
          );
          if (isAgentViewErrorEnvelope(result)) return result;
          return result.data;
        }),
    }),
  };
}
