import type {
  AgentViewEnvelope,
  AgentViewFinancialContext,
  AgentViewHoldingDetail,
  AgentViewIncludeHoldingRows,
  AgentViewOperation,
  AgentViewOperationSort,
  AgentViewScope,
  AgentViewSnapshotEntry,
  AgentViewSnapshotGranularity,
  AgentViewSnapshotSort,
} from "./contract";

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

export interface GetHoldingDetailInput {
  /** Public holding ID (`wl_hld_…`). */
  holdingId: string;
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

export interface AgentViewMcpToolCatalog {
  list_scopes: AgentViewMcpTool<
    Record<string, never>,
    AgentViewEnvelope<AgentViewScope[]>
  >;
  get_financial_context: AgentViewMcpTool<
    GetFinancialContextInput,
    AgentViewEnvelope<AgentViewFinancialContext>
  >;
  get_snapshot_history: AgentViewMcpTool<
    GetSnapshotHistoryInput,
    AgentViewEnvelope<AgentViewSnapshotEntry[]>
  >;
  get_holding_detail: AgentViewMcpTool<
    GetHoldingDetailInput,
    AgentViewEnvelope<AgentViewHoldingDetail>
  >;
  get_operations: AgentViewMcpTool<
    GetOperationsInput,
    AgentViewEnvelope<AgentViewOperation[]>
  >;
}

const EMPTY_INPUT_SCHEMA: AgentViewMcpInputSchema = {
  additionalProperties: false,
  properties: {},
  type: "object",
};

const SCOPES_PATH = "/api/v1/agent-view/scopes";
const HOLDINGS_PATH = "/api/v1/agent-view/holdings";

export function createAgentViewMcpToolCatalog(
  client: AgentViewApiClient,
): AgentViewMcpToolCatalog {
  return {
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
    list_scopes: {
      description: "List available worthline agent-view scopes.",
      inputSchema: EMPTY_INPUT_SCHEMA,
      invoke: () => client.get(SCOPES_PATH),
      name: "list_scopes",
    },
  };
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
