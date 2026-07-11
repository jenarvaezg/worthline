import type {
  AgentViewConnectedSourceListEntry,
  AgentViewConnectedSourcePosition,
  AgentViewConnectedSourcePositionGroup,
  AgentViewContributionPlanContext,
  AgentViewDataQualityCategory,
  AgentViewDataQualitySeverity,
  AgentViewDataQualitySignal,
  AgentViewEnvelope,
  AgentViewErrorEnvelope,
  AgentViewFigureExplanation,
  AgentViewFigureName,
  AgentViewFinancialContext,
  AgentViewFireContext,
  AgentViewFireProjection,
  AgentViewGoal,
  AgentViewHoldingDetail,
  AgentViewIncludeHoldingRows,
  AgentViewMemberProfile,
  AgentViewOperation,
  AgentViewOperationSort,
  AgentViewPriceFreshnessResult,
  AgentViewScope,
  AgentViewSnapshotEntry,
  AgentViewSnapshotGranularity,
  AgentViewSnapshotSort,
  AgentViewSourceFreshnessResult,
  AgentViewTrashedHolding,
  AgentViewWarningOverride,
  AgentViewWorkspaceInfo,
} from "./contract";
import { AgentViewHttpError } from "./contract";
import { FIGURE_NAMES } from "./figure-explanations";

/**
 * The agent-view MCP catalog: ONE source of truth for every tool's name,
 * description, input schema, and dispatch logic (#576). A tool's `run` expresses
 * WHAT it reads against an {@link AgentViewBackend} port; the two adapters —
 * the HTTP API client (`mcp.ts`) and the internal read store
 * (`internal-catalog.ts`) — supply HOW. Default-scope resolution and the
 * connected-source-positions XOR selector live here once, so HTTP, MCP, and chat
 * adapters share that behavior. The in-app assistant keeps a separate chat
 * catalog (ADR 0047) for conversation-specific trimming and money formatting,
 * but dispatches reads through this same backend seam (#747).
 */

/** A hand-written JSON Schema for a tool's input (per ADR 0023 and #398 — no Zod). */
export interface AgentViewMcpInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  additionalProperties: false;
  required?: string[];
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

export interface GetFireProjectionInput {
  /** Public scope ID; defaults to the household scope when omitted. */
  scopeId?: string;
}

export interface GetContributionPlanInput {
  /** Public scope ID; defaults to the household scope when omitted. */
  scopeId?: string;
  /** `YYYY-MM` month for the allocation view; defaults to the current UTC month. */
  month?: string;
  /** Growth assumption for the what-if trajectory. */
  growthAssumption?: "flat" | "historical";
  /** Days forward from today for the reconciliation window (default 90). */
  reconciliationWindowDays?: number;
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

/**
 * The data-access port every catalog tool reads through. The scope-defaulting
 * tools receive an already-resolved `scopeId` (the catalog handles defaulting);
 * page-size clamping and figure-name validation are the backend's own concern so
 * each adapter can honor its layer's contract (the HTTP route clamps/validates;
 * the read store clamps/validates in-process).
 */
export interface AgentViewBackend {
  listScopes(): Promise<AgentViewEnvelope<AgentViewScope[]>>;
  financialContext(
    scopeId: string,
    params: { holdingLimit?: number },
  ): Promise<AgentViewEnvelope<AgentViewFinancialContext>>;
  fireContext(scopeId: string): Promise<AgentViewEnvelope<AgentViewFireContext>>;
  explainFigure(
    scopeId: string,
    params: { figure: AgentViewFigureName; holdingId?: string; date?: string },
  ): Promise<AgentViewEnvelope<AgentViewFigureExplanation>>;
  snapshotHistory(
    scopeId: string,
    params: Omit<GetSnapshotHistoryInput, "scopeId">,
  ): Promise<AgentViewEnvelope<AgentViewSnapshotEntry[]>>;
  dataQuality(
    scopeId: string,
    params: Omit<GetDataQualityInput, "scopeId">,
  ): Promise<AgentViewEnvelope<AgentViewDataQualitySignal[]>>;
  trashSummary(
    scopeId: string,
    params: Omit<GetTrashSummaryInput, "scopeId">,
  ): Promise<AgentViewEnvelope<AgentViewTrashedHolding[]>>;
  holdingDetail(holdingId: string): Promise<AgentViewEnvelope<AgentViewHoldingDetail>>;
  priceFreshness(
    holdingId: string,
  ): Promise<AgentViewEnvelope<AgentViewPriceFreshnessResult>>;
  operations(
    params: GetOperationsInput,
  ): Promise<AgentViewEnvelope<AgentViewOperation[]>>;
  holdingConnectedSourcePositions(params: {
    holdingId: string;
    limit?: number;
    cursor?: string;
  }): Promise<AgentViewEnvelope<AgentViewConnectedSourcePosition[]>>;
  sourceConnectedSourcePositions(params: {
    sourceId: string;
    limit?: number;
    cursor?: string;
  }): Promise<AgentViewEnvelope<AgentViewConnectedSourcePositionGroup[]>>;
  connectedSources(): Promise<AgentViewEnvelope<AgentViewConnectedSourceListEntry[]>>;
  sourceFreshness(
    sourceId: string,
  ): Promise<AgentViewEnvelope<AgentViewSourceFreshnessResult>>;
  workspace(): Promise<AgentViewEnvelope<AgentViewWorkspaceInfo>>;
  warningOverrides(): Promise<AgentViewEnvelope<AgentViewWarningOverride[]>>;
  memberProfiles(): Promise<AgentViewEnvelope<AgentViewMemberProfile[]>>;
  goals(scopeId: string): Promise<AgentViewEnvelope<AgentViewGoal[]>>;
  fireProjection(scopeId: string): Promise<AgentViewEnvelope<AgentViewFireProjection>>;
  contributionPlan(
    scopeId: string,
    params: Omit<GetContributionPlanInput, "scopeId">,
  ): Promise<AgentViewEnvelope<AgentViewContributionPlanContext>>;
}

/** One catalog tool: its metadata plus a backend-parametrized read. */
export interface AgentViewCatalogTool<Input, Output> {
  name: string;
  description: string;
  inputSchema: AgentViewMcpInputSchema;
  run: (input: Input, backend: AgentViewBackend) => Promise<Output>;
}

export interface AgentViewCatalog {
  list_scopes: AgentViewCatalogTool<
    Record<string, never>,
    AgentViewEnvelope<AgentViewScope[]>
  >;
  get_financial_context: AgentViewCatalogTool<
    GetFinancialContextInput,
    AgentViewEnvelope<AgentViewFinancialContext>
  >;
  get_fire_context: AgentViewCatalogTool<
    GetFireContextInput,
    AgentViewEnvelope<AgentViewFireContext>
  >;
  explain_figure: AgentViewCatalogTool<
    ExplainFigureInput,
    AgentViewEnvelope<AgentViewFigureExplanation>
  >;
  get_snapshot_history: AgentViewCatalogTool<
    GetSnapshotHistoryInput,
    AgentViewEnvelope<AgentViewSnapshotEntry[]>
  >;
  get_data_quality: AgentViewCatalogTool<
    GetDataQualityInput,
    AgentViewEnvelope<AgentViewDataQualitySignal[]>
  >;
  get_trash_summary: AgentViewCatalogTool<
    GetTrashSummaryInput,
    AgentViewEnvelope<AgentViewTrashedHolding[]>
  >;
  get_holding_detail: AgentViewCatalogTool<
    GetHoldingDetailInput,
    AgentViewEnvelope<AgentViewHoldingDetail>
  >;
  get_price_freshness: AgentViewCatalogTool<
    GetPriceFreshnessInput,
    AgentViewEnvelope<AgentViewPriceFreshnessResult>
  >;
  get_operations: AgentViewCatalogTool<
    GetOperationsInput,
    AgentViewEnvelope<AgentViewOperation[]>
  >;
  get_connected_source_positions: AgentViewCatalogTool<
    GetConnectedSourcePositionsInput,
    GetConnectedSourcePositionsOutput
  >;
  list_connected_sources: AgentViewCatalogTool<
    Record<string, never>,
    AgentViewEnvelope<AgentViewConnectedSourceListEntry[]>
  >;
  get_source_freshness: AgentViewCatalogTool<
    GetSourceFreshnessInput,
    AgentViewEnvelope<AgentViewSourceFreshnessResult>
  >;
  get_workspace: AgentViewCatalogTool<
    Record<string, never>,
    AgentViewEnvelope<AgentViewWorkspaceInfo>
  >;
  get_warning_overrides: AgentViewCatalogTool<
    Record<string, never>,
    AgentViewEnvelope<AgentViewWarningOverride[]>
  >;
  get_member_profile: AgentViewCatalogTool<
    Record<string, never>,
    AgentViewEnvelope<AgentViewMemberProfile[]>
  >;
  list_goals: AgentViewCatalogTool<ListGoalsInput, AgentViewEnvelope<AgentViewGoal[]>>;
  get_fire_projection: AgentViewCatalogTool<
    GetFireProjectionInput,
    AgentViewEnvelope<AgentViewFireProjection>
  >;
  get_contribution_plan: AgentViewCatalogTool<
    GetContributionPlanInput,
    AgentViewEnvelope<AgentViewContributionPlanContext>
  >;
}

const EMPTY_INPUT_SCHEMA: AgentViewMcpInputSchema = {
  additionalProperties: false,
  properties: {},
  type: "object",
};

const HOLDING_LIMIT_INPUT_SCHEMA = clampedPositiveIntegerSchema("holdings cap", 100);
const PAGE_LIMIT_INPUT_SCHEMA = clampedPositiveIntegerSchema("page size", 500);

function clampedPositiveIntegerSchema(label: string, max: number) {
  return {
    description: `Positive integer ${label}; values above ${max} are accepted and clamped to ${max}.`,
    minimum: 1,
    type: "integer" as const,
  };
}

/**
 * The selector error envelope for `get_connected_source_positions` when the XOR
 * constraint (exactly one of holdingId/sourceId) is violated — surfaced before
 * any backend read so the contract is identical whichever layer serves it.
 */
export function connectedSourcePositionsSelectorError(
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

/** Resolve the household (default) scope, or the first scope, via the backend. */
async function defaultScopeId(backend: AgentViewBackend): Promise<string> {
  const scopes = await backend.listScopes();
  const household = scopes.data.find((scope) => scope.isDefault) ?? scopes.data[0];
  if (!household) {
    throw new AgentViewHttpError({
      code: "empty_workspace",
      message: "Workspace has no agent-view scopes yet.",
      status: 404,
    });
  }
  return household.id;
}

/** Resolve the tool's scope: the explicit id, or the household default. */
async function resolveScopeId(
  scopeId: string | undefined,
  backend: AgentViewBackend,
): Promise<string> {
  return scopeId ?? (await defaultScopeId(backend));
}

export function createAgentViewCatalog(): AgentViewCatalog {
  return {
    list_scopes: {
      description: "List available worthline agent-view scopes.",
      inputSchema: EMPTY_INPUT_SCHEMA,
      name: "list_scopes",
      run: (_input, backend) => backend.listScopes(),
    },
    get_financial_context: {
      description:
        "Get the compact current financial context for a scope (defaults to the household scope).",
      inputSchema: {
        additionalProperties: false,
        properties: {
          holdingLimit: HOLDING_LIMIT_INPUT_SCHEMA,
          scopeId: { type: "string" },
        },
        type: "object",
      },
      name: "get_financial_context",
      run: async (input, backend) => {
        const scopeId = await resolveScopeId(input.scopeId, backend);
        return backend.financialContext(
          scopeId,
          input.holdingLimit === undefined ? {} : { holdingLimit: input.holdingLimit },
        );
      },
    },
    get_fire_context: {
      description:
        "Get the current FIRE context for a scope (defaults to the household scope): configured/unconfigured status, the FIRE config and assumptions, the computed result (FIRE number, eligible assets after goal reservations, gap, progress ratio, coast-FIRE facts when an age is set), the scope-weighted eligible total, and the assets excluded with their reason (primary residence or manual). Goal reservations only subtract in-horizon assigned capital that is FIRE-eligible. Figures are current-only — a dated request is rejected. Reads are side-effect-free.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          scopeId: { type: "string" },
        },
        type: "object",
      },
      name: "get_fire_context",
      run: async (input, backend) => {
        const scopeId = await resolveScopeId(input.scopeId, backend);
        return backend.fireContext(scopeId);
      },
    },
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
      name: "explain_figure",
      run: async (input, backend) => {
        const scopeId = await resolveScopeId(input.scopeId, backend);
        return backend.explainFigure(scopeId, {
          figure: input.figure,
          ...(input.holdingId === undefined ? {} : { holdingId: input.holdingId }),
          ...(input.date === undefined ? {} : { date: input.date }),
        });
      },
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
          limit: PAGE_LIMIT_INPUT_SCHEMA,
          scopeId: { type: "string" },
          sort: { enum: ["date", "-date"], type: "string" },
          to: { type: "string" },
        },
        type: "object",
      },
      name: "get_snapshot_history",
      run: async (input, backend) => {
        const { scopeId, ...rest } = input;
        const resolved = await resolveScopeId(scopeId, backend);
        return backend.snapshotHistory(resolved, rest);
      },
    },
    get_data_quality: {
      description:
        "Get a scope's data-quality signals (defaults to the household scope): domain warnings (blocking and overrideable), stale manual values for stored holdings, stale/failed prices, stale/failed connected-source syncs, missing configuration (e.g. no FIRE config), sparse/missing snapshot history, and connected-source positions that could not be valued. Each signal carries a category, a normalized severity (high/medium/low), the affected object, a human label, a machine code, an observed date when relevant, whether it is user-fixable, and the original domain warning type when one exists. Filter by category or severity; cursor-paginated. Reads are side-effect-free — surfacing a warning never writes an override.",
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
          limit: PAGE_LIMIT_INPUT_SCHEMA,
          scopeId: { type: "string" },
          severity: { enum: ["high", "medium", "low"], type: "string" },
        },
        type: "object",
      },
      name: "get_data_quality",
      run: async (input, backend) => {
        const { scopeId, ...rest } = input;
        const resolved = await resolveScopeId(scopeId, backend);
        return backend.dataQuality(resolved, rest);
      },
    },
    get_trash_summary: {
      description:
        "Get a scope's trash summary (defaults to the household scope): the recoverable, soft-deleted holdings that live OUTSIDE the main financial context. Each trashed holding carries its public id, label, direction (asset/liability), instrument, stored value/balance when safely available, the date it was trashed when recorded, and read-only restore/hard-delete status facts. Sorted newest-deleted-first, with cursor pagination. Reads are side-effect-free — listing trash never restores, hard-deletes, or mutates anything.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          cursor: { type: "string" },
          limit: PAGE_LIMIT_INPUT_SCHEMA,
          scopeId: { type: "string" },
        },
        type: "object",
      },
      name: "get_trash_summary",
      run: async (input, backend) => {
        const { scopeId, ...rest } = input;
        const resolved = await resolveScopeId(scopeId, backend);
        return backend.trashSummary(resolved, rest);
      },
    },
    get_holding_detail: {
      description:
        "Get one holding's full detail by its public ID: value, ownership, instrument, valuation method, liquidity tier, an operation summary (investments), returns, exposure profile, vsBenchmark (TWR vs tracked index when mapped), and calculation facts — valuation anchors (appreciating assets), the amortization plan with rate revisions and early repayments (amortized liabilities), or balance anchors with interpolation semantics (anchored liabilities). Missing or unsupported facts are flagged in the quality summary, never guessed.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          holdingId: { type: "string" },
        },
        required: ["holdingId"],
        type: "object",
      },
      name: "get_holding_detail",
      run: (input, backend) => backend.holdingDetail(input.holdingId),
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
      name: "get_price_freshness",
      run: (input, backend) => backend.priceFreshness(input.holdingId),
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
          limit: PAGE_LIMIT_INPUT_SCHEMA,
          sort: { enum: ["date", "-date"], type: "string" },
          to: { type: "string" },
        },
        required: ["holdingId"],
        type: "object",
      },
      name: "get_operations",
      run: (input, backend) => backend.operations(input),
    },
    get_connected_source_positions: {
      description:
        "Get connected-source positions (coins / token balances) projected into a holding or a source. Supply EXACTLY ONE of holdingId (one connected holding/rung's positions) or sourceId (all of a source's positions, grouped by projected holding/rung). Each position carries its adapter, source label, projected holding/rung, quantity, unit price when known, value, valuation basis, freshness, and quality signals. Reads are side-effect-free.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          cursor: { type: "string" },
          holdingId: { type: "string" },
          limit: PAGE_LIMIT_INPUT_SCHEMA,
          sourceId: { type: "string" },
        },
        type: "object",
      },
      name: "get_connected_source_positions",
      run: async (input, backend) => {
        const selectorError = connectedSourcePositionsSelectorError(input);
        if (selectorError) {
          return selectorError;
        }
        if (input.holdingId !== undefined) {
          return backend.holdingConnectedSourcePositions({
            holdingId: input.holdingId,
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          });
        }
        return backend.sourceConnectedSourcePositions({
          sourceId: input.sourceId!,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        });
      },
    },
    list_connected_sources: {
      description:
        "List every connected source in the workspace: its public ID (wl_src_…), adapter, label, last sync time, and the public holding IDs (wl_hld_…) it materializes (one per occupied rung). Carries no credential, token, or raw provider payload. Use get_source_freshness for a source's valuation freshness. Reads are side-effect-free.",
      inputSchema: EMPTY_INPUT_SCHEMA,
      name: "list_connected_sources",
      run: (_input, backend) => backend.connectedSources(),
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
      name: "get_source_freshness",
      run: (input, backend) => backend.sourceFreshness(input.sourceId),
    },
    get_workspace: {
      description:
        "Get the workspace settings: its mode (individual or household) and base currency, so answers match the workspace instead of assuming household/EUR. Both are null until the workspace is provisioned. Reads are side-effect-free.",
      inputSchema: EMPTY_INPUT_SCHEMA,
      name: "get_workspace",
      run: (_input, backend) => backend.workspace(),
    },
    get_warning_overrides: {
      description:
        "List the acknowledged overrideable warnings: each carries the warning code and the public holding ID (wl_hld_…) whose warning was silenced, so you can explain which warning was overridden and where. Pure read — surfacing an override never writes one. Reads are side-effect-free.",
      inputSchema: EMPTY_INPUT_SCHEMA,
      name: "get_warning_overrides",
      run: (_input, backend) => backend.warningOverrides(),
    },
    get_member_profile: {
      description:
        "List each active member's profile: public member ID (wl_mbr_…), name, birth year (the reference age for FIRE projections), fiscal country (ISO alpha-2, for tax-aware suggestions) and risk tolerance (conservative/moderate/aggressive). Fields are null until set. Use it to personalize advice instead of assuming. Reads are side-effect-free.",
      inputSchema: EMPTY_INPUT_SCHEMA,
      name: "get_member_profile",
      run: (_input, backend) => backend.memberProfiles(),
    },
    list_goals: {
      description:
        "List the intermediate goals for a scope (defaults to the household scope): each carries its target amount, deadline, priority (high/medium/low), the public ids of assigned holdings (wl_hld_…), the scope-weighted reserved capital (min of target and assigned value) and the funded ratio (reserved / target, 0..1). FIRE context and projection subtract only future in-horizon reservations backed by FIRE-eligible assigned holdings; primary residences and manually excluded assets do not reduce FIRE. Reads are side-effect-free.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          scopeId: { type: "string" },
        },
        type: "object",
      },
      name: "list_goals",
      run: async (input, backend) => {
        const scopeId = await resolveScopeId(input.scopeId, backend);
        return backend.goals(scopeId);
      },
    },
    get_fire_projection: {
      description:
        "Project when a scope reaches FIRE (defaults to the household scope) under optimistic/base/pessimistic scenarios (base = the config's real return; the others ±1.5 %). Each scenario returns years-to-FIRE, age-at-FIRE, final eligible assets, total contributed and a year-by-year capital trajectory. It starts from the goal-reservation-adjusted eligible total, where in-horizon goals subtract only FIRE-eligible assigned holdings, and contributes the configured monthly savings capacity. Unconfigured when the scope has no FIRE config. Reads are side-effect-free.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          scopeId: { type: "string" },
        },
        type: "object",
      },
      name: "get_fire_projection",
      run: async (input, backend) => {
        const scopeId = await resolveScopeId(input.scopeId, backend);
        return backend.fireProjection(scopeId);
      },
    },
    get_contribution_plan: {
      description:
        "Get a scope's contribution plan (defaults to the household scope): the recurring planned contributions (destination, amount in money or units, cadence, start/end), the monthly capital allocation split for a calendar month, pending/backlog reconciliation status, a FIRE what-if trajectory under the plan with the chosen growth assumption (flat = no appreciation; historical = each holding's own return from #547, falling back to the FIRE config rate), and an exposure-drift what-if projecting geography/asset-class composition forward with the same coverage honesty as get_financial_context. The entire response is forecast metadata — planned contributions never enter net worth or snapshots. Confirmed buys and value updates remain truth via get_operations. Reads are side-effect-free.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          growthAssumption: { enum: ["flat", "historical"], type: "string" },
          month: { type: "string" },
          reconciliationWindowDays: {
            description:
              "Positive integer days forward for reconciliation; values above 366 are clamped to 366.",
            minimum: 1,
            type: "integer",
          },
          scopeId: { type: "string" },
        },
        type: "object",
      },
      name: "get_contribution_plan",
      run: async (input, backend) => {
        const { scopeId, ...rest } = input;
        const resolved = await resolveScopeId(scopeId, backend);
        return backend.contributionPlan(resolved, rest);
      },
    },
  };
}
