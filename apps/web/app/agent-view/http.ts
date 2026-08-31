import {
  createAgentViewCatalog,
  type GetConnectedSourcePositionsInput,
  type GetContributionPlanInput,
} from "./catalog";
import { DEFAULT_POSITION_LIMIT, MAX_POSITION_LIMIT } from "./connected-source-positions";
import {
  type AgentViewDataQualityCategory,
  type AgentViewDataQualitySeverity,
  AgentViewHttpError,
  type AgentViewIncludeHoldingRows,
  type AgentViewOperationSort,
  type AgentViewSnapshotGranularity,
  type AgentViewSnapshotSort,
} from "./contract";
import { DEFAULT_DATA_QUALITY_LIMIT, MAX_DATA_QUALITY_LIMIT } from "./data-quality";
import { isFigureName } from "./figure-explanations";
import { DEFAULT_OPERATION_LIMIT, MAX_OPERATION_LIMIT } from "./holding-operations";
import { DEFAULT_HOLDING_MATCH_LIMIT, MAX_HOLDING_MATCH_LIMIT } from "./holding-search";
import {
  parseEnum,
  parseGrowthAssumption,
  parseHoldingLimit,
  parseIsoDate,
  parseNonNegativeInteger,
} from "./http-params";
import { defineAgentViewRoute } from "./http-route";
import { parsePositiveLimit } from "./pagination";
import { DEFAULT_SNAPSHOT_LIMIT, MAX_SNAPSHOT_LIMIT } from "./snapshot-history";
import { DEFAULT_TRASH_LIMIT, MAX_TRASH_LIMIT } from "./trash-summary";

/**
 * The agent-view HTTP transport as a TABLE of read endpoints (#1695). Each entry
 * declares only what makes it different — its path segments, its query-param
 * allowlist, the catalog tool it dispatches to, and how its input is built.
 * The guard, the store run, the envelope, and the `catch → error envelope` tail
 * are `defineAgentViewRoute`'s job, once. Adding an endpoint is adding an entry;
 * it cannot forget its guard or its catch, because it has no body of its own.
 */

const catalog = createAgentViewCatalog();

const SNAPSHOT_GRANULARITIES: readonly AgentViewSnapshotGranularity[] = [
  "monthly-close",
  "raw",
];

const SNAPSHOT_SORTS: readonly AgentViewSnapshotSort[] = ["date", "-date"];

const OPERATION_SORTS: readonly AgentViewOperationSort[] = ["date", "-date"];

const INCLUDE_HOLDING_ROWS: readonly AgentViewIncludeHoldingRows[] = [
  "none",
  "summary",
  "full",
];

const DATA_QUALITY_CATEGORIES: readonly AgentViewDataQualityCategory[] = [
  "warning",
  "trashed_balance",
  "manual_value_freshness",
  "price_freshness",
  "source_freshness",
  "missing_configuration",
  "savings_coherence",
  "spending_coherence",
  "portfolio_reconciliation",
  "transfer_integrity",
  "history_coverage",
  "projection_gap",
];

const DATA_QUALITY_SEVERITIES: readonly AgentViewDataQualitySeverity[] = [
  "high",
  "medium",
  "low",
];

const SNAPSHOT_QUERY_PARAMS = [
  "granularity",
  "from",
  "to",
  "sort",
  "limit",
  "cursor",
  "includeHoldingRows",
];

const DATA_QUALITY_QUERY_PARAMS = ["category", "severity", "limit", "cursor"];

const TRASH_QUERY_PARAMS = ["limit", "cursor"];

const FIND_HOLDINGS_QUERY_PARAMS = ["query", "limit"];

const CALCULATION_TRACE_QUERY_PARAMS = ["declaredBalanceMinor", "declaredDate"];

const OPERATION_QUERY_PARAMS = ["from", "to", "sort", "limit", "cursor"];

const POSITION_QUERY_PARAMS = ["limit", "cursor"];

const CONTRIBUTION_PLAN_QUERY_PARAMS = [
  "month",
  "growthAssumption",
  "reconciliationWindowDays",
];

// ── Scope-level reads ─────────────────────────────────────────────────────────

export const handleListScopes = defineAgentViewRoute({
  input: () => ({}),
  pathParams: [],
  tool: catalog.list_scopes,
});

export const handleGetFinancialContext = defineAgentViewRoute({
  allowedParams: ["holdingLimit"],
  input: ({ scopeId }, params) => {
    const holdingLimit = parseHoldingLimit(params.get("holdingLimit"));
    return {
      scopeId,
      ...(holdingLimit === undefined ? {} : { holdingLimit }),
    };
  },
  pathParams: ["scopeId"],
  tool: catalog.get_financial_context,
});

/**
 * FIRE context is current-only (PRD #328, #340): the only honored query param is
 * `date`, which is rejected as `422 unsupported_historical_fire` so a caller
 * never receives an invented or nearest-date historical FIRE figure. Any other
 * unknown param is the standard `400` from the shared guard.
 */
export const handleGetFireContext = defineAgentViewRoute({
  allowedParams: ["date"],
  input: ({ scopeId }, params) => {
    if (params.has("date")) {
      throw new AgentViewHttpError({
        code: "unprocessable_entity",
        details: { reason: "unsupported_historical_fire" },
        message: "Historical FIRE is not supported.",
        status: 422,
      });
    }
    return { scopeId };
  },
  pathParams: ["scopeId"],
  tool: catalog.get_fire_context,
});

/**
 * Explain one figure for a scope (PRD #328, #343, #344). The `{figure}` path param
 * is validated against the known enum — an unknown name is a `400` carrying
 * `details: { reason: "invalid_figure", figure }`. `holdingId` (the `holding_value`
 * selector) and `date` are allowlisted. A `date` (`YYYY-MM-DD`, validated by
 * `parseIsoDate` — malformed is a `400`) switches the explanation to HISTORICAL
 * mode against the scope's frozen snapshot for that exact day; no `date` keeps
 * the CURRENT-mode behaviour (#343) unchanged.
 */
export const handleExplainFigure = defineAgentViewRoute({
  allowedParams: ["holdingId", "date"],
  input: ({ figure, scopeId }, params) => {
    if (!isFigureName(figure)) {
      throw new AgentViewHttpError({
        code: "bad_request",
        details: { figure, reason: "invalid_figure" },
        message: "Unknown figure.",
        status: 400,
      });
    }

    const holdingId = params.get("holdingId") ?? undefined;
    const date = parseIsoDate(params.get("date"), "date");

    return {
      figure,
      scopeId,
      ...(holdingId === undefined ? {} : { holdingId }),
      ...(date === undefined ? {} : { date }),
    };
  },
  pathParams: ["scopeId", "figure"],
  tool: catalog.explain_figure,
});

export const handleGetSnapshotHistory = defineAgentViewRoute({
  allowedParams: SNAPSHOT_QUERY_PARAMS,
  input: ({ scopeId }, params) => {
    const cursor = params.get("cursor");
    const from = parseIsoDate(params.get("from"), "from");
    const to = parseIsoDate(params.get("to"), "to");
    return {
      scopeId,
      granularity: parseEnum(
        "granularity",
        params.get("granularity"),
        SNAPSHOT_GRANULARITIES,
        "monthly-close",
      ),
      includeHoldingRows: parseEnum(
        "includeHoldingRows",
        params.get("includeHoldingRows"),
        INCLUDE_HOLDING_ROWS,
        "none",
      ),
      limit: parsePositiveLimit(params.get("limit"), {
        defaultLimit: DEFAULT_SNAPSHOT_LIMIT,
        maxLimit: MAX_SNAPSHOT_LIMIT,
      }),
      sort: parseEnum("sort", params.get("sort"), SNAPSHOT_SORTS, "date"),
      ...(cursor ? { cursor } : {}),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    };
  },
  paged: true,
  pathParams: ["scopeId"],
  tool: catalog.get_snapshot_history,
});

export const handleGetDataQuality = defineAgentViewRoute({
  allowedParams: DATA_QUALITY_QUERY_PARAMS,
  input: ({ scopeId }, params) => {
    const category = parseEnum(
      "category",
      params.get("category"),
      DATA_QUALITY_CATEGORIES,
    );
    const severity = parseEnum(
      "severity",
      params.get("severity"),
      DATA_QUALITY_SEVERITIES,
    );
    const cursor = params.get("cursor");
    return {
      scopeId,
      limit: parsePositiveLimit(params.get("limit"), {
        defaultLimit: DEFAULT_DATA_QUALITY_LIMIT,
        maxLimit: MAX_DATA_QUALITY_LIMIT,
      }),
      ...(category === undefined ? {} : { category }),
      ...(severity === undefined ? {} : { severity }),
      ...(cursor ? { cursor } : {}),
    };
  },
  paged: true,
  pathParams: ["scopeId"],
  tool: catalog.get_data_quality,
});

export const handleGetTrashSummary = defineAgentViewRoute({
  allowedParams: TRASH_QUERY_PARAMS,
  input: ({ scopeId }, params) => {
    const cursor = params.get("cursor");
    return {
      scopeId,
      limit: parsePositiveLimit(params.get("limit"), {
        defaultLimit: DEFAULT_TRASH_LIMIT,
        maxLimit: MAX_TRASH_LIMIT,
      }),
      ...(cursor ? { cursor } : {}),
    };
  },
  paged: true,
  pathParams: ["scopeId"],
  tool: catalog.get_trash_summary,
});

/**
 * Look up a scope's live holdings by name/symbol (uso real 2026-07-30). `query` is
 * required — a missing or blank one is the builder's documented `422`, never an
 * unbounded list of every holding.
 */
export const handleFindHoldings = defineAgentViewRoute({
  allowedParams: FIND_HOLDINGS_QUERY_PARAMS,
  input: ({ scopeId }, params) => ({
    limit: parsePositiveLimit(params.get("limit"), {
      defaultLimit: DEFAULT_HOLDING_MATCH_LIMIT,
      maxLimit: MAX_HOLDING_MATCH_LIMIT,
    }),
    query: params.get("query") ?? "",
    scopeId,
  }),
  paged: true,
  pathParams: ["scopeId"],
  tool: catalog.find_holdings,
});

export const handleListGoals = defineAgentViewRoute({
  input: ({ scopeId }) => ({ scopeId }),
  pathParams: ["scopeId"],
  tool: catalog.list_goals,
});

export const handleGetFireProjection = defineAgentViewRoute({
  input: ({ scopeId }) => ({ scopeId }),
  pathParams: ["scopeId"],
  tool: catalog.get_fire_projection,
});

export const handleGetContributionPlan = defineAgentViewRoute({
  allowedParams: CONTRIBUTION_PLAN_QUERY_PARAMS,
  input: ({ scopeId }, params) => {
    const input: GetContributionPlanInput = { scopeId };
    const month = params.get("month");
    if (month) {
      input.month = month;
    }
    const growthAssumption = params.get("growthAssumption");
    if (growthAssumption) {
      input.growthAssumption = parseGrowthAssumption(growthAssumption);
    }
    if (params.get("reconciliationWindowDays")) {
      input.reconciliationWindowDays = parsePositiveLimit(
        params.get("reconciliationWindowDays"),
        { defaultLimit: 90, maxLimit: 366 },
      );
    }
    return input;
  },
  pathParams: ["scopeId"],
  tool: catalog.get_contribution_plan,
});

// ── Holding-level reads ───────────────────────────────────────────────────────

export const handleGetHoldingDetail = defineAgentViewRoute({
  input: ({ holdingId }) => ({ holdingId }),
  pathParams: ["holdingId"],
  tool: catalog.get_holding_detail,
});

export const handleGetPriceFreshness = defineAgentViewRoute({
  input: ({ holdingId }) => ({ holdingId }),
  pathParams: ["holdingId"],
  tool: catalog.get_price_freshness,
});

export const handleGetCalculationTrace = defineAgentViewRoute({
  allowedParams: CALCULATION_TRACE_QUERY_PARAMS,
  input: ({ holdingId }, params) => {
    const declaredBalanceMinor = parseNonNegativeInteger(
      params.get("declaredBalanceMinor"),
      "declaredBalanceMinor",
    );
    const declaredDate = parseIsoDate(params.get("declaredDate"), "declaredDate");
    return {
      holdingId,
      ...(declaredBalanceMinor === undefined ? {} : { declaredBalanceMinor }),
      ...(declaredDate === undefined ? {} : { declaredDate }),
    };
  },
  pathParams: ["holdingId"],
  tool: catalog.get_calculation_trace,
});

export const handleGetHoldingOperations = defineAgentViewRoute({
  allowedParams: OPERATION_QUERY_PARAMS,
  input: ({ holdingId }, params) => {
    const cursor = params.get("cursor");
    const from = parseIsoDate(params.get("from"), "from");
    const to = parseIsoDate(params.get("to"), "to");
    return {
      holdingId,
      limit: parsePositiveLimit(params.get("limit"), {
        defaultLimit: DEFAULT_OPERATION_LIMIT,
        maxLimit: MAX_OPERATION_LIMIT,
      }),
      sort: parseEnum("sort", params.get("sort"), OPERATION_SORTS, "-date"),
      ...(cursor ? { cursor } : {}),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    };
  },
  paged: true,
  pathParams: ["holdingId"],
  tool: catalog.get_operations,
});

export const handleGetHoldingConnectedSourcePositions = defineAgentViewRoute({
  allowedParams: POSITION_QUERY_PARAMS,
  input: ({ holdingId }, params) => positionsInput({ holdingId }, params),
  paged: true,
  pathParams: ["holdingId"],
  tool: catalog.get_connected_source_positions,
});

// ── Connected-source and workspace reads ──────────────────────────────────────

export const handleListConnectedSources = defineAgentViewRoute({
  input: () => ({}),
  pathParams: [],
  tool: catalog.list_connected_sources,
});

export const handleGetSourceFreshness = defineAgentViewRoute({
  input: ({ sourceId }) => ({ sourceId }),
  pathParams: ["sourceId"],
  tool: catalog.get_source_freshness,
});

export const handleGetSourcePositions = defineAgentViewRoute({
  allowedParams: POSITION_QUERY_PARAMS,
  input: ({ sourceId }, params) => positionsInput({ sourceId }, params),
  paged: true,
  pathParams: ["sourceId"],
  tool: catalog.get_connected_source_positions,
});

export const handleGetWorkspace = defineAgentViewRoute({
  input: () => ({}),
  pathParams: [],
  tool: catalog.get_workspace,
});

export const handleGetWarningOverrides = defineAgentViewRoute({
  input: () => ({}),
  pathParams: [],
  tool: catalog.get_warning_overrides,
});

export const handleGetMemberProfiles = defineAgentViewRoute({
  input: () => ({}),
  pathParams: [],
  tool: catalog.get_member_profile,
});

/**
 * The paged positions input, shared by the two selectors the catalog treats as a
 * XOR: one holding's positions, or one source's position groups.
 */
function positionsInput(
  selector: { holdingId: string } | { sourceId: string },
  params: URLSearchParams,
): GetConnectedSourcePositionsInput {
  const cursor = params.get("cursor");
  return {
    ...selector,
    limit: parsePositiveLimit(params.get("limit"), {
      defaultLimit: DEFAULT_POSITION_LIMIT,
      maxLimit: MAX_POSITION_LIMIT,
    }),
    ...(cursor ? { cursor } : {}),
  };
}
