import type {
  AgentViewConnectedSourceListEntry,
  AgentViewConnectedSourcePosition,
  AgentViewConnectedSourcePositionGroup,
  AgentViewDataQualityCategory,
  AgentViewDataQualitySeverity,
  AgentViewDataQualitySignal,
  AgentViewEnvelope,
  AgentViewErrorEnvelope,
  AgentViewFigureExplanation,
  AgentViewFigureName,
  AgentViewFinancialContext,
  AgentViewFireContext,
  AgentViewHoldingDetail,
  AgentViewIncludeHoldingRows,
  AgentViewOperation,
  AgentViewOperationSort,
  AgentViewPriceFreshnessResult,
  AgentViewScope,
  AgentViewSnapshotEntry,
  AgentViewSnapshotGranularity,
  AgentViewSnapshotSort,
  AgentViewGoal,
  AgentViewMemberProfile,
  AgentViewSourceFreshnessResult,
  AgentViewTrashedHolding,
  AgentViewWarningOverride,
  AgentViewWorkspaceInfo,
} from "./contract";
import { FIGURE_NAMES } from "./figure-explanations";

export interface AgentViewApiClient {
  get: <T>(path: string) => Promise<T>;
}

export interface AgentViewMcpInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  additionalProperties: false;
  required?: string[];
}

export interface AgentViewMcpTool<Input, Output> {
  name: string;
  description: string;
  inputSchema: AgentViewMcpInputSchema;
  invoke: (input: Input) => Promise<Output>;
}

export interface GetFinancialContextInput {
  /** Public scope ID; defaults to the household scope when omitted. */
  scopeId?: string;
  /** Cap on summarized holdings (default 25, max 100). */
  holdingLimit?: number;
}

export interface GetFireContextInput {
  /** Public scope ID; defaults to the household scope when omitted. */
  scopeId?: string;
}

export interface ListGoalsInput {
  /** Public scope ID; defaults to the household scope when omitted. */
  scopeId?: string;
}

export interface ExplainFigureInput {
  /** The figure to explain. */
  figure: AgentViewFigureName;
  /** Public scope ID; defaults to the household scope when omitted. */
  scopeId?: string;
  /** Public holding ID (`wl_hld_…`); required for the `holding_value` figure. */
  holdingId?: string;
  /**
   * `YYYY-MM-DD` to explain the figure HISTORICALLY against that day's exact
   * snapshot (#344); omitted explains the CURRENT figure. Historical FIRE is
   * unsupported (a dated FIRE figure is a 422).
   */
  date?: string;
}

export interface GetSnapshotHistoryInput {
  /** Public scope ID; defaults to the household scope when omitted. */
  scopeId?: string;
  /** Monthly closes (default) or every raw snapshot. */
  granularity?: AgentViewSnapshotGranularity;
  /** Inclusive `YYYY-MM-DD` lower bound. */
  from?: string;
  /** Inclusive `YYYY-MM-DD` upper bound. */
  to?: string;
  /** Chronological (`date`, default) or reverse (`-date`). */
  sort?: AgentViewSnapshotSort;
  /** Page size (default 100, max 500). */
  limit?: number;
  /** Opaque cursor from a previous page's `meta.nextCursor`. */
  cursor?: string;
  /** Frozen-holding-row detail: `none` (default), `summary`, or `full`. */
  includeHoldingRows?: AgentViewIncludeHoldingRows;
}

export interface GetDataQualityInput {
  /** Public scope ID; defaults to the household scope when omitted. */
  scopeId?: string;
  /** Restrict to one category. */
  category?: AgentViewDataQualityCategory;
  /** Restrict to one severity. */
  severity?: AgentViewDataQualitySeverity;
  /** Page size (default 100, max 500). */
  limit?: number;
  /** Opaque cursor from a previous page's `meta.nextCursor`. */
  cursor?: string;
}

export interface GetTrashSummaryInput {
  /** Public scope ID; defaults to the household scope when omitted. */
  scopeId?: string;
  /** Page size (default 100, max 500). */
  limit?: number;
  /** Opaque cursor from a previous page's `meta.nextCursor`. */
  cursor?: string;
}

export interface GetHoldingDetailInput {
  /** Public holding ID (`wl_hld_…`). */
  holdingId: string;
}

export interface GetPriceFreshnessInput {
  /** Public holding ID (`wl_hld_…`). */
  holdingId: string;
}

export interface GetSourceFreshnessInput {
  /** Public connected-source ID (`wl_src_…`). */
  sourceId: string;
}

export interface GetOperationsInput {
  /** Public holding ID (`wl_hld_…`) of an investment holding. */
  holdingId: string;
  /** Inclusive `YYYY-MM-DD` lower bound. */
  from?: string;
  /** Inclusive `YYYY-MM-DD` upper bound. */
  to?: string;
  /** Newest-first (`-date`, default) or chronological (`date`). */
  sort?: AgentViewOperationSort;
  /** Page size (default 100, max 500). */
  limit?: number;
  /** Opaque cursor from a previous page's `meta.nextCursor`. */
  cursor?: string;
}

/**
 * Selector for `get_connected_source_positions` (PRD #328, #339): EXACTLY ONE of
 * `holdingId` (positions for a single connected holding/rung) or `sourceId` (all
 * of a source's positions, grouped by holding/rung). Supplying both or neither is
 * a documented `422`.
 */
export interface GetConnectedSourcePositionsInput {
  /** Public holding ID (`wl_hld_…`) of a connected-source-backed holding. */
  holdingId?: string;
  /** Public source ID (`wl_src_…`). */
  sourceId?: string;
  /** Page size (default 100, max 500). */
  limit?: number;
  /** Opaque cursor from a previous page's `meta.nextCursor`. */
  cursor?: string;
}

/**
 * The shape of a `get_connected_source_positions` response (PRD #328, #339): a
 * holding-scoped call returns a flat positions array; a source-scoped call
 * returns positions grouped by projected holding/rung. The `422` selector error
 * surfaces as the documented error envelope.
 */
export type GetConnectedSourcePositionsOutput =
  | AgentViewEnvelope<AgentViewConnectedSourcePosition[]>
  | AgentViewEnvelope<AgentViewConnectedSourcePositionGroup[]>
  | AgentViewErrorEnvelope;

export interface AgentViewMcpToolCatalog {
  list_scopes: AgentViewMcpTool<
    Record<string, never>,
    AgentViewEnvelope<AgentViewScope[]>
  >;
  get_financial_context: AgentViewMcpTool<
    GetFinancialContextInput,
    AgentViewEnvelope<AgentViewFinancialContext>
  >;
  get_fire_context: AgentViewMcpTool<
    GetFireContextInput,
    AgentViewEnvelope<AgentViewFireContext>
  >;
  explain_figure: AgentViewMcpTool<
    ExplainFigureInput,
    AgentViewEnvelope<AgentViewFigureExplanation>
  >;
  get_snapshot_history: AgentViewMcpTool<
    GetSnapshotHistoryInput,
    AgentViewEnvelope<AgentViewSnapshotEntry[]>
  >;
  get_data_quality: AgentViewMcpTool<
    GetDataQualityInput,
    AgentViewEnvelope<AgentViewDataQualitySignal[]>
  >;
  get_trash_summary: AgentViewMcpTool<
    GetTrashSummaryInput,
    AgentViewEnvelope<AgentViewTrashedHolding[]>
  >;
  get_holding_detail: AgentViewMcpTool<
    GetHoldingDetailInput,
    AgentViewEnvelope<AgentViewHoldingDetail>
  >;
  get_price_freshness: AgentViewMcpTool<
    GetPriceFreshnessInput,
    AgentViewEnvelope<AgentViewPriceFreshnessResult>
  >;
  get_operations: AgentViewMcpTool<
    GetOperationsInput,
    AgentViewEnvelope<AgentViewOperation[]>
  >;
  get_connected_source_positions: AgentViewMcpTool<
    GetConnectedSourcePositionsInput,
    GetConnectedSourcePositionsOutput
  >;
  list_connected_sources: AgentViewMcpTool<
    Record<string, never>,
    AgentViewEnvelope<AgentViewConnectedSourceListEntry[]>
  >;
  get_source_freshness: AgentViewMcpTool<
    GetSourceFreshnessInput,
    AgentViewEnvelope<AgentViewSourceFreshnessResult>
  >;
  get_workspace: AgentViewMcpTool<
    Record<string, never>,
    AgentViewEnvelope<AgentViewWorkspaceInfo>
  >;
  get_warning_overrides: AgentViewMcpTool<
    Record<string, never>,
    AgentViewEnvelope<AgentViewWarningOverride[]>
  >;
  get_member_profile: AgentViewMcpTool<
    Record<string, never>,
    AgentViewEnvelope<AgentViewMemberProfile[]>
  >;
  list_goals: AgentViewMcpTool<ListGoalsInput, AgentViewEnvelope<AgentViewGoal[]>>;
}

const EMPTY_INPUT_SCHEMA: AgentViewMcpInputSchema = {
  additionalProperties: false,
  properties: {},
  type: "object",
};

const SCOPES_PATH = "/api/v1/agent-view/scopes";
const HOLDINGS_PATH = "/api/v1/agent-view/holdings";
const CONNECTED_SOURCES_PATH = "/api/v1/agent-view/connected-sources";
const WORKSPACE_PATH = "/api/v1/agent-view/workspace";
const WARNING_OVERRIDES_PATH = "/api/v1/agent-view/warning-overrides";
const MEMBERS_PATH = "/api/v1/agent-view/members";

export function createAgentViewMcpToolCatalog(
  client: AgentViewApiClient,
): AgentViewMcpToolCatalog {
  return {
    explain_figure: {
      description:
        "Explain how a scope's figure is computed (defaults to the household scope): the value, a human-readable formula with its operand figures, the holdings that contribute (with scope-weighted values), the holdings held out and why, the relevant data-quality notes, and drilldown links. Supported figures: net_worth, liquid_net_worth, gross_assets, debts, housing_equity, liquidity_breakdown, holding_value (requires holdingId), fire_eligible_assets and fire_progress (require a FIRE config, current assumptions only — never a historical FIRE). Pass date (YYYY-MM-DD) to explain the figure HISTORICALLY against that day's exact snapshot: the result carries historical:true, a snapshot reference, and decompositionStatus (full with frozen rows, partial for an old snapshot that stores only the headline figure). A date with no exact snapshot is a 404 (snapshot_not_found, never the nearest); a dated FIRE figure is a 422 (unsupported_historical_fire). An unknown figure is a 400; a figure the scope cannot honour is a 422. Reads are side-effect-free.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          date: { type: "string" },
          figure: { enum: [...FIGURE_NAMES], type: "string" },
          holdingId: { type: "string" },
          scopeId: { type: "string" },
        },
        required: ["figure"],
        type: "object",
      },
      invoke: async (input) => {
        const scopeId = input.scopeId ?? (await defaultScopeId(client));
        const query = explainFigureQuery(input);
        return client.get(
          `${SCOPES_PATH}/${encodeURIComponent(scopeId)}/figure-explanations/${encodeURIComponent(input.figure)}${query}`,
        );
      },
      name: "explain_figure",
    },
    get_connected_source_positions: {
      description:
        "Get connected-source positions (coins / token balances) projected into a holding or a source. Supply EXACTLY ONE of holdingId (one connected holding/rung's positions) or sourceId (all of a source's positions, grouped by projected holding/rung). Each position carries its adapter, source label, projected holding/rung, quantity, unit price when known, value, valuation basis, freshness, and quality signals. Reads are side-effect-free.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          cursor: { type: "string" },
          holdingId: { type: "string" },
          limit: { maximum: 500, minimum: 1, type: "integer" },
          sourceId: { type: "string" },
        },
        type: "object",
      },
      invoke: async (input) => {
        const selectorError = selectorErrorFor(input);
        if (selectorError) {
          return selectorError;
        }

        const query = positionsQuery(input);
        if (input.holdingId !== undefined) {
          return client.get(
            `${HOLDINGS_PATH}/${encodeURIComponent(input.holdingId)}/connected-source-positions${query}`,
          );
        }
        return client.get(
          `${CONNECTED_SOURCES_PATH}/${encodeURIComponent(input.sourceId!)}/positions${query}`,
        );
      },
      name: "get_connected_source_positions",
    },
    get_data_quality: {
      description:
        "Get a scope's data-quality signals (defaults to the household scope): domain warnings (blocking and overrideable), stale/failed prices, stale/failed connected-source syncs, missing configuration (e.g. no FIRE config), sparse/missing snapshot history, and connected-source positions that could not be valued. Each signal carries a category, a normalized severity (high/medium/low), the affected object, a human label, a machine code, an observed date when relevant, whether it is user-fixable, and the original domain warning type when one exists. Filter by category or severity; cursor-paginated. Reads are side-effect-free — surfacing a warning never writes an override.",
      inputSchema: {
        additionalProperties: false,
        properties: {
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
          cursor: { type: "string" },
          limit: { maximum: 500, minimum: 1, type: "integer" },
          scopeId: { type: "string" },
          severity: { enum: ["high", "medium", "low"], type: "string" },
        },
        type: "object",
      },
      invoke: async (input) => {
        const scopeId = input.scopeId ?? (await defaultScopeId(client));
        const query = dataQualityQuery(input);
        return client.get(
          `${SCOPES_PATH}/${encodeURIComponent(scopeId)}/data-quality${query}`,
        );
      },
      name: "get_data_quality",
    },
    get_financial_context: {
      description:
        "Get the compact current financial context for a scope (defaults to the household scope).",
      inputSchema: {
        additionalProperties: false,
        properties: {
          holdingLimit: { maximum: 100, minimum: 1, type: "integer" },
          scopeId: { type: "string" },
        },
        type: "object",
      },
      invoke: async (input) => {
        const scopeId = input.scopeId ?? (await defaultScopeId(client));
        const query =
          input.holdingLimit === undefined ? "" : `?holdingLimit=${input.holdingLimit}`;
        return client.get(
          `${SCOPES_PATH}/${encodeURIComponent(scopeId)}/financial-context${query}`,
        );
      },
      name: "get_financial_context",
    },
    get_fire_context: {
      description:
        "Get the current FIRE context for a scope (defaults to the household scope): configured/unconfigured status, the FIRE config and assumptions, the computed result (FIRE number, eligible assets, gap, progress ratio, coast-FIRE facts when an age is set), the scope-weighted eligible total, and the assets excluded with their reason (primary residence or manual). Figures are current-only — a dated request is rejected. Reads are side-effect-free.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          scopeId: { type: "string" },
        },
        type: "object",
      },
      invoke: async (input) => {
        const scopeId = input.scopeId ?? (await defaultScopeId(client));
        return client.get(`${SCOPES_PATH}/${encodeURIComponent(scopeId)}/fire-context`);
      },
      name: "get_fire_context",
    },
    get_holding_detail: {
      description:
        "Get one holding's full detail by its public ID: value, ownership, instrument, valuation method, liquidity tier, an operation summary (investments), and calculation facts — valuation anchors (appreciating assets), the amortization plan with rate revisions and early repayments (amortized liabilities), or balance anchors with interpolation semantics (anchored liabilities). Missing or unsupported facts are flagged in the quality summary, never guessed.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          holdingId: { type: "string" },
        },
        required: ["holdingId"],
        type: "object",
      },
      invoke: (input) =>
        client.get(`${HOLDINGS_PATH}/${encodeURIComponent(input.holdingId)}`),
      name: "get_holding_detail",
    },
    get_price_freshness: {
      description:
        "Get a holding's cached-price freshness by its public ID: the freshness state (fresh/stale/failed/manual), when the price was last fetched, the providing source, and the degraded reason when one is recorded. Carries no price figure, no provider payload, and no secret. A holding with no cached provider quote (manual or derived) reports freshness: null, never a guess. Reads are side-effect-free.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          holdingId: { type: "string" },
        },
        required: ["holdingId"],
        type: "object",
      },
      invoke: (input) =>
        client.get(
          `${HOLDINGS_PATH}/${encodeURIComponent(input.holdingId)}/price-freshness`,
        ),
      name: "get_price_freshness",
    },
    get_operations: {
      description:
        "Get an investment holding's operations (buys and sells) with date filters and cursor pagination; newest-first by default. Non-investment holdings are rejected.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          cursor: { type: "string" },
          from: { type: "string" },
          holdingId: { type: "string" },
          limit: { maximum: 500, minimum: 1, type: "integer" },
          sort: { enum: ["date", "-date"], type: "string" },
          to: { type: "string" },
        },
        required: ["holdingId"],
        type: "object",
      },
      invoke: (input) => {
        const query = operationsQuery(input);
        return client.get(
          `${HOLDINGS_PATH}/${encodeURIComponent(input.holdingId)}/operations${query}`,
        );
      },
      name: "get_operations",
    },
    get_snapshot_history: {
      description:
        "Get a scope's net-worth snapshot history (monthly closes by default; raw on request), with date filters, cursor pagination, and optional frozen holding rows.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          cursor: { type: "string" },
          from: { type: "string" },
          granularity: { enum: ["monthly-close", "raw"], type: "string" },
          includeHoldingRows: { enum: ["none", "summary", "full"], type: "string" },
          limit: { maximum: 500, minimum: 1, type: "integer" },
          scopeId: { type: "string" },
          sort: { enum: ["date", "-date"], type: "string" },
          to: { type: "string" },
        },
        type: "object",
      },
      invoke: async (input) => {
        const scopeId = input.scopeId ?? (await defaultScopeId(client));
        const query = snapshotHistoryQuery(input);
        return client.get(
          `${SCOPES_PATH}/${encodeURIComponent(scopeId)}/snapshots${query}`,
        );
      },
      name: "get_snapshot_history",
    },
    get_trash_summary: {
      description:
        "Get a scope's trash summary (defaults to the household scope): the recoverable, soft-deleted holdings that live OUTSIDE the main financial context. Each trashed holding carries its public id, label, direction (asset/liability), instrument, stored value/balance when safely available, the date it was trashed when recorded, and read-only restore/hard-delete status facts. Sorted newest-deleted-first, with cursor pagination. Reads are side-effect-free — listing trash never restores, hard-deletes, or mutates anything.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          cursor: { type: "string" },
          limit: { maximum: 500, minimum: 1, type: "integer" },
          scopeId: { type: "string" },
        },
        type: "object",
      },
      invoke: async (input) => {
        const scopeId = input.scopeId ?? (await defaultScopeId(client));
        const query = trashSummaryQuery(input);
        return client.get(
          `${SCOPES_PATH}/${encodeURIComponent(scopeId)}/trash-summary${query}`,
        );
      },
      name: "get_trash_summary",
    },
    list_scopes: {
      description: "List available worthline agent-view scopes.",
      inputSchema: EMPTY_INPUT_SCHEMA,
      invoke: () => client.get(SCOPES_PATH),
      name: "list_scopes",
    },
    list_connected_sources: {
      description:
        "List every connected source in the workspace: its public ID (wl_src_…), adapter, label, last sync time, and the public holding IDs (wl_hld_…) it materializes (one per occupied rung). Carries no credential, token, or raw provider payload. Use get_source_freshness for a source's valuation freshness. Reads are side-effect-free.",
      inputSchema: EMPTY_INPUT_SCHEMA,
      invoke: () => client.get(CONNECTED_SOURCES_PATH),
      name: "list_connected_sources",
    },
    get_source_freshness: {
      description:
        "Get a connected source's valuation freshness by its public ID (wl_src_…): the freshness state (fresh/stale/failed/manual) of its primary price-cache row, when it was last fetched, and the degraded reason when one is recorded. Carries no credential, token, or provider payload. A source that has never been valued reports freshness: null, never a guess. Reads are side-effect-free.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          sourceId: { type: "string" },
        },
        required: ["sourceId"],
        type: "object",
      },
      invoke: (input) =>
        client.get(
          `${CONNECTED_SOURCES_PATH}/${encodeURIComponent(input.sourceId)}/freshness`,
        ),
      name: "get_source_freshness",
    },
    get_workspace: {
      description:
        "Get the workspace settings: its mode (individual or household) and base currency, so answers match the workspace instead of assuming household/EUR. Both are null until the workspace is provisioned. Reads are side-effect-free.",
      inputSchema: EMPTY_INPUT_SCHEMA,
      invoke: () => client.get(WORKSPACE_PATH),
      name: "get_workspace",
    },
    get_warning_overrides: {
      description:
        "List the acknowledged overrideable warnings: each carries the warning code and the public holding ID (wl_hld_…) whose warning was silenced, so you can explain which warning was overridden and where. Pure read — surfacing an override never writes one. Reads are side-effect-free.",
      inputSchema: EMPTY_INPUT_SCHEMA,
      invoke: () => client.get(WARNING_OVERRIDES_PATH),
      name: "get_warning_overrides",
    },
    get_member_profile: {
      description:
        "List each active member's profile: public member ID (wl_mbr_…), name, birth year (the reference age for FIRE projections), fiscal country (ISO alpha-2, for tax-aware suggestions) and risk tolerance (conservative/moderate/aggressive). Fields are null until set. Use it to personalize advice instead of assuming. Reads are side-effect-free.",
      inputSchema: EMPTY_INPUT_SCHEMA,
      invoke: () => client.get(MEMBERS_PATH),
      name: "get_member_profile",
    },
    list_goals: {
      description:
        "List the intermediate goals for a scope (defaults to the household scope): each carries its target amount, deadline, priority (high/medium/low), the public ids of assigned holdings (wl_hld_…), the scope-weighted reserved capital (min of target and assigned value) and the funded ratio (reserved / target, 0..1). Goals do not yet change FIRE eligibility. Reads are side-effect-free.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          scopeId: { type: "string" },
        },
        type: "object",
      },
      invoke: async (input) => {
        const scopeId = input.scopeId ?? (await defaultScopeId(client));
        return client.get(`${SCOPES_PATH}/${encodeURIComponent(scopeId)}/goals`);
      },
      name: "list_goals",
    },
  };
}

/** Serialize the explain-figure input into the API's query string (omitting `scopeId`/`figure`). */
function explainFigureQuery(input: ExplainFigureInput): string {
  const params = new URLSearchParams();
  if (input.holdingId !== undefined) params.set("holdingId", input.holdingId);
  if (input.date !== undefined) params.set("date", input.date);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Serialize the data-quality input into the API's query string (omitting `scopeId`). */
function dataQualityQuery(input: GetDataQualityInput): string {
  const params = new URLSearchParams();
  if (input.category !== undefined) params.set("category", input.category);
  if (input.severity !== undefined) params.set("severity", input.severity);
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  if (input.cursor !== undefined) params.set("cursor", input.cursor);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Serialize the trash-summary input into the API's query string (omitting `scopeId`). */
function trashSummaryQuery(input: GetTrashSummaryInput): string {
  const params = new URLSearchParams();
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  if (input.cursor !== undefined) params.set("cursor", input.cursor);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Serialize the snapshot-history input into the API's query string (omitting `scopeId`). */
function snapshotHistoryQuery(input: GetSnapshotHistoryInput): string {
  const params = new URLSearchParams();
  if (input.granularity !== undefined) params.set("granularity", input.granularity);
  if (input.from !== undefined) params.set("from", input.from);
  if (input.to !== undefined) params.set("to", input.to);
  if (input.sort !== undefined) params.set("sort", input.sort);
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  if (input.cursor !== undefined) params.set("cursor", input.cursor);
  if (input.includeHoldingRows !== undefined) {
    params.set("includeHoldingRows", input.includeHoldingRows);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * Enforce the XOR selector for `get_connected_source_positions` (PRD #328, #339):
 * exactly one of `holdingId`/`sourceId`. Both or neither is a documented `422`
 * error envelope — surfaced before any HTTP call so the contract is identical
 * whichever layer rejects it.
 */
function selectorErrorFor(
  input: GetConnectedSourcePositionsInput,
): AgentViewErrorEnvelope | null {
  const hasHolding = input.holdingId !== undefined;
  const hasSource = input.sourceId !== undefined;

  if (hasHolding === hasSource) {
    return {
      error: {
        code: "unprocessable_entity",
        message:
          "Supply exactly one of holdingId or sourceId for connected-source positions.",
      },
    };
  }

  return null;
}

/** Serialize the connected-source positions input into the API's query string. */
function positionsQuery(input: GetConnectedSourcePositionsInput): string {
  const params = new URLSearchParams();
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  if (input.cursor !== undefined) params.set("cursor", input.cursor);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Serialize the operations input into the API's query string (omitting `holdingId`). */
function operationsQuery(input: GetOperationsInput): string {
  const params = new URLSearchParams();
  if (input.from !== undefined) params.set("from", input.from);
  if (input.to !== undefined) params.set("to", input.to);
  if (input.sort !== undefined) params.set("sort", input.sort);
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  if (input.cursor !== undefined) params.set("cursor", input.cursor);
  const query = params.toString();
  return query ? `?${query}` : "";
}

async function defaultScopeId(client: AgentViewApiClient): Promise<string> {
  const scopes = await client.get<AgentViewEnvelope<AgentViewScope[]>>(SCOPES_PATH);
  const household = scopes.data.find((scope) => scope.isDefault) ?? scopes.data[0];

  if (!household) {
    throw new Error("No agent-view scopes are available.");
  }

  return household.id;
}
