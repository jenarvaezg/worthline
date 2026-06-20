import { createAgentViewMcpToolCatalog } from "./mcp";
import type { AgentViewMcpServerTool } from "./mcp-server";

const STUB_NOTICE = "This tool is not yet wired to real data.";

/**
 * Build a stub agent-view tool catalog for the public MCP endpoint (#399).
 *
 * Tool names, descriptions, and input schemas are sourced from the real
 * catalog in `apps/web/app/agent-view/mcp.ts`. Every tool invocation returns
 * the same deterministic placeholder payload — no internal service or HTTP
 * API is called, and no real data is exposed.
 */
export function createStubAgentViewMcpToolCatalog(): AgentViewMcpServerTool[] {
  const realCatalog = createAgentViewMcpToolCatalog({
    get: async () => {
      throw new Error("Stub catalog must not call the HTTP API.");
    },
  });

  return Object.values(realCatalog).map((tool) => ({
    description: tool.description,
    inputSchema: tool.inputSchema,
    name: tool.name,
    invoke: async () => ({ data: { notice: STUB_NOTICE } }),
  }));
}
