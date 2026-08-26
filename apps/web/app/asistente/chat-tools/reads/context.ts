import type { AgentViewFinancialContext } from "@web/agent-view/contract";
import { isFigureName } from "@web/agent-view/figure-explanations";
import { MAX_HOLDING_LIMIT } from "@web/agent-view/financial-context";
import { pickHoldingIdentity } from "@web/agent-view/holding-identity";
import { clampPositiveLimit } from "@web/agent-view/pagination";
import { isAgentViewErrorEnvelope } from "@web/agent-view/read-backend";
import {
  catalog,
  chatRead,
  EMPTY_WORKSPACE,
  resolveScopeId,
} from "@web/asistente/chat-tools/reading";
import {
  EMPTY_SCHEMA,
  EXPLAIN_FIGURE_SCHEMA,
  FINANCIAL_CONTEXT_SCHEMA,
} from "@web/asistente/chat-tools/schemas/reads";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import { type ToolSet, tool } from "ai";

/** Holdings included in the compact context — enough to reason, cheap in tokens. */
const CHAT_HOLDING_LIMIT = 10;

/**
 * The agent-view context reshaped for conversation (ADR 0047): the compact
 * always-first read, trimmed for the free tier's token budget. Amounts here are
 * pre-formatted like every other tool (via `formatChatMoney` at the boundary).
 */
function toChatFinancialContext(context: AgentViewFinancialContext) {
  return {
    asOf: context.asOf,
    baseCurrency: context.baseCurrency,
    scope: { id: context.scope.id, label: context.scope.label },
    summary: context.summary,
    liquidity: context.liquidityBreakdown.map((rung) => ({
      tier: rung.tier,
      netValue: rung.netValue,
      grossAssets: rung.grossAssets,
      debts: rung.debts,
      shareOfGross: rung.shareOfGross,
    })),
    exposure: context.exposure,
    holdings: context.holdings.items.map((holding) => ({
      // The id travels with the holding (#1263). It used to be trimmed for tokens,
      // which left the model needing a `wl_hld_…` for any write with none in front
      // of it — an invitation to fill the gap, and it filled it with its own
      // monologue. Ten ids are ~130 tokens against a 13.000-token floor, and the
      // context already carried them for the exposure's top holdings, so this
      // asymmetry only ever hid the ones a debt repair needs.
      id: holding.id,
      label: holding.label,
      instrument: holding.instrument,
      direction: holding.direction,
      liquidityTier: holding.liquidityTier,
      currentValue: holding.currentValue,
      // The instrument identity travels ON the row (#1346). Trimmed, the only way
      // to answer «lista todos los instrumentos con ISIN y participaciones» was a
      // fan-out of get_holding_detail — and a model that abandons the fan-out
      // reports the ISINs as unregistered instead of as unread. Copied through the
      // shared picker so this trim cannot hand-roll a guard that drops `units: "0"`.
      ...pickHoldingIdentity(holding),
      // Procedencia travels ON the row (uso real 2026-07-30). Trimming it is what let the free
      // pool's model read the `connectedSources` block, fail to join it to the
      // holding, and offer to declare a Numista collection's value by hand.
      ...(holding.connectedSource ? { connectedSource: holding.connectedSource } : {}),
    })),
    omittedHoldings:
      context.holdings.omittedCount > 0
        ? {
            count: context.holdings.omittedCount,
            totalValue: context.holdings.omittedTotalValue,
          }
        : null,
    links: context.links,
  };
}
export function contextReadTools(turn: ChatToolTurn): ToolSet {
  const { catalogRead, input } = turn;

  return {
    get_financial_context: tool({
      description:
        "Foto financiera actual del scope (por defecto el del hogar): patrimonio neto, " +
        "líquido, deudas, desglose de liquidez, exposición look-through y principales " +
        "posiciones. Fuente canónica de cifras; importes ya formateados es-ES. Incluye " +
        "`links` con las fuentes citables. Cada posición de inversión trae su identidad " +
        "en la propia fila: `isin`, `providerSymbol` y `units` (participaciones netas). " +
        `Devuelve las ${CHAT_HOLDING_LIMIT} mayores por defecto y cuenta el resto en ` +
        "`omittedHoldings`: si te piden un INVENTARIO («todos los fondos con su ISIN y " +
        `participaciones»), sube \`holdingLimit\` hasta ${MAX_HOLDING_LIMIT} y respóndelo con ` +
        "ESTA lectura — nunca con un get_holding_detail por posición. Un campo AUSENTE " +
        "significa que esa posición no lo tiene registrado, no que no exista.",
      inputSchema: FINANCIAL_CONTEXT_SCHEMA,
      execute: (args) =>
        chatRead(input, async (store) => {
          const scopeId = await resolveScopeId(store, args.scopeId);
          if (!scopeId) return EMPTY_WORKSPACE;
          const result = await catalogRead(
            catalog.get_financial_context,
            {
              scopeId,
              holdingLimit: clampPositiveLimit(args.holdingLimit, {
                defaultLimit: CHAT_HOLDING_LIMIT,
                maxLimit: MAX_HOLDING_LIMIT,
              }),
            },
            store.agentView,
          );
          if (isAgentViewErrorEnvelope(result)) return result;
          return toChatFinancialContext(result.data);
        }),
    }),
    list_scopes: tool({
      description:
        "Lista los scopes disponibles (hogar, miembros, grupos) con su id `wl_scp_…`, " +
        "para consultar otros scopes además del que mira el usuario.",
      inputSchema: EMPTY_SCHEMA,
      execute: () =>
        chatRead(input, async (store) => {
          const result = await catalogRead(catalog.list_scopes, {}, store.agentView);
          if (isAgentViewErrorEnvelope(result)) return result;
          return result.data;
        }),
    }),
    explain_figure: tool({
      description:
        "Explica cómo se calcula una cifra de un scope (fórmula, operandos, posiciones que " +
        "contribuyen y las excluidas). Figuras: net_worth, liquid_net_worth, gross_assets, " +
        "debts, housing_equity, liquidity_breakdown, holding_value (requiere holdingId), " +
        "fire_eligible_assets, fire_progress. `date` (YYYY-MM-DD) la explica histórica.",
      inputSchema: EXPLAIN_FIGURE_SCHEMA,
      execute: (args) =>
        chatRead(input, async (store) => {
          if (!isFigureName(args.figure)) {
            return {
              error: {
                code: "bad_request",
                message: `Unknown figure: ${args.figure}.`,
              },
            };
          }
          const scopeId = await resolveScopeId(store, args.scopeId);
          if (!scopeId) return EMPTY_WORKSPACE;
          const result = await catalogRead(
            catalog.explain_figure,
            {
              figure: args.figure,
              scopeId,
              ...(args.holdingId === undefined ? {} : { holdingId: args.holdingId }),
              ...(args.date === undefined ? {} : { date: args.date }),
            },
            store.agentView,
          );
          if (isAgentViewErrorEnvelope(result)) return result;
          return result.data;
        }),
    }),
    get_workspace: tool({
      description:
        "Ajustes del workspace: modo (individual u hogar) y moneda base, para que las " +
        "respuestas se ajusten al workspace en vez de asumir hogar/EUR.",
      inputSchema: EMPTY_SCHEMA,
      execute: () =>
        chatRead(input, async (store) => {
          const result = await catalogRead(catalog.get_workspace, {}, store.agentView);
          if (isAgentViewErrorEnvelope(result)) return result;
          return result.data;
        }),
    }),
    get_warning_overrides: tool({
      description:
        "Avisos silenciados: el código del aviso y la posición `wl_hld_…` cuyo aviso se " +
        "reconoció, para explicar qué se silenció y dónde.",
      inputSchema: EMPTY_SCHEMA,
      execute: () =>
        chatRead(input, async (store) => {
          const result = await catalogRead(
            catalog.get_warning_overrides,
            {},
            store.agentView,
          );
          if (isAgentViewErrorEnvelope(result)) return result;
          return result.data;
        }),
    }),
    get_member_profile: tool({
      description:
        "Perfil de cada miembro activo: id `wl_mbr_…`, nombre, año y mes de nacimiento (de " +
        "ahí sale la edad de referencia FIRE), país fiscal y tolerancia al riesgo. Para " +
        "personalizar el consejo.",
      inputSchema: EMPTY_SCHEMA,
      execute: () =>
        chatRead(input, async (store) => {
          const result = await catalogRead(
            catalog.get_member_profile,
            {},
            store.agentView,
          );
          if (isAgentViewErrorEnvelope(result)) return result;
          return result.data;
        }),
    }),
  };
}
