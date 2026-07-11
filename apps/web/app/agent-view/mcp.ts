import {
  type AgentViewBackend,
  type AgentViewCatalog,
  type AgentViewCatalogTool,
  createAgentViewCatalog,
  type GetContributionPlanInput,
  type GetDataQualityInput,
  type GetOperationsInput,
  type GetSnapshotHistoryInput,
  type GetTrashSummaryInput,
} from "./catalog";

export type {
  AgentViewMcpInputSchema,
  ExplainFigureInput,
  GetConnectedSourcePositionsInput,
  GetConnectedSourcePositionsOutput,
  GetContributionPlanInput,
  GetDataQualityInput,
  GetFinancialContextInput,
  GetFireContextInput,
  GetFireProjectionInput,
  GetHoldingDetailInput,
  GetOperationsInput,
  GetPriceFreshnessInput,
  GetSnapshotHistoryInput,
  GetSourceFreshnessInput,
  GetTrashSummaryInput,
  ListGoalsInput,
} from "./catalog";

/**
 * The HTTP adapter for the agent-view MCP catalog (#576): it binds the single
 * catalog definition (`catalog.ts`) to a backend that resolves every read over
 * the read-only HTTP API. Wiring tests use this adapter to assert parity between
 * HTTP routes and the catalog. The public MCP endpoint uses the internal
 * read-store adapter instead (`internal-catalog.ts`). The in-app assistant does
 * not consume this catalog; it owns a separate chat catalog per ADR 0047.
 */
export interface AgentViewApiClient {
  get: <T>(path: string) => Promise<T>;
}

/** A catalog tool bound to a client: the HTTP-facing `invoke` shape (#398). */
export interface AgentViewMcpTool<Input, Output> {
  name: string;
  description: string;
  inputSchema: AgentViewCatalogTool<Input, Output>["inputSchema"];
  invoke: (input: Input) => Promise<Output>;
}

/** The full HTTP catalog: each catalog tool bound to the shared metadata. */
export type AgentViewMcpToolCatalog = {
  [K in keyof AgentViewCatalog]: AgentViewCatalog[K] extends AgentViewCatalogTool<
    infer Input,
    infer Output
  >
    ? AgentViewMcpTool<Input, Output>
    : never;
};

const SCOPES_PATH = "/api/v1/agent-view/scopes";
const HOLDINGS_PATH = "/api/v1/agent-view/holdings";
const CONNECTED_SOURCES_PATH = "/api/v1/agent-view/connected-sources";
const WORKSPACE_PATH = "/api/v1/agent-view/workspace";
const WARNING_OVERRIDES_PATH = "/api/v1/agent-view/warning-overrides";
const MEMBERS_PATH = "/api/v1/agent-view/members";

const scope = (scopeId: string): string =>
  `${SCOPES_PATH}/${encodeURIComponent(scopeId)}`;
const holding = (holdingId: string): string =>
  `${HOLDINGS_PATH}/${encodeURIComponent(holdingId)}`;
const source = (sourceId: string): string =>
  `${CONNECTED_SOURCES_PATH}/${encodeURIComponent(sourceId)}`;

/** Serialize an ordered set of query params, skipping `undefined`, into `?a=b`. */
function queryString(params: Array<[string, string | number | undefined]>): string {
  const search = new URLSearchParams();
  for (const [key, value] of params) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

/**
 * Build the backend that resolves every agent-view read over the HTTP API. It
 * mirrors the read-only routes 1:1; page-size clamping and figure validation are
 * enforced by the routes themselves (this layer forwards the raw params).
 */
export function createAgentViewApiBackend(client: AgentViewApiClient): AgentViewBackend {
  return {
    listScopes: () => client.get(SCOPES_PATH),
    financialContext: (scopeId, params) =>
      client.get(
        `${scope(scopeId)}/financial-context${queryString([["holdingLimit", params.holdingLimit]])}`,
      ),
    fireContext: (scopeId) => client.get(`${scope(scopeId)}/fire-context`),
    explainFigure: (scopeId, params) =>
      client.get(
        `${scope(scopeId)}/figure-explanations/${encodeURIComponent(params.figure)}${queryString(
          [
            ["holdingId", params.holdingId],
            ["date", params.date],
          ],
        )}`,
      ),
    snapshotHistory: (scopeId, params: Omit<GetSnapshotHistoryInput, "scopeId">) =>
      client.get(
        `${scope(scopeId)}/snapshots${queryString([
          ["granularity", params.granularity],
          ["from", params.from],
          ["to", params.to],
          ["sort", params.sort],
          ["limit", params.limit],
          ["cursor", params.cursor],
          ["includeHoldingRows", params.includeHoldingRows],
        ])}`,
      ),
    dataQuality: (scopeId, params: Omit<GetDataQualityInput, "scopeId">) =>
      client.get(
        `${scope(scopeId)}/data-quality${queryString([
          ["category", params.category],
          ["severity", params.severity],
          ["limit", params.limit],
          ["cursor", params.cursor],
        ])}`,
      ),
    trashSummary: (scopeId, params: Omit<GetTrashSummaryInput, "scopeId">) =>
      client.get(
        `${scope(scopeId)}/trash-summary${queryString([
          ["limit", params.limit],
          ["cursor", params.cursor],
        ])}`,
      ),
    holdingDetail: (holdingId) => client.get(holding(holdingId)),
    priceFreshness: (holdingId) => client.get(`${holding(holdingId)}/price-freshness`),
    operations: (params: GetOperationsInput) =>
      client.get(
        `${holding(params.holdingId)}/operations${queryString([
          ["from", params.from],
          ["to", params.to],
          ["sort", params.sort],
          ["limit", params.limit],
          ["cursor", params.cursor],
        ])}`,
      ),
    holdingConnectedSourcePositions: (params) =>
      client.get(
        `${holding(params.holdingId)}/connected-source-positions${queryString([
          ["limit", params.limit],
          ["cursor", params.cursor],
        ])}`,
      ),
    sourceConnectedSourcePositions: (params) =>
      client.get(
        `${source(params.sourceId)}/positions${queryString([
          ["limit", params.limit],
          ["cursor", params.cursor],
        ])}`,
      ),
    connectedSources: () => client.get(CONNECTED_SOURCES_PATH),
    sourceFreshness: (sourceId) => client.get(`${source(sourceId)}/freshness`),
    workspace: () => client.get(WORKSPACE_PATH),
    warningOverrides: () => client.get(WARNING_OVERRIDES_PATH),
    memberProfiles: () => client.get(MEMBERS_PATH),
    goals: (scopeId) => client.get(`${scope(scopeId)}/goals`),
    fireProjection: (scopeId) => client.get(`${scope(scopeId)}/fire-projection`),
    contributionPlan: (scopeId, params: Omit<GetContributionPlanInput, "scopeId">) =>
      client.get(
        `${scope(scopeId)}/contribution-plan${queryString([
          ["growthAssumption", params.growthAssumption],
        ])}`,
      ),
  };
}

export function createAgentViewMcpToolCatalog(
  client: AgentViewApiClient,
): AgentViewMcpToolCatalog {
  const backend = createAgentViewApiBackend(client);
  const catalog = createAgentViewCatalog();

  const bound: Record<string, AgentViewMcpTool<unknown, unknown>> = {};
  for (const [key, tool] of Object.entries(catalog)) {
    bound[key] = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      invoke: (input: unknown) =>
        (tool as AgentViewCatalogTool<unknown, unknown>).run(input, backend),
    };
  }
  return bound as AgentViewMcpToolCatalog;
}
