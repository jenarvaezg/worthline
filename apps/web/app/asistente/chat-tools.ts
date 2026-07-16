import { createAgentViewCatalog } from "@web/agent-view/catalog";
import {
  DEFAULT_POSITION_LIMIT,
  MAX_POSITION_LIMIT,
} from "@web/agent-view/connected-source-positions";
import {
  type AgentViewCalculationTrace,
  type AgentViewFinancialContext,
  type AgentViewHoldingDetail,
  AgentViewHttpError,
  errorEnvelope,
} from "@web/agent-view/contract";
import {
  DEFAULT_DATA_QUALITY_LIMIT,
  MAX_DATA_QUALITY_LIMIT,
} from "@web/agent-view/data-quality";
import { isFigureName } from "@web/agent-view/figure-explanations";
import {
  DEFAULT_OPERATION_LIMIT,
  MAX_OPERATION_LIMIT,
} from "@web/agent-view/holding-operations";
import { clampPositiveLimit } from "@web/agent-view/pagination";
import { isAgentViewErrorEnvelope, runCatalogRead } from "@web/agent-view/read-backend";
import { resolveInternalHoldingId } from "@web/agent-view/scope-resolution";
import { listAgentViewScopes } from "@web/agent-view/scopes";
import {
  DEFAULT_SNAPSHOT_LIMIT,
  MAX_SNAPSHOT_LIMIT,
} from "@web/agent-view/snapshot-history";
import { DEFAULT_TRASH_LIMIT, MAX_TRASH_LIMIT } from "@web/agent-view/trash-summary";
import {
  parseQuickActions,
  type QuickAction,
  sourceHref,
} from "@web/asistente/assistant-actions";
import { buildBalanceHistoryProposal } from "@web/asistente/balance-history-proposals";
import {
  buildCorrectionProposal,
  type CorrectionInput,
} from "@web/asistente/correction-proposals";
import {
  buildMaintainerAlertPayload,
  isMaintainerAlertCategory,
  type MaintainerAlertDeclaredFigure,
} from "@web/asistente/maintainer-alert";
import { buildMixedDocumentProposal } from "@web/asistente/mixed-document-proposals";
import { buildPropertyValuationProposal } from "@web/asistente/property-valuation-proposals";
import { buildReconstructionProposal } from "@web/asistente/reconstruction-proposals";
import type { ScreenSection } from "@web/asistente/screen-context";
import { buildStatementImportProposal } from "@web/asistente/statement-import-proposals";
import type {
  AgentViewReadStore,
  AssistantProposalStore,
  MaintainerAlertCategory,
  RaisedMaintainerAlert,
  WorthlineStore,
} from "@worthline/db";
import { formatMoneyMinor } from "@worthline/domain";
import { jsonSchema, type ToolSet, tool } from "ai";

/**
 * The assistant's chat tools (#629/#630, ADR 0047): thin conversational
 * wrappers over the agent-view read catalog, called in-process against the
 * read store. This is intentionally a separate chat catalog, not the MCP
 * transport: tool names stay in parity where the assistant needs the same lens,
 * while chat-specific payload trimming and money formatting stay local to this
 * boundary. Calculation logic stays in agent-view; the model never defines its
 * own net-worth formula, only summarizes/compares what these reads return.
 *
 * Live financial-fact writes are impossible by construction: tools receive the
 * read store (`agentView`) plus the narrow durable assistant-proposal store.
 * The latter persists only typed draft facts and document references; applying
 * them still requires the separate explicit-confirmation server action.
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
  assistantProposals?: AssistantProposalStore;
  liabilities?: WorthlineStore["liabilities"];
  assets?: WorthlineStore["assets"];
}

export interface ChatToolsInput {
  /** Runs one scoped tool operation against the caller's resolved workspace. */
  runWithStore: <T>(run: (store: ChatReadStore) => Promise<T>) => Promise<T>;
  /** YYYY-MM-DD valuation date — the demo clock for demo targets. */
  asOf: string;
  /**
   * Raise a maintainer alert to the control plane (#1050, ADR 0064). Bound by
   * the route to the caller's resolved workspace id, so the tool never needs to
   * know it. Absent in read-only contexts (evals, unit fixtures): the tool then
   * reports the alert as unavailable and the repair path is unaffected.
   */
  raiseMaintainerAlert?: (input: {
    holdingId: string;
    category: MaintainerAlertCategory;
    payload: unknown;
  }) => Promise<RaisedMaintainerAlert | null>;
}

/** Holdings included in the compact context — enough to reason, cheap in tokens. */
const CHAT_HOLDING_LIMIT = 10;

/** The empty-workspace answer for scope-defaulting tools (ADR 0048). */
const EMPTY_WORKSPACE = { error: "empty_workspace" } as const;

const catalog = createAgentViewCatalog();

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

const STATEMENT_IMPORT_PROPOSAL_SCHEMA = jsonSchema<{
  broker?: string;
  documentName?: string;
  proposalId?: string;
  rawText?: string;
}>({
  type: "object",
  properties: {
    broker: { type: "string" },
    documentName: { type: "string" },
    proposalId: { type: "string" },
    rawText: { type: "string" },
  },
  required: ["rawText"],
  additionalProperties: false,
});

const BALANCE_HISTORY_PROPOSAL_SCHEMA = jsonSchema<{
  liabilityId?: string;
  documentName?: string;
  rows?: Array<{ date: string; balanceMinor: number; annualRate?: string }>;
}>({
  type: "object",
  properties: {
    liabilityId: { type: "string" },
    documentName: { type: "string" },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          balanceMinor: { type: "number" },
          annualRate: { type: "string" },
        },
        required: ["date", "balanceMinor"],
        additionalProperties: false,
      },
    },
  },
  required: ["liabilityId", "rows"],
  additionalProperties: false,
});

const RECONSTRUCTION_PROPOSAL_SCHEMA = jsonSchema<{
  holdingId?: string;
  summary?: string;
  documentName?: string;
  rows?: Array<{ date: string; balanceMinor: number }>;
}>({
  type: "object",
  properties: {
    holdingId: { type: "string" },
    summary: { type: "string" },
    documentName: { type: "string" },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          balanceMinor: { type: "number" },
        },
        required: ["date", "balanceMinor"],
        additionalProperties: false,
      },
    },
  },
  required: ["holdingId", "rows"],
  additionalProperties: false,
});

const CORRECTION_PROPOSAL_SCHEMA = jsonSchema<{
  holdingId?: string;
  summary?: string;
  correction?: {
    kind?: string;
    balanceMinor?: number;
    valueMinor?: number;
    date?: string;
    endDate?: string;
    monthlyPaymentMinor?: number;
    annualRate?: string;
    debtModel?: string;
    name?: string;
    ownership?: Array<{ memberId: string; shareBps: number }>;
    cadence?: string | null;
    plan?: {
      annualInterestRate?: string;
      termMonths?: number;
      firstPaymentDate?: string;
    };
  };
}>({
  type: "object",
  properties: {
    holdingId: { type: "string" },
    summary: { type: "string" },
    correction: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["declare_balance", "declare_value", "change_debt_model", "edit_config"],
        },
        balanceMinor: { type: "number" },
        valueMinor: { type: "number" },
        date: { type: "string" },
        endDate: { type: "string" },
        monthlyPaymentMinor: { type: "number" },
        annualRate: { type: "string" },
        debtModel: { type: "string", enum: ["amortizable", "revolving", "informal"] },
        name: { type: "string" },
        ownership: {
          type: "array",
          items: {
            type: "object",
            properties: {
              memberId: { type: "string" },
              shareBps: { type: "number" },
            },
            required: ["memberId", "shareBps"],
            additionalProperties: false,
          },
        },
        cadence: { type: ["string", "null"], enum: ["step", "interpolated", null] },
        plan: {
          type: "object",
          properties: {
            annualInterestRate: { type: "string" },
            termMonths: { type: "number" },
            firstPaymentDate: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  required: ["holdingId", "correction"],
  additionalProperties: false,
});

const MIXED_DOCUMENT_PROPOSAL_SCHEMA = jsonSchema<{
  documentName?: string;
  documentSha256?: string;
  segments?: Array<Record<string, unknown>>;
}>({
  type: "object",
  properties: {
    documentName: { type: "string" },
    documentSha256: { type: "string" },
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: {
            enum: ["investment_statement", "debt_balance_history", "property_valuation"],
            type: "string",
          },
          confidence: { enum: ["certain", "uncertain"], type: "string" },
          broker: { type: "string" },
          rawText: { type: "string" },
          liabilityId: { type: "string" },
          assetId: { type: "string" },
          valuationDate: { type: "string" },
          valueMinor: { type: "number" },
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: { type: "string" },
                balanceMinor: { type: "number" },
                annualRate: { type: "string" },
              },
              required: ["date", "balanceMinor"],
              additionalProperties: false,
            },
          },
        },
        required: ["kind", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["documentName", "documentSha256", "segments"],
  additionalProperties: false,
});

const PROPERTY_VALUATION_PROPOSAL_SCHEMA = jsonSchema<{
  assetId?: string;
  documentName?: string;
  documentSha256?: string;
  valuationDate?: string;
  valueMinor?: number;
}>({
  type: "object",
  properties: {
    assetId: { type: "string" },
    documentName: { type: "string" },
    documentSha256: { type: "string" },
    valuationDate: { type: "string" },
    valueMinor: { type: "integer" },
  },
  required: ["assetId", "documentName", "documentSha256", "valuationDate", "valueMinor"],
  additionalProperties: false,
});

const RAISE_MAINTAINER_ALERT_SCHEMA = jsonSchema<{
  holdingId: string;
  category: MaintainerAlertCategory;
  summary: string;
  declaredBalanceMinor?: number;
  declaredDate?: string;
  declaredSource?: string;
  extractedData?: Record<string, unknown>;
  conversationRef?: string;
}>({
  type: "object",
  properties: {
    holdingId: { type: "string" },
    category: { enum: ["infidelity", "residual", "sync_source"], type: "string" },
    summary: { type: "string" },
    declaredBalanceMinor: { type: "integer" },
    declaredDate: { type: "string" },
    declaredSource: { type: "string" },
    extractedData: { type: "object", additionalProperties: true },
    conversationRef: { type: "string" },
  },
  required: ["holdingId", "category", "summary"],
  additionalProperties: false,
});

export function createChatTools(input: ChatToolsInput): ToolSet {
  const catalogOptions = { asOf: input.asOf };
  const catalogRead = <Input, Output>(
    tool: Parameters<typeof runCatalogRead<Input, Output>>[0],
    catalogInput: Input,
    agentView: AgentViewReadStore,
  ) => runCatalogRead(tool, catalogInput, agentView, catalogOptions);

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
          const result = await catalogRead(
            catalog.get_financial_context,
            { scopeId, holdingLimit: CHAT_HOLDING_LIMIT },
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
        "no verdad ejecutada; las operaciones confirmadas siguen en get_operations.",
      inputSchema: jsonSchema<{
        scopeId?: string;
        month?: string;
        growthAssumption?: "flat" | "historical";
        reconciliationWindowDays?: number;
      }>({
        type: "object",
        properties: {
          scopeId: { type: "string" },
          month: { type: "string" },
          growthAssumption: { enum: ["flat", "historical"], type: "string" },
          reconciliationWindowDays: { maximum: 366, minimum: 1, type: "integer" },
        },
      }),
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
              ...(args.category === undefined
                ? {}
                : { category: args.category as never }),
              ...(args.severity === undefined ? {} : { severity: args.severity }),
              ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
            },
            store.agentView,
          );
          if (isAgentViewErrorEnvelope(result)) return result;
          return { signals: result.data, meta: result.meta };
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

    get_holding_detail: tool({
      description:
        "Detalle completo de una posición por su id `wl_hld_…`: valor, propiedad, instrumento, " +
        "método de valoración, tramo de liquidez, plan de amortización o anclas de valoración, " +
        "y avisos de calidad. Los hechos ausentes se marcan, nunca se inventan.",
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
        "Traza de cálculo de una deuda por su id `wl_hld_…`: el cuadro del motor — para una " +
        "deuda amortizable, las fronteras de cuota con el desglose interés/principal y los " +
        "eventos (revisiones de tipo, amortizaciones anticipadas) enganchados a cada frontera; " +
        "para revolving/informal, sus anclas de saldo — más la reconciliación por fecha del " +
        "saldo vivo recomputado frente al persistido en snapshot, el check de infidelidad " +
        "(saldos persistidos que la config actual ya no reproduce) y la tolerancia de modelado " +
        "max(1 €, 0,05 % del saldo). Pasa declaredBalanceMinor (céntimos) y declaredDate " +
        "(YYYY-MM-DD) opcional para obtener el residuo de una cifra citada por el usuario frente " +
        "al saldo vivo y si está dentro de tolerancia. Úsala ANTES de diagnosticar una queja de " +
        "cifra equivocada, para no rehacer tú la aritmética de amortización. Solo deudas con " +
        "modelo configurado; el resto devuelve error.",
      inputSchema: jsonSchema<{
        holdingId: string;
        declaredBalanceMinor?: number;
        declaredDate?: string;
      }>({
        type: "object",
        properties: {
          holdingId: { type: "string" },
          declaredBalanceMinor: { type: "integer" },
          declaredDate: { type: "string" },
        },
        required: ["holdingId"],
        additionalProperties: false,
      }),
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
      inputSchema: jsonSchema<{ sourceId: string }>({
        type: "object",
        properties: { sourceId: { type: "string" } },
        required: ["sourceId"],
        additionalProperties: false,
      }),
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
        "Perfil de cada miembro activo: id `wl_mbr_…`, nombre, año de nacimiento (edad de " +
        "referencia FIRE), país fiscal y tolerancia al riesgo. Para personalizar el consejo.",
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

    propose_statement_import: tool({
      description:
        "Prepara una propuesta de importación de extracto de inversión (plantilla CSV). " +
        "Pasa el texto y nombre del documento tal cual (sin calcular números). Se persisten " +
        "solo los movimientos extraídos y la referencia nombre/hash; el texto se descarta. " +
        "Para acumular otro fichero en la misma propuesta, pasa el proposalId devuelto antes. " +
        "La confirmación re-deriva el matching vivo y sella source: agent.",
      inputSchema: STATEMENT_IMPORT_PROPOSAL_SCHEMA,
      execute: (args) =>
        input.runWithStore(async (store) => {
          if (!store.assistantProposals) {
            return { error: "proposal_persistence_unavailable" };
          }
          const built = await buildStatementImportProposal(
            {
              agentView: store.agentView,
              assistantProposals: store.assistantProposals,
            },
            {
              broker: args.broker ?? "plantilla",
              ...(args.documentName === undefined
                ? {}
                : { documentName: args.documentName }),
              ...(args.proposalId === undefined ? {} : { proposalId: args.proposalId }),
              rawText: args.rawText ?? "",
            },
          );
          return built.ok ? built.proposal : { error: built.error };
        }),
    }),
    propose_balance_history_import: tool({
      description:
        "Prepara una propuesta para una deuda amortizable inequívoca a partir de saldos observados en un cuadro de amortización; liabilityId es el public holding id wl_hld_… obtenido de las tools de lectura. " +
        "No infieras capital, plazo ni cuota: envía solo fecha, saldo en céntimos y, si consta, tipo anual. " +
        "La app calcula la curva y exige reconciliación exacta con el saldo actual antes de confirmar.",
      inputSchema: BALANCE_HISTORY_PROPOSAL_SCHEMA,
      execute: (args) =>
        input.runWithStore(async (store) => {
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
            { ...args, liabilityId },
            input.asOf,
          );
          return built.ok ? built.proposal : { error: built.error };
        }),
    }),
    propose_property_valuation_anchor: tool({
      description:
        "Prepara una propuesta de ancla de tasación para un inmueble inequívoco a partir de un documento ya extraído por el seam de adjuntos. Pasa nombre y SHA-256 reales del documento, y extrae únicamente fecha y valor total en céntimos; la app calcula la curva y la marca como no verificada.",
      inputSchema: PROPERTY_VALUATION_PROPOSAL_SCHEMA,
      execute: (args) =>
        input.runWithStore(async (store) => {
          if (!store.assistantProposals || !store.assets)
            return { error: "proposal_persistence_unavailable" };
          const assetId = await resolveInternalHoldingId(
            store.agentView,
            args.assetId ?? "",
          );
          const built = await buildPropertyValuationProposal(
            { assistantProposals: store.assistantProposals, assets: store.assets },
            { ...args, assetId },
            input.asOf,
          );
          return built.ok ? built.proposal : { error: built.error };
        }),
    }),
    propose_correction: tool({
      description:
        "Prepara una propuesta de CORRECCIÓN «Solo desde hoy» para UN holding mal modelado (holdingId es el public id wl_hld_… de las tools de lectura). Úsala solo tras leer get_calculation_trace y normalizar la magnitud citada (principal vs «total pendiente» con devengo). Radio: una propuesta = un holding. " +
        "correction.kind: 'declare_balance' (deuda: declara el saldo real hoy; en amortizable envía endDate y exactamente uno de annualRate o monthlyPaymentMinor → re-baseline ADR 0056; en revolving/informal → balance anchor), " +
        "'declare_value' (activo: valueMinor real de hoy → valuation anchor), " +
        "'change_debt_model' (debtModel destino cuando el modelo era el error), " +
        "'edit_config' (name, ownership, cadence, o plan.{annualInterestRate,termMonths,firstPaymentDate}). " +
        "No escribas a holdings de fuente conectada (Binance/Numista): ahí el dueño es el sync, guía a mapeo/fuente. Split, alta o baja → wizard o papelera, no esta tool.",
      inputSchema: CORRECTION_PROPOSAL_SCHEMA,
      execute: (args) =>
        input.runWithStore(async (store) => {
          if (!store.assistantProposals || !store.liabilities || !store.assets) {
            return { error: "proposal_persistence_unavailable" };
          }
          if (!args.correction?.kind) return { error: "correction_kind_required" };
          const internalId = await resolveInternalHoldingId(
            store.agentView,
            args.holdingId ?? "",
          );
          const built = await buildCorrectionProposal(
            {
              assets: store.assets,
              assistantProposals: store.assistantProposals,
              liabilities: store.liabilities,
            },
            {
              correction: args.correction as unknown as CorrectionInput,
              holdingId: internalId,
              publicHoldingId: args.holdingId ?? "",
              ...(args.summary === undefined ? {} : { summary: args.summary }),
            },
            input.asOf,
          );
          return built.ok ? built.proposal : { error: built.error };
        }),
    }),
    propose_reconstruction: tool({
      description:
        "Prepara una propuesta de CORRECCIÓN «Reconstruir historia» para UNA deuda amortizable mal modelada (holdingId es el public id wl_hld_… de las tools de lectura), a partir de una serie de saldos fechados observados en un extracto o cuadro de amortización — normalmente extraídos de un adjunto (PDF incluido). " +
        "Envía solo fecha (YYYY-MM-DD) y saldo observado en céntimos; NO infieras capital, plazo, cuota ni tipo (la app re-deriva el tipo de la curva vigente). " +
        "La app reconstruye la curva como cadena de re-baselines (ADR 0056), la reconcilia con el saldo conocido y muestra la superficie C con edición punto a punto; la confirmación re-proyecta la serie y aplica un único lote atómico. " +
        "Para declarar solo el saldo real de hoy sin tocar el pasado usa propose_correction (declare_balance). No escribas a deudas de fuente conectada.",
      inputSchema: RECONSTRUCTION_PROPOSAL_SCHEMA,
      execute: (args) =>
        input.runWithStore(async (store) => {
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
              rows: args.rows ?? [],
              ...(args.summary === undefined ? {} : { summary: args.summary }),
              ...(args.documentName === undefined
                ? {}
                : { documentName: args.documentName }),
            },
            input.asOf,
          );
          return built.ok ? built.proposal : { error: built.error };
        }),
    }),
    propose_mixed_document_import: tool({
      description:
        "Segmenta un documento mixto y prepara UNA propuesta multi-dominio. Agrupa por tipo y activo, y usa confidence=certain solo cuando tipo, columnas y activo son inequívocos. Si cualquier segmento es dudoso, NO llames esta tool: pregunta al usuario. Usa ids públicos wl_hld_… para deuda/inmueble; la app enruta cada segmento a su extractor tipado, calcula previews y confirma todo-o-nada con un único ripple.",
      inputSchema: MIXED_DOCUMENT_PROPOSAL_SCHEMA,
      execute: (args) =>
        input.runWithStore(async (store) => {
          if (!store.assistantProposals || !store.liabilities || !store.assets)
            return { error: "proposal_persistence_unavailable" };
          const segments = [];
          for (const segment of args.segments ?? []) {
            if (
              (segment.kind === "debt_balance_history" ||
                segment.kind === "property_valuation") &&
              typeof segment[
                segment.kind === "debt_balance_history" ? "liabilityId" : "assetId"
              ] === "string"
            ) {
              const key =
                segment.kind === "debt_balance_history" ? "liabilityId" : "assetId";
              segments.push({
                ...segment,
                [key]: await resolveInternalHoldingId(
                  store.agentView,
                  segment[key] as string,
                ),
              });
            } else {
              segments.push(segment);
            }
          }
          const built = await buildMixedDocumentProposal(
            {
              agentView: store.agentView,
              assets: store.assets,
              assistantProposals: store.assistantProposals,
              liabilities: store.liabilities,
            },
            { ...args, segments },
            input.asOf,
          );
          return built.ok ? built.proposal : { error: built.error };
        }),
    }),
    raise_maintainer_alert: tool({
      description:
        "Levanta una ALERTA FORENSE SOLO-MANTENEDOR cuando huela un bug de cálculo de worthline " +
        "(no una duda del usuario). Camino separado de las propuestas y de las señales de calidad " +
        "de datos de cara al usuario. Úsala SOLO tras leer get_calculation_trace y normalizar la " +
        "magnitud, en tres categorías: `infidelity` (un saldo persistido que la config actual ya no " +
        "reproduce — fidelity.faithful=false), `residual` (residuo inexplicado por encima de la " +
        "tolerancia tras verificar la config), `sync_source` (el olor es de fuente conectada/sync, no " +
        "de cálculo). Pasa holdingId (`wl_hld_…`), category, un summary con tu diagnóstico, y si " +
        "aplica declaredBalanceMinor (céntimos)/declaredDate/declaredSource, extractedData " +
        "(datos estructurados del documento, NUNCA el binario) y conversationRef. La app adjunta " +
        "sola el snapshot de config y la traza de cálculo completa. La reparación NUNCA espera a la " +
        "alerta: propón y arregla igual.",
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
