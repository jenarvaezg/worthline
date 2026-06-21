import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { AgentViewMcpInputSchema } from "./mcp";

/**
 * Per-invocation context handed to each tool. Carries the verified token's
 * {@link AuthInfo} (when the request is OAuth-authenticated, ADR 0034) so a tool
 * can bind its store to that token's workspace; absent for the demo (persona
 * cookie) and local no-auth paths.
 */
export interface AgentViewToolContext {
  authInfo?: AuthInfo | undefined;
}

/**
 * Generic MCP tool contract used by the agent-view adapter.
 * The adapter only needs the catalog metadata (name, description, inputSchema)
 * and a typed invocation function; it does not depend on the specific HTTP
 * output shapes of each tool.
 */
export interface AgentViewMcpServerTool {
  name: string;
  description: string;
  inputSchema: AgentViewMcpInputSchema;
  invoke: (input: unknown, context: AgentViewToolContext) => Promise<unknown>;
}

const STUB_ERROR_CODE = "not_found";

/**
 * Configure an MCP server to expose the given agent-view tools using the
 * low-level SDK request handlers. This keeps the existing JSON Schema input
 * schemas from `apps/web/app/agent-view/mcp.ts` without duplicating them in
 * Zod (per ADR 0023 and the decision in #398).
 */
export function createAgentViewMcpServer(tools: AgentViewMcpServerTool[]) {
  return (server: McpServer): void => {
    server.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: tools.map((tool) => ({
          description: tool.description,
          inputSchema: tool.inputSchema,
          name: tool.name,
        })),
      };
    });

    server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = tools.find((t) => t.name === request.params.name);
      if (!tool) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: {
                  code: STUB_ERROR_CODE,
                  message: `Tool "${request.params.name}" is not available.`,
                },
              }),
            },
          ],
          isError: true,
        };
      }

      // `extra.authInfo` is the verified token's AuthInfo on the OAuth path
      // (set by withMcpAuth → mcp-handler), and undefined on the demo/local
      // paths — the tool binds its store accordingly (ADR 0034).
      const result = await tool.invoke(request.params.arguments ?? {}, {
        authInfo: extra.authInfo,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
        isError: false,
      };
    });
  };
}
