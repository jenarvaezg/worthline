import { MAX_POSITION_LIMIT } from "@web/agent-view/connected-source-positions";
import type { AgentViewDataQualityCategory } from "@web/agent-view/contract";
import { MAX_DATA_QUALITY_LIMIT } from "@web/agent-view/data-quality";
import { MAX_HOLDING_LIMIT } from "@web/agent-view/financial-context";
import { MAX_OPERATION_LIMIT } from "@web/agent-view/holding-operations";
import { MAX_HOLDING_MATCH_LIMIT } from "@web/agent-view/holding-search";
import { MAX_SNAPSHOT_LIMIT } from "@web/agent-view/snapshot-history";
import { MAX_TRASH_LIMIT } from "@web/agent-view/trash-summary";
import { MAX_ATTACHMENT_FILE_NAME_CHARS } from "@web/asistente/attachment-types";
import { MAX_HOLDING_REFERENCE } from "@web/asistente/named-holding";
import type { ScreenSection } from "@web/asistente/screen-context";
import { jsonSchema } from "ai";

/**
 * Input schemas for the read family. Chat-owned: they mirror MCP names where
 * useful, but remain a separate ADR 0047 tool boundary with chat-specific
 * execution semantics.
 *
 * A schema declares the DOMAIN type it produces, never a loose record the tool
 * then casts: a `category` typed as `string` is a cast waiting to happen at the
 * call site, and a cast is where the contract and the code drift apart.
 */

export const EMPTY_SCHEMA = jsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

export const SCOPE_ONLY_SCHEMA = jsonSchema<{ scopeId?: string }>({
  type: "object",
  properties: { scopeId: { type: "string" } },
  additionalProperties: false,
});

/**
 * The compact context, with the holdings cap the caller may RAISE (#1346). Without
 * it an inventory question («todos los fondos con su ISIN») could only be answered
 * by fanning out detail calls, because the chat's cap was fixed at ten rows.
 */
export const FINANCIAL_CONTEXT_SCHEMA = jsonSchema<{
  scopeId?: string;
  holdingLimit?: number;
}>({
  type: "object",
  properties: {
    scopeId: { type: "string" },
    holdingLimit: { maximum: MAX_HOLDING_LIMIT, minimum: 1, type: "integer" },
  },
  additionalProperties: false,
});

export const HOLDING_ID_SCHEMA = jsonSchema<{ holdingId: string }>({
  type: "object",
  properties: { holdingId: { type: "string" } },
  required: ["holdingId"],
  additionalProperties: false,
});

export const MARKET_SYMBOL_SEARCH_SCHEMA = jsonSchema<{
  query: string;
  instrument?: string;
}>({
  type: "object",
  properties: {
    query: { type: "string" },
    instrument: {
      type: "string",
      enum: ["fund", "etf", "stock", "index", "crypto"],
    },
  },
  required: ["query"],
  additionalProperties: false,
});

export const EXPLAIN_FIGURE_SCHEMA = jsonSchema<{
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
});

export const CONTRIBUTION_PLAN_SCHEMA = jsonSchema<{
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
});

export const SNAPSHOT_HISTORY_SCHEMA = jsonSchema<{
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
});

/**
 * The data-quality filter, with `category` typed as the contract's own union: the
 * enum and the TypeScript type are the SAME list, so the tool hands it straight to
 * the catalog instead of casting it through `never`.
 */
export const DATA_QUALITY_SCHEMA = jsonSchema<{
  scopeId?: string;
  category?: AgentViewDataQualityCategory;
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
        "trashed_balance",
        "manual_value_freshness",
        "price_freshness",
        "source_freshness",
        "missing_configuration",
        "savings_coherence",
        "portfolio_reconciliation",
        "transfer_integrity",
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
});

export const TRASH_SUMMARY_SCHEMA = jsonSchema<{
  scopeId?: string;
  limit?: number;
  cursor?: string;
}>({
  type: "object",
  properties: {
    scopeId: { type: "string" },
    limit: { maximum: MAX_TRASH_LIMIT, minimum: 1, type: "integer" },
    cursor: { type: "string" },
  },
  additionalProperties: false,
});

export const HOLDING_SEARCH_SCHEMA = jsonSchema<{
  query: string;
  scopeId?: string;
  limit?: number;
}>({
  type: "object",
  properties: {
    query: { type: "string" },
    scopeId: { type: "string" },
    limit: { maximum: MAX_HOLDING_MATCH_LIMIT, minimum: 1, type: "integer" },
  },
  required: ["query"],
  additionalProperties: false,
});

export const CALCULATION_TRACE_SCHEMA = jsonSchema<{
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
});

export const HOLDING_OPERATIONS_SCHEMA = jsonSchema<{
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
});

export const SOURCE_ID_SCHEMA = jsonSchema<{ sourceId: string }>({
  type: "object",
  properties: { sourceId: { type: "string" } },
  required: ["sourceId"],
  additionalProperties: false,
});

export const CONNECTED_SOURCE_POSITIONS_SCHEMA = jsonSchema<{
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
});

/** One action the model proposed via `suggest_actions`, before validation. */
export interface ProposedAction {
  type?: string;
  label?: string;
  /** Public holding id (`wl_hld_…`) — or the holding's name (#1375) — to open. */
  holding?: string;
  /** Product section to open, when the source is a whole surface. */
  section?: ScreenSection;
  /** Explained figure to open, when the source is a headline number. */
  figure?: string;
  /** Follow-up prompt, for `runSuggestedAnalysis`. */
  prompt?: string;
}

export const SUGGEST_ACTIONS_SCHEMA = jsonSchema<{ actions?: ProposedAction[] }>({
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
          holding: { maxLength: MAX_HOLDING_REFERENCE, type: "string" },
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
});

export const EXTRACTED_DOCUMENT_SCHEMA = jsonSchema<{ fileName: string }>({
  additionalProperties: false,
  properties: {
    fileName: { maxLength: MAX_ATTACHMENT_FILE_NAME_CHARS, type: "string" },
  },
  required: ["fileName"],
  type: "object",
});
