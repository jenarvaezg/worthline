import type {
  AgentViewCalculationTrace,
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
  AgentViewHoldingMatch,
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
import { DEFAULT_HOLDING_MATCH_LIMIT, MAX_HOLDING_MATCH_LIMIT } from "./holding-search";
import { MAX_SNAPSHOT_LIMIT_WITH_HOLDING_ROWS } from "./snapshot-history";

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

export interface FindHoldingsInput {
  /** Part of a name, or a symbol/ISIN. Case- and accent-insensitive. */
  query: string;
  /** Public scope ID; defaults to the household scope when omitted. */
  scopeId?: string;
  /** Max matches (default 10, max 50). */
  limit?: number;
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

export interface GetCalculationTraceInput {
  /** Public holding ID (`wl_hld_…`) of a modelled debt holding. */
  holdingId: string;
  /** A user-declared balance in integer minor units, for the modeling-tolerance verdict. */
  declaredBalanceMinor?: number;
  /** The date the declared figure describes, `YYYY-MM-DD`; defaults to today. */
  declaredDate?: string;
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
  findHoldings(
    scopeId: string,
    params: Omit<FindHoldingsInput, "scopeId">,
  ): Promise<AgentViewEnvelope<AgentViewHoldingMatch[]>>;
  holdingDetail(holdingId: string): Promise<AgentViewEnvelope<AgentViewHoldingDetail>>;
  calculationTrace(
    params: GetCalculationTraceInput,
  ): Promise<AgentViewEnvelope<AgentViewCalculationTrace>>;
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
  find_holdings: AgentViewCatalogTool<
    FindHoldingsInput,
    AgentViewEnvelope<AgentViewHoldingMatch[]>
  >;
  get_holding_detail: AgentViewCatalogTool<
    GetHoldingDetailInput,
    AgentViewEnvelope<AgentViewHoldingDetail>
  >;
  get_calculation_trace: AgentViewCatalogTool<
    GetCalculationTraceInput,
    AgentViewEnvelope<AgentViewCalculationTrace>
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

/**
 * The snapshot page size states its second ceiling (#1268): a page carrying
 * frozen holding rows is narrowed further, so the published schema must not
 * promise the plain clamp it would otherwise imply.
 */
const SNAPSHOT_PAGE_LIMIT_INPUT_SCHEMA = {
  ...PAGE_LIMIT_INPUT_SCHEMA,
  description: `${PAGE_LIMIT_INPUT_SCHEMA.description} With includeHoldingRows=summary|full the page is narrowed to ${MAX_SNAPSHOT_LIMIT_WITH_HOLDING_ROWS}.`,
};

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
        "Get the compact current financial context for a scope (defaults to the household scope). " +
        "The holdings block is a TOP-N: holdings are sorted by ABSOLUTE current value descending and " +
        "cut at holdingLimit (default 25, max 100) — the rest are reported only as " +
        "omittedCount/omittedTotalValue. A holding worth 0 therefore sorts LAST and is normally OUTSIDE the " +
        "cut, so never conclude a holding does not exist from its absence here: look it up by name or symbol " +
        "with find_holdings (or raise holdingLimit). " +
        "A holding materialized by a connected source carries connectedSource {adapter, label}: the SYNC owns " +
        "that value. Never declare, correct, or remove such a holding — it is refused; the repair path is " +
        "syncing or re-mapping the source in /ajustes/conexiones. No mark means the holding is hand-maintained. " +
        "The managedPortfolios block names each cartera gestionada (ADR 0085) with its member holdings: a group " +
        "of funds the owner reads as ONE balance in his manager's app — the members keep summing into net worth " +
        "as themselves, so never add the portfolio's name as an extra row. " +
        "Every investment row also carries its instrument identity: isin, providerSymbol and units (net units " +
        'still held). So ANSWER AN ENUMERATION QUESTION FROM THIS READ — "list every fund with its ISIN and ' +
        'participaciones" is ONE call with holdingLimit raised (up to 100), NEVER one get_holding_detail per ' +
        "holding. A field is ABSENT when the holding has no such fact: no isin means none is registered on that " +
        "holding (never conclude the workspace has none), and absent units means no operation is recorded there " +
        "(a sync-owned rung reports its units in get_connected_source_positions).",
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
        "Get the current FIRE context for a scope (defaults to the household scope): configured/unconfigured status, the FIRE config and assumptions, the computed result (FIRE number, eligible assets after goal reservations, gap, progress ratio, coast-FIRE facts when an age is set — the requirement, when the declared savings reach it (coastArrival), and the age today's capital alone would reach the FULL FIRE number at if contributions stopped (fireAgeIfContributionsStop): two different questions, so quote each with its premise (ADR 0079)), the scope-weighted eligible total, and the assets excluded with their reason (primary residence or manual). Goal reservations only subtract in-horizon assigned capital that is FIRE-eligible. When config.immobilizedCountsAsFireCapital is false the scope has DECLARED that its immobilized capital (non-primary property, collections) is not FIRE capital (ADR 0078), so every figure here — eligible total, progress, coast — is measured over the sellable side alone and that capital appears in no other field: say which measure you are quoting. result.retirementProfile.state says whether this plan reads as FIRE or as an ORDINARY retirement (`ordinary` only when the user declared it, ADR 0081): for that state the honest headline is result.sustainableSpending — net rents plus what the SELLABLE capital supports, with a depleting variant when the user declared how long it must last — and NOT the funded percentage, which answers a question they did not ask. Figures are current-only — a dated request is rejected. Reads are side-effect-free.",
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
      description: `Get a scope's net-worth snapshot history (monthly closes by default; raw on request), with date filters, cursor pagination, and optional frozen holding rows. includeHoldingRows sets the cost of the read: none (default, cheapest) for the shape of the series; summary (~3x) when the per-liquidity-rung composition matters; full (~8x) only to look position by position. Under summary or full the page is narrowed to ${MAX_SNAPSHOT_LIMIT_WITH_HOLDING_ROWS} snapshots (meta.holdingRowsWindow reports it; the rest of the series stays behind meta.nextCursor), so choose WHICH snapshots you decompose: sort=-date for the most recent ones, or from/to for the range you care about. For one position's detail use get_holding_detail instead of the whole history.`,
      inputSchema: {
        additionalProperties: false,
        properties: {
          cursor: { type: "string" },
          from: { type: "string" },
          granularity: { enum: ["monthly-close", "raw"], type: "string" },
          includeHoldingRows: { enum: ["none", "summary", "full"], type: "string" },
          limit: SNAPSHOT_PAGE_LIMIT_INPUT_SCHEMA,
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
        "Get a scope's data-quality signals (defaults to the household scope): domain warnings (blocking and overrideable), stale manual values for stored holdings, stale/failed prices, stale/failed connected-source syncs, missing configuration (e.g. no FIRE config), sparse/missing snapshot history, connected-source positions that could not be valued, and holdings trashed while their position still held units (their value left the patrimonio with no sale recorded). Each signal carries a category, a normalized severity (high/medium/low), the affected object, a human label, a machine code, an observed date when relevant, whether it is user-fixable, and the original domain warning type when one exists. Filter by category or severity; cursor-paginated. Reads are side-effect-free — surfacing a warning never writes an override.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          category: {
            enum: [
              "warning",
              "trashed_balance",
              "manual_value_freshness",
              "price_freshness",
              "source_freshness",
              "missing_configuration",
              "savings_coherence",
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
    find_holdings: {
      description:
        "Find a scope's LIVE holdings by name, price symbol, or ISIN (defaults to the household scope): " +
        "case- and accent-insensitive substring match over EVERY holding in the scope — including holdings " +
        "worth 0, which get_financial_context sorts last and normally leaves outside its cut. Use it whenever " +
        'the user names a holding you have not seen in a read ("the fund at 0 €", a ticker, part of a label): ' +
        "it returns the public id (wl_hld_…) a correction or a baja needs, the label, direction, instrument, " +
        "current value, which field matched (label | providerSymbol | isin), the instrument identity when known " +
        "(isin, providerSymbol, units still held), and connectedSource {adapter, label} " +
        "when a sync owns the holding (never write to those). A member of a managed portfolio (cartera " +
        "gestionada) also carries managedPortfolio {id (wl_prt_…), label} — these fondos son uno: group them " +
        "and never treat the portfolio as a holding itself. Ranked by absolute value descending and capped " +
        `(default ${DEFAULT_HOLDING_MATCH_LIMIT}, max ${MAX_HOLDING_MATCH_LIMIT}); meta.truncated says the cap ` +
        "dropped matches — narrow the query rather than guessing. An empty query is a 422. Trashed holdings are " +
        "NOT searched (they live in get_trash_summary). Reads are side-effect-free.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          limit: clampedPositiveIntegerSchema("match cap", MAX_HOLDING_MATCH_LIMIT),
          query: {
            description:
              "Part of a holding's name, or its price symbol / ISIN. Case- and accent-insensitive.",
            type: "string",
          },
          scopeId: { type: "string" },
        },
        required: ["query"],
        type: "object",
      },
      name: "find_holdings",
      run: async (input, backend) => {
        const { scopeId, ...rest } = input;
        const resolved = await resolveScopeId(scopeId, backend);
        return backend.findHoldings(resolved, rest);
      },
    },
    get_holding_detail: {
      description:
        "Get one holding's full detail by its public ID: value, ownership, instrument, its identity (isin, providerSymbol, units still held), valuation method, liquidity tier, an operation summary (investments), returns, exposure profile, vsBenchmark (TWR vs tracked index when mapped), and calculation facts — valuation anchors (appreciating assets), the amortization plan with rate revisions and early repayments (amortized liabilities), or balance anchors with interpolation semantics (anchored liabilities). A member of a managed portfolio (cartera gestionada) also carries managedPortfolio {id, label}. Missing or unsupported facts are flagged in the quality summary, never guessed. This is a ONE-holding read: for a LIST (every fund, every ISIN, every units count) use get_financial_context with holdingLimit raised, or find_holdings — never a call per holding.",
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
    get_calculation_trace: {
      description:
        "Get a debt holding's calculation trace by its public ID: the engine's full cuadro — for an amortizable liability the amortization schedule frontiers with the interest/principal split per cuota and the dated events (rate revisions, early repayments) attached to each frontier; for a revolving/informal liability its declared balance anchors — plus, for an amortizable one, `schedule.settlement`: the outstanding principal worthline paints, the interest accrued since the last cuota, and their sum, which is the magnitude a bank's «pending» figure compares to (normalize against it before diagnosing drift) — plus a per-date reconciliation of the live recomputed balance against the persisted snapshot value, an infidelity check (persisted values the current config no longer reproduces), and the modeling-tolerance band max(1 €, 0.05 % of the balance). Pass declaredBalanceMinor (integer minor units) and optional declaredDate (YYYY-MM-DD) to get the residual of a user-cited figure against the engine's live balance and whether it is within tolerance. Use this before diagnosing a wrong-figure complaint so you never rebuild amortization arithmetic yourself. Only debt holdings with a configured debt model are supported; anything else is a 422. Reads are side-effect-free.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          declaredBalanceMinor: {
            description:
              "A user-declared balance in integer minor units (céntimos), for the modeling-tolerance verdict.",
            type: "integer",
          },
          declaredDate: { type: "string" },
          holdingId: { type: "string" },
        },
        required: ["holdingId"],
        type: "object",
      },
      name: "get_calculation_trace",
      run: (input, backend) => backend.calculationTrace(input),
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
        "Get an investment holding's operations (buys, sells, and the two halves of a traspaso — `transfer_out`/`transfer_in`, paired by `transferId`) with date filters and cursor pagination; newest-first by default. A traspaso moves capital between products: it realizes no gain, so never read one as a sale. A `transfer_in` whose `transferId` matches no other row is an entrada por traspaso externo — a position brought in from another institution, whose outgoing half is in that institution's ledger; it is not a broken pair and not a purchase. Non-investment holdings are rejected.",
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
        "Get a scope's contribution plan (defaults to the household scope): the recurring planned contributions (destination, amount in money or units, cadence, start/end, whether active today), the monthly capital allocation split for a calendar month (planned per destination contrasted with the money explicitly confirmed against that month's occurrences; a units destination with no cached price reports its planned units and is listed in missingUnitPriceHoldings — never a guessed figure), pending/backlog reconciliation status over an echoed window, a FIRE what-if trajectory under the plan with the chosen growth assumption (flat = no appreciation; historical = each holding's own return from #547, falling back to the FIRE config rate), and an exposure-drift what-if projecting geography/asset-class composition forward with the same coverage honesty as get_financial_context. The entire response is forecast metadata — planned contributions never enter net worth or snapshots. Confirmed buys and value updates remain truth via get_operations. This surface does NOT report the FIRE monthly savings capacity: the plan is not an input to the FIRE projection (ADR 0074), so that figure lives in get_fire_projection and monthlyAllocation.totalPlanned is the plan's own total, never a stand-in for it. Reads are side-effect-free.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          growthAssumption: { enum: ["flat", "historical"], type: "string" },
          month: {
            description:
              "YYYY-MM calendar month for the allocation view; defaults to the current month. A malformed month is a 400.",
            pattern: "^\\d{4}-\\d{2}$",
            type: "string",
          },
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
