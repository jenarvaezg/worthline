import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { GET, POST } from "./route";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

const MCP_URL = "http://localhost:3000/api/mcp";
const PROTOCOL_VERSION = "2024-11-05";

async function parseMcpMessages(response: Response): Promise<unknown[]> {
  const text = await response.text();
  const messages: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      messages.push(JSON.parse(line.slice("data: ".length)));
    }
  }
  return messages;
}

async function parseSingleMcpMessage(response: Response): Promise<unknown> {
  const messages = await parseMcpMessages(response);
  if (messages.length !== 1) {
    throw new Error(
      `Expected exactly one MCP message, got ${messages.length}: ${JSON.stringify(messages)}`,
    );
  }
  return messages[0];
}

function mcpRequest(
  body: unknown,
  extraHeaders: Record<string, string> = {},
): ReturnType<typeof POST> {
  return POST(
    new Request(MCP_URL, {
      body: JSON.stringify(body),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Mcp-Protocol-Version": PROTOCOL_VERSION,
        ...extraHeaders,
      },
      method: "POST",
    }),
  );
}

describe("GET /api/mcp", () => {
  test("rejects GET with 405", async () => {
    const response = await GET(new Request(MCP_URL, { method: "GET" }));

    expect(response.status).toBe(405);
    const body = await response.json();
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32000 },
      id: null,
    });
  });
});

describe("POST /api/mcp (non-demo mode)", () => {
  test("completes the initialize handshake", async () => {
    const response = await mcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });

    expect(response.status).toBe(200);
    const body = await parseSingleMcpMessage(response);
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: "worthline" },
        capabilities: { tools: {} },
      },
    });
  });

  test("lists the 10 agent-view tools with their catalog schemas", async () => {
    const response = await mcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    expect(response.status).toBe(200);
    const body = (await parseSingleMcpMessage(response)) as {
      result: {
        tools: Array<{ name: string; inputSchema: unknown; description: string }>;
      };
    };
    const tools = body.result.tools;

    expect(tools).toHaveLength(10);
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "list_scopes",
        "get_financial_context",
        "get_fire_context",
        "explain_figure",
        "get_snapshot_history",
        "get_data_quality",
        "get_trash_summary",
        "get_holding_detail",
        "get_operations",
        "get_connected_source_positions",
      ].sort(),
    );

    const explainFigure = tools.find((tool) => tool.name === "explain_figure");
    expect(explainFigure?.inputSchema).toMatchObject({
      type: "object",
      required: ["figure"],
      properties: {
        figure: { type: "string" },
      },
    });
    expect(explainFigure?.description).toContain("Explain how a scope's figure");
  });

  test("calling a tool returns the stub payload", async () => {
    const response = await mcpRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "list_scopes",
        arguments: {},
      },
    });

    expect(response.status).toBe(200);
    const body = (await parseSingleMcpMessage(response)) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    expect(body.result.content).toHaveLength(1);
    expect(body.result.content[0]?.type).toBe("text");

    const payload = JSON.parse(body.result.content[0]?.text ?? "");
    expect(payload).toEqual({
      data: { notice: "This tool is not yet wired to real data." },
    });
  });

  test("calling a tool with arguments still returns the stub payload", async () => {
    const response = await mcpRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "explain_figure",
        arguments: { figure: "net_worth" },
      },
    });

    expect(response.status).toBe(200);
    const body = (await parseSingleMcpMessage(response)) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    const payload = JSON.parse(body.result.content[0]?.text ?? "");
    expect(payload).toEqual({
      data: { notice: "This tool is not yet wired to real data." },
    });
  });

  test("calling an unknown tool returns an error result", async () => {
    const response = await mcpRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "unknown_tool",
        arguments: {},
      },
    });

    expect(response.status).toBe(200);
    const body = (await parseSingleMcpMessage(response)) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("unknown_tool");
  });

  test("refuses a request with an unsupported Accept header", async () => {
    const response = await mcpRequest(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/list",
        params: {},
      },
      { Accept: "text/html" },
    );

    expect(response.status).toBe(406);
  });
});

describe("POST /api/mcp (demo mode)", () => {
  const originalDemo = process.env.DEMO;
  const originalDemoNow = process.env.WORTHLINE_DEMO_NOW;

  beforeAll(() => {
    process.env.DEMO = "1";
    process.env.WORTHLINE_DEMO_NOW = "2026-06-20";
  });

  afterAll(() => {
    process.env.DEMO = originalDemo;
    process.env.WORTHLINE_DEMO_NOW = originalDemoNow;
  });

  test("list_scopes returns real demo scopes", { timeout: 30000 }, async () => {
    const response = await mcpRequest({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "list_scopes", arguments: {} },
    });

    expect(response.status).toBe(200);
    const body = (await parseSingleMcpMessage(response)) as {
      result: { content: Array<{ text: string }> };
    };
    const payload = JSON.parse(body.result.content[0]?.text ?? "") as {
      data: Array<{ id: string; label: string; isDefault: boolean }>;
    };
    expect(payload.data.length).toBeGreaterThan(0);
    expect(payload.data.some((scope) => scope.isDefault)).toBe(true);
  });

  test("get_financial_context returns real demo data", { timeout: 30000 }, async () => {
    const response = await mcpRequest({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "get_financial_context", arguments: {} },
    });

    expect(response.status).toBe(200);
    const body = (await parseSingleMcpMessage(response)) as {
      result: { content: Array<{ text: string }> };
    };
    const payload = JSON.parse(body.result.content[0]?.text ?? "") as {
      data: { summary: { netWorth: { amountMinor: number } }; holdings: unknown };
    };
    expect(payload.data.summary.netWorth.amountMinor).toBeGreaterThan(0);
    expect(payload.data.holdings).toBeDefined();
  });

  test(
    "explain_figure returns a real explanation for net_worth",
    { timeout: 30000 },
    async () => {
      const response = await mcpRequest({
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
          name: "explain_figure",
          arguments: { figure: "net_worth" },
        },
      });

      expect(response.status).toBe(200);
      const body = (await parseSingleMcpMessage(response)) as {
        result: { content: Array<{ text: string }> };
      };
      const payload = JSON.parse(body.result.content[0]?.text ?? "") as {
        data: { figure: string; value: { amountMinor: number } };
      };
      expect(payload.data.figure).toBe("net_worth");
      expect(payload.data.value.amountMinor).toBeGreaterThan(0);
    },
  );

  test("get_snapshot_history returns real demo history", { timeout: 30000 }, async () => {
    const response = await mcpRequest({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "get_snapshot_history", arguments: {} },
    });

    expect(response.status).toBe(200);
    const body = (await parseSingleMcpMessage(response)) as {
      result: { content: Array<{ text: string }> };
    };
    const payload = JSON.parse(body.result.content[0]?.text ?? "") as {
      data: Array<unknown>;
      meta: { limit: number; hasNext: boolean };
    };
    expect(payload.data.length).toBeGreaterThan(0);
    expect(payload.meta.limit).toBeGreaterThan(0);
  });

  test(
    "get_fire_context returns real demo FIRE context",
    { timeout: 30000 },
    async () => {
      const response = await mcpRequest({
        jsonrpc: "2.0",
        id: 14,
        method: "tools/call",
        params: { name: "get_fire_context", arguments: {} },
      });

      expect(response.status).toBe(200);
      const body = (await parseSingleMcpMessage(response)) as {
        result: { content: Array<{ text: string }> };
      };
      const payload = JSON.parse(body.result.content[0]?.text ?? "") as {
        data: { status: string };
      };
      expect(typeof payload.data.status).toBe("string");
    },
  );
});
