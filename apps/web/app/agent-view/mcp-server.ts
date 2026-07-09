import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type AgentViewErrorEnvelope,
  AgentViewHttpError,
  errorEnvelope,
} from "./contract";
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

const MCP_OUTPUT_NOTE =
  "Outputs are JSON agent-view envelopes. Money values use {amountMinor, currency}; " +
  "amountMinor is in minor currency units (for EUR, cents), not euros.";

const AGENT_VIEW_OUTPUT_SCHEMA = {
  type: "object" as const,
  description: MCP_OUTPUT_NOTE,
  properties: {
    data: {
      description:
        "Tool-specific success payload. Nested money values follow #/$defs/money.",
    },
    meta: {
      type: "object",
      description: "Optional pagination or response metadata.",
      additionalProperties: true,
    },
    links: {
      type: "object",
      description: "Optional response links.",
      additionalProperties: { type: "string" },
    },
    error: {
      type: "object",
      description: "Documented tool/domain error payload.",
      properties: {
        code: {
          enum: [
            "bad_request",
            "empty_workspace",
            "forbidden",
            "internal_error",
            "not_found",
            "unauthorized",
            "unprocessable_entity",
          ],
          type: "string",
        },
        message: { type: "string" },
        details: {},
      },
      required: ["code", "message"],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
  $defs: {
    money: {
      type: "object",
      description:
        "Exact money value. amountMinor is in minor currency units (for EUR, cents), not euros.",
      properties: {
        amountMinor: {
          type: "integer",
          description: "Amount in minor currency units (for EUR, cents).",
        },
        currency: {
          type: "string",
          description: "ISO 4217 currency code.",
        },
      },
      required: ["amountMinor", "currency"],
      additionalProperties: false,
    },
  },
};

function withMcpOutputNote(description: string): string {
  return `${description} ${MCP_OUTPUT_NOTE}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorEnvelope(value: unknown): value is AgentViewErrorEnvelope {
  return (
    isRecord(value) &&
    isRecord(value["error"]) &&
    typeof value["error"]["code"] === "string" &&
    typeof value["error"]["message"] === "string"
  );
}

function badRequest(message: string, details?: unknown): AgentViewErrorEnvelope {
  return errorEnvelope(
    new AgentViewHttpError({
      code: "bad_request",
      message,
      status: 400,
      ...(details === undefined ? {} : { details }),
    }),
  );
}

function validateToolInput(
  schema: AgentViewMcpInputSchema,
  input: unknown,
): Record<string, unknown> | AgentViewErrorEnvelope {
  if (!isRecord(input)) {
    return badRequest("Tool arguments must be a JSON object.");
  }

  const properties = schema.properties;
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(properties));
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      return badRequest("Tool arguments include unknown properties.", {
        properties: unknown,
      });
    }
  }

  for (const required of schema.required ?? []) {
    if (!(required in input)) {
      return badRequest("Tool arguments are missing required properties.", {
        properties: [required],
      });
    }
  }

  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (!isRecord(property)) continue;

    const enumValues = Array.isArray(property["enum"]) ? property["enum"] : null;
    if (enumValues && !enumValues.includes(value)) {
      return badRequest("Tool argument has an unsupported enum value.", {
        property: key,
        value,
      });
    }

    const expectedType = property["type"];
    if (expectedType === "string" && typeof value !== "string") {
      return badRequest("Tool argument must be a string.", { property: key, value });
    }
    if (expectedType === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return badRequest("Tool argument must be an integer.", { property: key, value });
      }
      const minimum = property["minimum"];
      if (typeof minimum === "number" && value < minimum) {
        return badRequest("Tool argument is below the minimum.", {
          property: key,
          value,
          minimum,
        });
      }
    }
  }

  return input;
}

function errorToEnvelope(error: unknown): AgentViewErrorEnvelope {
  if (error instanceof AgentViewHttpError) return errorEnvelope(error);
  console.error("[mcp-tool] unexpected tool error", {
    message: error instanceof Error ? error.message : String(error),
  });
  return {
    error: {
      code: "internal_error",
      message: "Tool execution failed.",
    },
  };
}

function toolResult(result: unknown) {
  const structuredContent = isRecord(result) ? result : { data: result };
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result),
      },
    ],
    structuredContent,
    isError: isErrorEnvelope(result),
  };
}

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
          description: withMcpOutputNote(tool.description),
          inputSchema: tool.inputSchema,
          name: tool.name,
          outputSchema: AGENT_VIEW_OUTPUT_SCHEMA,
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
      const validation = validateToolInput(
        tool.inputSchema,
        request.params.arguments ?? {},
      );
      if (isErrorEnvelope(validation)) {
        return toolResult(validation);
      }

      try {
        const result = await tool.invoke(validation, {
          authInfo: extra.authInfo,
        });
        return toolResult(result);
      } catch (error) {
        return toolResult(errorToEnvelope(error));
      }
    });
  };
}
