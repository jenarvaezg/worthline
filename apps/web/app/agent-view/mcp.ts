import type {
  AgentViewEnvelope,
  AgentViewFinancialContext,
  AgentViewScope,
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

export interface AgentViewMcpToolCatalog {
  list_scopes: AgentViewMcpTool<
    Record<string, never>,
    AgentViewEnvelope<AgentViewScope[]>
  >;
  get_financial_context: AgentViewMcpTool<
    GetFinancialContextInput,
    AgentViewEnvelope<AgentViewFinancialContext>
  >;
}

const EMPTY_INPUT_SCHEMA: AgentViewMcpInputSchema = {
  additionalProperties: false,
  properties: {},
  type: "object",
};

const SCOPES_PATH = "/api/v1/agent-view/scopes";

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
    list_scopes: {
      description: "List available worthline agent-view scopes.",
      inputSchema: EMPTY_INPUT_SCHEMA,
      invoke: () => client.get(SCOPES_PATH),
      name: "list_scopes",
    },
  };
}

async function defaultScopeId(client: AgentViewApiClient): Promise<string> {
  const scopes = await client.get<AgentViewEnvelope<AgentViewScope[]>>(SCOPES_PATH);
  const household = scopes.data.find((scope) => scope.isDefault) ?? scopes.data[0];

  if (!household) {
    throw new Error("No agent-view scopes are available.");
  }

  return household.id;
}
