import type { AgentViewEnvelope, AgentViewScope } from "./contract";

export interface AgentViewApiClient {
  get: <T>(path: string) => Promise<T>;
}

export interface AgentViewMcpTool<Input, Output> {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, never>;
    additionalProperties: false;
  };
  invoke: (input: Input) => Promise<Output>;
}

export interface AgentViewMcpToolCatalog {
  list_scopes: AgentViewMcpTool<
    Record<string, never>,
    AgentViewEnvelope<AgentViewScope[]>
  >;
}

const EMPTY_INPUT_SCHEMA = {
  additionalProperties: false,
  properties: {},
  type: "object",
} as const;

export function createAgentViewMcpToolCatalog(
  client: AgentViewApiClient,
): AgentViewMcpToolCatalog {
  return {
    list_scopes: {
      description: "List available worthline agent-view scopes.",
      inputSchema: EMPTY_INPUT_SCHEMA,
      invoke: () => client.get("/api/v1/agent-view/scopes"),
      name: "list_scopes",
    },
  };
}
