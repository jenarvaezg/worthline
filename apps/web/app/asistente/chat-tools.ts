import {
  buildHoldingConnectedSourcePositions,
  buildSourceConnectedSourcePositions,
  DEFAULT_POSITION_LIMIT,
  MAX_POSITION_LIMIT,
} from "@web/agent-view/connected-source-positions";
import {
  buildConnectedSourcesList,
  buildSourceFreshness,
} from "@web/agent-view/connected-sources";
import {
  type AgentViewFinancialContext,
  AgentViewHttpError,
  errorEnvelope,
} from "@web/agent-view/contract";
import {
  buildDataQuality,
  DEFAULT_DATA_QUALITY_LIMIT,
  MAX_DATA_QUALITY_LIMIT,
} from "@web/agent-view/data-quality";
import {
  buildFigureExplanation,
  isFigureName,
} from "@web/agent-view/figure-explanations";
import { buildFinancialContext } from "@web/agent-view/financial-context";
import { buildFireContext } from "@web/agent-view/fire-context";
import { buildFireProjection } from "@web/agent-view/fire-projection-context";
import { buildGoals } from "@web/agent-view/goals-context";
import { buildHoldingDetail } from "@web/agent-view/holding-detail";
import {
  buildHoldingOperations,
  DEFAULT_OPERATION_LIMIT,
  MAX_OPERATION_LIMIT,
} from "@web/agent-view/holding-operations";
import { buildPriceFreshness } from "@web/agent-view/price-freshness";
import { resolveInternalHoldingId } from "@web/agent-view/scope-resolution";
import { listAgentViewScopes } from "@web/agent-view/scopes";
import {
  buildSnapshotHistory,
  DEFAULT_SNAPSHOT_LIMIT,
  MAX_SNAPSHOT_LIMIT,
} from "@web/agent-view/snapshot-history";
import {
  buildTrashSummary,
  DEFAULT_TRASH_LIMIT,
  MAX_TRASH_LIMIT,
} from "@web/agent-view/trash-summary";
import {
  buildMemberProfiles,
  buildWarningOverrides,
  buildWorkspaceInfo,
} from "@web/agent-view/workspace-context";
import {
  parseQuickActions,
  type QuickAction,
  sourceHref,
} from "@web/asistente/assistant-actions";
import {
  AGENT_FILL_EXPOSURE_POLICY,
  buildExposureProfileProposal,
  listExposureProfileFillTargets,
} from "@web/asistente/exposure-profile-proposals";
import type { ScreenSection } from "@web/asistente/screen-context";
import type { AgentViewReadStore } from "@worthline/db";
import { formatMoneyMinor } from "@worthline/domain";
import { jsonSchema, type ToolSet, tool } from "ai";

/**
 * The assistant's chat tools (#629/#630, ADR 0047): thin conversational
 * wrappers over the agent-view builders, called here in-process against the
 * read store. This is intentionally a separate chat catalog, not the MCP
 * catalog: tool names stay in parity where the assistant needs the same lens,
 * while chat-specific payload trimming and money formatting stay local to this
 * boundary. Calculation logic stays in agent-view; the model never defines its
 * own net-worth formula, only summarizes/compares what these reads return.
 *
 * Writes are impossible by construction: tools receive ONLY the read store
 * (`agentView`) — the write API never crosses this boundary (ADR 0044).
 *
 * Two chat-specific concerns wrap every read: money is pre-formatted to es-ES
 * strings so the model can't recite céntimos as euros (the #629 smoke bug),
 * and a missing/unknown fact surfaces as an error envelope instead of throwing
 * — visible uncertainty, never a guess (ADR 0048).
 *
 * Exposure look-through and investment returns are now agent-view facts exposed
 * through the relevant context/detail tools; add dedicated chat wrappers only
 * when the conversation needs a new public tool shape.
 */

export interface ChatReadStore {
  agentView: AgentViewReadStore;
}

export interface ChatToolsInput {
  /** Runs a read against the caller's workspace (tenant already resolved). */
  runWithStore: <T>(run: (store: ChatReadStore) => Promise<T>) => Promise<T>;
  /** YYYY-MM-DD valuation date — the demo clock for demo targets. */
  asOf: string;
}

/** Holdings included in the compact context — enough to reason, cheap in tokens. */
const CHAT_HOLDING_LIMIT = 10;

/** The empty-workspace answer for scope-defaulting tools (ADR 0048). */
const EMPTY_WORKSPACE = { error: "empty_workspace" } as const;

/**
 * Recursively replace every agent-view money object (`{amountMinor, currency}`,
 * the ONLY shape carrying `amountMinor` in the contract) with its formatted
 * es-ES string. The model then cites `"12.585 €"`, never `1258500` céntimos.
 */
function formatChatMoney(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(formatChatMoney);
  if (value === null || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  if (
    typeof record["amountMinor"] === "number" &&
    typeof record["currency"] === "string"
  ) {
    return formatMoneyMinor({
      amountMinor: record["amountMinor"],
      currency: record["currency"],
    });
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, val]) => [key, formatChatMoney(val)]),
  );
}

/**
 * Run one agent-view read for the chat: format its money and turn any
 * `AgentViewHttpError` (unknown id, unsupported figure, bad selector) into the
 * standard error envelope so the assistant states uncertainty instead of the
 * stream dying. A non-agent-view error is a real bug and still throws.
 */
async function chatRead(
  { runWithStore }: ChatToolsInput,
  run: (store: ChatReadStore) => Promise<unknown>,
): Promise<unknown> {
  try {
    return formatChatMoney(await runWithStore(run));
  } catch (error) {
    if (error instanceof AgentViewHttpError) {
      return errorEnvelope(error);
    }
    throw error;
  }
}

/** Resolve the caller's scope, defaulting to the household scope, or null if empty. */
async function resolveScopeId(
  store: ChatReadStore,
  scopeId: string | undefined,
): Promise<string | null> {
  if (scopeId !== undefined) return scopeId;
  const scopes = await listAgentViewScopes(store.agentView);
  return (scopes.find((s) => s.isDefault) ?? scopes[0])?.id ?? null;
}

/** Validate and clamp a model-supplied page size to the HTTP/MCP contract. */
function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AgentViewHttpError({
      code: "bad_request",
      details: { limit },
      message: "limit must be a positive integer.",
      status: 400,
    });
  }
  return Math.min(limit, max);
}

/** One action the model proposed via `suggest_actions`, before validation. */
interface ProposedAction {
  type?: string;
  label?: string;
  /** Public holding id (`wl_hld_…`) to open, when the source is a holding. */
  holding?: string;
  /** Product section to open, when the source is a whole surface. */
  section?: ScreenSection;
  /** Explained figure to open, when the source is a headline number. */
  figure?: string;
  /** Follow-up prompt, for `runSuggestedAnalysis`. */
  prompt?: string;
}

interface ProposedExposureProfileDraft {
  key: string;
  trackedIndex?: string | null;
  ter?: string | null;
  hedged?: boolean;
  breakdowns?: {
    geography?: Record<string, string>;
    currency?: Record<string, string>;
    assetClass?: Record<string, string>;
  };
}

/**
 * Resolve one proposed `openInternalSource` reference to an internal href, or
 * null if it points nowhere we can navigate. The model supplies a PUBLIC
 * holding id; we resolve it to the internal id the product route uses (an
 * unknown id resolves to null, so the action is simply dropped — never a guess).
 */
async function resolveActionHref(
  store: ChatReadStore,
  action: ProposedAction,
): Promise<string | null> {
  if (action.holding !== undefined) {
    try {
      const internalId = await resolveInternalHoldingId(store.agentView, action.holding);
      return sourceHref({ kind: "holding", internalId });
    } catch {
      return null;
    }
  }
  if (action.section !== undefined) {
    return sourceHref({ kind: "section", section: action.section });
  }
  if (action.figure !== undefined) {
    return sourceHref({ kind: "figure", figure: action.figure });
  }
  return null;
}

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
      label: holding.label,
      instrument: holding.instrument,
      direction: holding.direction,
      liquidityTier: holding.liquidityTier,
      currentValue: holding.currentValue,
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

// Chat-owned input schemas. They mirror MCP names where useful, but remain a
// separate ADR 0047 tool boundary with chat-specific execution semantics.
const EMPTY_SCHEMA = jsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

const SCOPE_ONLY_SCHEMA = jsonSchema<{ scopeId?: string }>({
  type: "object",
  properties: { scopeId: { type: "string" } },
  additionalProperties: false,
});

const HOLDING_ID_SCHEMA = jsonSchema<{ holdingId: string }>({
  type: "object",
  properties: { holdingId: { type: "string" } },
  required: ["holdingId"],
  additionalProperties: false,
});

const EXPOSURE_PROFILE_PROPOSAL_SCHEMA = jsonSchema<{
  drafts?: ProposedExposureProfileDraft[];
}>({
  type: "object",
  properties: {
    drafts: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          trackedIndex: { type: ["string", "null"] },
          ter: { type: ["string", "null"] },
          hedged: { type: "boolean" },
          breakdowns: {
            type: "object",
            properties: {
              geography: { type: "object", additionalProperties: { type: "string" } },
              currency: { type: "object", additionalProperties: { type: "string" } },
              assetClass: { type: "object", additionalProperties: { type: "string" } },
            },
            additionalProperties: false,
          },
        },
        required: ["key"],
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
});

export function createChatTools(input: ChatToolsInput): ToolSet {
  const { asOf } = input;

  return {
    get_financial_context: tool({
      description:
        "Foto financiera actual del scope (por defecto el del hogar): patrimonio neto, " +
        "líquido, deudas, desglose de liquidez, exposición look-through y principales " +
        "posiciones. Fuente canónica de cifras; importes ya formateados es-ES. Incluye " +
        "`links` con las fuentes citables.",
      inputSchema: SCOPE_ONLY_SCHEMA,
      execute: (args) =>
        chatRead(input, async (store) => {
          const scopeId = await resolveScopeId(store, args.scopeId);
          if (!scopeId) return EMPTY_WORKSPACE;
          return toChatFinancialContext(
            await buildFinancialContext(store.agentView, {
              scopeId,
              asOf,
              holdingLimit: CHAT_HOLDING_LIMIT,
            }),
          );
        }),
    }),

    list_scopes: tool({
      description:
        "Lista los scopes disponibles (hogar, miembros, grupos) con su id `wl_scp_…`, " +
        "para consultar otros scopes además del que mira el usuario.",
      inputSchema: EMPTY_SCHEMA,
      execute: () => chatRead(input, (store) => listAgentViewScopes(store.agentView)),
    }),

    explain_figure: tool({
      description:
        "Explica cómo se calcula una cifra de un scope (fórmula, operandos, posiciones que " +
        "contribuyen y las excluidas). Figuras: net_worth, liquid_net_worth, gross_assets, " +
        "debts, housing_equity, liquidity_breakdown, holding_value (requiere holdingId), " +
        "fire_eligible_assets, fire_progress. `date` (YYYY-MM-DD) la explica histórica.",
      inputSchema: jsonSchema<{
        figure: string;
        scopeId?: string;
        holdingId?: string;
        date?: string;
      }>({
        type: "object",
        properties: {
          figure: { type: "string" },
          scopeId: { type: "string" },
          holdingId: { type: "string" },
          date: { type: "string" },
        },
        required: ["figure"],
        additionalProperties: false,
      }),
      execute: (args) =>
        chatRead(input, async (store) => {
          if (!isFigureName(args.figure)) {
            throw new AgentViewHttpError({
              code: "bad_request",
              message: `Unknown figure: ${args.figure}.`,
              status: 400,
            });
          }
          const scopeId = await resolveScopeId(store, args.scopeId);
          if (!scopeId) return EMPTY_WORKSPACE;
          return buildFigureExplanation(store.agentView, {
            scopeId,
            figure: args.figure,
            asOf,
            ...(args.holdingId === undefined ? {} : { holdingId: args.holdingId }),
            ...(args.date === undefined ? {} : { date: args.date }),
          });
        }),
    }),

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
          return buildFireContext(store.agentView, { scopeId });
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
          return buildFireProjection(store.agentView, scopeId);
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
          return buildGoals(store.agentView, scopeId);
        }),
    }),

    get_snapshot_history: tool({
      description:
        "Historial de snapshots de patrimonio del scope (cierres mensuales por defecto, o " +
        "cada snapshot con granularity=raw), con filtros de fecha y paginación por cursor.",
      inputSchema: jsonSchema<{
        scopeId?: string;
        granularity?: "monthly-close" | "raw";
        from?: string;
        to?: string;
        sort?: "date" | "-date";
        limit?: number;
        cursor?: string;
        includeHoldingRows?: "none" | "summary" | "full";
      }>({
        type: "object",
        properties: {
          scopeId: { type: "string" },
          granularity: { enum: ["monthly-close", "raw"], type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          sort: { enum: ["date", "-date"], type: "string" },
          limit: { maximum: MAX_SNAPSHOT_LIMIT, minimum: 1, type: "integer" },
          cursor: { type: "string" },
          includeHoldingRows: { enum: ["none", "summary", "full"], type: "string" },
        },
        additionalProperties: false,
      }),
      execute: (args) =>
        chatRead(input, async (store) => {
          const scopeId = await resolveScopeId(store, args.scopeId);
          if (!scopeId) return EMPTY_WORKSPACE;
          return buildSnapshotHistory(store.agentView, {
            scopeId,
            granularity: args.granularity ?? "monthly-close",
            sort: args.sort ?? "date",
            limit: clampLimit(args.limit, DEFAULT_SNAPSHOT_LIMIT, MAX_SNAPSHOT_LIMIT),
            includeHoldingRows: args.includeHoldingRows ?? "none",
            ...(args.from === undefined ? {} : { from: args.from }),
            ...(args.to === undefined ? {} : { to: args.to }),
            ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
          });
        }),
    }),

    get_data_quality: tool({
      description:
        "Señales de calidad de datos del scope: avisos de dominio, precios/sincronizaciones " +
        "obsoletos o fallidos, configuración ausente e historial escaso. Útil para «¿qué " +
        "posiciones parecen obsoletas o sospechosas?». Filtra por categoría o severidad.",
      inputSchema: jsonSchema<{
        scopeId?: string;
        category?: string;
        severity?: "high" | "medium" | "low";
        limit?: number;
        cursor?: string;
      }>({
        type: "object",
        properties: {
          scopeId: { type: "string" },
          category: {
            enum: [
              "warning",
              "price_freshness",
              "source_freshness",
              "missing_configuration",
              "history_coverage",
              "projection_gap",
            ],
            type: "string",
          },
          severity: { enum: ["high", "medium", "low"], type: "string" },
          limit: { maximum: MAX_DATA_QUALITY_LIMIT, minimum: 1, type: "integer" },
          cursor: { type: "string" },
        },
        additionalProperties: false,
      }),
      execute: (args) =>
        chatRead(input, async (store) => {
          const scopeId = await resolveScopeId(store, args.scopeId);
          if (!scopeId) return EMPTY_WORKSPACE;
          return buildDataQuality(store.agentView, {
            scopeId,
            limit: clampLimit(
              args.limit,
              DEFAULT_DATA_QUALITY_LIMIT,
              MAX_DATA_QUALITY_LIMIT,
            ),
            ...(args.category === undefined ? {} : { category: args.category as never }),
            ...(args.severity === undefined ? {} : { severity: args.severity }),
            ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
          });
        }),
    }),

    get_trash_summary: tool({
      description:
        "Posiciones borradas (papelera) del scope, recuperables y fuera del contexto " +
        "financiero principal: id, etiqueta, dirección, valor guardado y fecha de borrado.",
      inputSchema: jsonSchema<{ scopeId?: string; limit?: number; cursor?: string }>({
        type: "object",
        properties: {
          scopeId: { type: "string" },
          limit: { maximum: MAX_TRASH_LIMIT, minimum: 1, type: "integer" },
          cursor: { type: "string" },
        },
        additionalProperties: false,
      }),
      execute: (args) =>
        chatRead(input, async (store) => {
          const scopeId = await resolveScopeId(store, args.scopeId);
          if (!scopeId) return EMPTY_WORKSPACE;
          return buildTrashSummary(store.agentView, {
            scopeId,
            limit: clampLimit(args.limit, DEFAULT_TRASH_LIMIT, MAX_TRASH_LIMIT),
            ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
          });
        }),
    }),

    get_holding_detail: tool({
      description:
        "Detalle completo de una posición por su id `wl_hld_…`: valor, propiedad, instrumento, " +
        "método de valoración, tramo de liquidez, plan de amortización o anclas de valoración, " +
        "y avisos de calidad. Los hechos ausentes se marcan, nunca se inventan.",
      inputSchema: HOLDING_ID_SCHEMA,
      execute: (args) =>
        chatRead(input, (store) => buildHoldingDetail(store.agentView, args.holdingId)),
    }),

    get_operations: tool({
      description:
        "Operaciones (compras y ventas) de una posición de inversión por su id `wl_hld_…`, " +
        "con filtros de fecha y paginación; más recientes primero. Rechaza posiciones no de inversión.",
      inputSchema: jsonSchema<{
        holdingId: string;
        from?: string;
        to?: string;
        sort?: "date" | "-date";
        limit?: number;
        cursor?: string;
      }>({
        type: "object",
        properties: {
          holdingId: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          sort: { enum: ["date", "-date"], type: "string" },
          limit: { maximum: MAX_OPERATION_LIMIT, minimum: 1, type: "integer" },
          cursor: { type: "string" },
        },
        required: ["holdingId"],
        additionalProperties: false,
      }),
      execute: (args) =>
        chatRead(input, (store) =>
          buildHoldingOperations(store.agentView, {
            holdingId: args.holdingId,
            sort: args.sort ?? "-date",
            limit: clampLimit(args.limit, DEFAULT_OPERATION_LIMIT, MAX_OPERATION_LIMIT),
            ...(args.from === undefined ? {} : { from: args.from }),
            ...(args.to === undefined ? {} : { to: args.to }),
            ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
          }),
        ),
    }),

    get_price_freshness: tool({
      description:
        "Frescura del precio en caché de una posición por su id `wl_hld_…`: estado " +
        "(fresh/stale/failed/manual), cuándo se obtuvo y la fuente. Sin cifra de precio. " +
        "`freshness: null` si no hay cotización en caché, nunca un valor inventado.",
      inputSchema: HOLDING_ID_SCHEMA,
      execute: (args) =>
        chatRead(input, (store) => buildPriceFreshness(store.agentView, args.holdingId)),
    }),

    list_connected_sources: tool({
      description:
        "Fuentes conectadas del workspace: id `wl_src_…`, adaptador, etiqueta, última " +
        "sincronización y las posiciones `wl_hld_…` que materializa. Sin credenciales.",
      inputSchema: EMPTY_SCHEMA,
      execute: () =>
        chatRead(input, (store) => buildConnectedSourcesList(store.agentView)),
    }),

    get_source_freshness: tool({
      description:
        "Frescura de valoración de una fuente conectada por su id `wl_src_…`: estado " +
        "(fresh/stale/failed/manual) y cuándo se obtuvo. Sin credenciales ni payload.",
      inputSchema: jsonSchema<{ sourceId: string }>({
        type: "object",
        properties: { sourceId: { type: "string" } },
        required: ["sourceId"],
        additionalProperties: false,
      }),
      execute: (args) =>
        chatRead(input, (store) => buildSourceFreshness(store.agentView, args.sourceId)),
    }),

    get_connected_source_positions: tool({
      description:
        "Posiciones de fuente conectada (monedas / saldos) proyectadas en una posición o una " +
        "fuente. Aporta EXACTAMENTE UNO de holdingId (`wl_hld_…`) o sourceId (`wl_src_…`).",
      inputSchema: jsonSchema<{
        holdingId?: string;
        sourceId?: string;
        limit?: number;
        cursor?: string;
      }>({
        type: "object",
        properties: {
          holdingId: { type: "string" },
          sourceId: { type: "string" },
          limit: { maximum: MAX_POSITION_LIMIT, minimum: 1, type: "integer" },
          cursor: { type: "string" },
        },
        additionalProperties: false,
      }),
      execute: (args) =>
        chatRead(input, (store) => {
          const hasHolding = args.holdingId !== undefined;
          const hasSource = args.sourceId !== undefined;
          if (hasHolding === hasSource) {
            // XOR selector (PRD #328, #339): both or neither is a documented 422.
            throw new AgentViewHttpError({
              code: "unprocessable_entity",
              message:
                "Supply exactly one of holdingId or sourceId for connected-source positions.",
              status: 422,
            });
          }
          const limit = clampLimit(
            args.limit,
            DEFAULT_POSITION_LIMIT,
            MAX_POSITION_LIMIT,
          );
          if (hasHolding) {
            return buildHoldingConnectedSourcePositions(store.agentView, {
              holdingId: args.holdingId!,
              limit,
              ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
            });
          }
          return buildSourceConnectedSourcePositions(store.agentView, {
            sourceId: args.sourceId!,
            limit,
            ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
          });
        }),
    }),

    get_workspace: tool({
      description:
        "Ajustes del workspace: modo (individual u hogar) y moneda base, para que las " +
        "respuestas se ajusten al workspace en vez de asumir hogar/EUR.",
      inputSchema: EMPTY_SCHEMA,
      execute: () => chatRead(input, (store) => buildWorkspaceInfo(store.agentView)),
    }),

    get_warning_overrides: tool({
      description:
        "Avisos silenciados: el código del aviso y la posición `wl_hld_…` cuyo aviso se " +
        "reconoció, para explicar qué se silenció y dónde.",
      inputSchema: EMPTY_SCHEMA,
      execute: () => chatRead(input, (store) => buildWarningOverrides(store.agentView)),
    }),

    get_member_profile: tool({
      description:
        "Perfil de cada miembro activo: id `wl_mbr_…`, nombre, año de nacimiento (edad de " +
        "referencia FIRE), país fiscal y tolerancia al riesgo. Para personalizar el consejo.",
      inputSchema: EMPTY_SCHEMA,
      execute: () => chatRead(input, (store) => buildMemberProfiles(store.agentView)),
    }),

    suggest_actions: tool({
      description:
        "Propón acciones de seguimiento SOLO-LECTURA para el usuario (ADR 0053), tras " +
        "responder. Dos tipos: `openInternalSource` abre una superficie de worthline citada " +
        "— indica `holding` (id `wl_hld_…` que ya has leído), `section` " +
        "(patrimonio/historico/objetivos) o `figure` (p.ej. net_worth); NO pases URLs. " +
        "`runSuggestedAnalysis` sugiere una pregunta de seguimiento con su `prompt`. La app " +
        "descarta lo que no resuelva a una superficie interna. No modifica nada.",
      inputSchema: jsonSchema<{ actions?: ProposedAction[] }>({
        type: "object",
        properties: {
          actions: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              properties: {
                type: {
                  enum: ["openInternalSource", "runSuggestedAnalysis"],
                  type: "string",
                },
                label: { type: "string" },
                holding: { type: "string" },
                section: {
                  enum: ["resumen", "patrimonio", "historico", "objetivos", "ajustes"],
                  type: "string",
                },
                figure: { type: "string" },
                prompt: { type: "string" },
              },
              required: ["type", "label"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      }),
      execute: (args) =>
        input.runWithStore(async (store) => {
          const built: unknown[] = [];
          for (const action of args.actions ?? []) {
            if (action.type === "runSuggestedAnalysis") {
              built.push({
                type: "runSuggestedAnalysis",
                label: action.label,
                prompt: action.prompt,
              });
            } else if (action.type === "openInternalSource") {
              const href = await resolveActionHref(store, action);
              if (href !== null) {
                built.push({ type: "openInternalSource", label: action.label, href });
              }
            }
          }
          // Final trust boundary: only the typed, bounded, internal-href set renders.
          return { actions: parseQuickActions(built) satisfies QuickAction[] };
        }),
    }),

    list_exposure_profile_fill_targets: tool({
      description:
        "Lista posiciones elegibles para rellenar perfiles de exposición, ordenadas gap-first. " +
        "Incluye fund/etf/stock/index/pension_plan con clave ISIN o provider symbol y excluye " +
        "perfiles auto-derivados como cash/property/crypto/commodity. Usa esta tool antes de " +
        "`propose_exposure_profiles`: sin buscar en web, declara solo conocimiento entrenado " +
        "fiable, deja `other` implícito si dudas y nunca normalices un parcial a 100%.",
      inputSchema: EMPTY_SCHEMA,
      execute: () =>
        input.runWithStore(async (store) => ({
          policy: AGENT_FILL_EXPOSURE_POLICY,
          targets: await listExposureProfileFillTargets(store.agentView),
        })),
    }),

    propose_exposure_profiles: tool({
      description:
        "Prepara una propuesta de perfiles de exposición para posiciones elegibles " +
        "(fund/etf/stock/index/pension_plan), keyed by ISIN o provider symbol. No escribe " +
        "nada: devuelve el borrador validado y un before/after para que la app lo previsualice " +
        "y el usuario lo confirme. Pesos en fracción decimal: 0.7 = 70%. Omite campos que " +
        "quieras preservar; usa null solo para limpiarlos.",
      inputSchema: EXPOSURE_PROFILE_PROPOSAL_SCHEMA,
      execute: (args) =>
        input.runWithStore(async (store) => {
          const built = await buildExposureProfileProposal(
            store.agentView,
            args.drafts ?? [],
          );
          return built.ok ? built.proposal : { error: built.error };
        }),
    }),
  };
}
