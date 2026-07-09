import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { GET, POST } from "./route";

// The persona cookie is what flips the store seam into the read-only demo
// (ADR 0030 — the deploy-wide DEMO flag retired). Default: absent ⇒ live/stub.
let mockPersonaCookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "wl_demo_persona" && mockPersonaCookie
        ? { value: mockPersonaCookie }
        : undefined,
  }),
}));

// The verifier's own correctness (real JWT validation + control-plane lookup) is
// covered by verify-token.test.ts. Here we mock it to assert the route WIRING:
// a token the verifier accepts passes through to the handler; anything it rejects
// gets a 401. Only "valid-mcp-token" is accepted.
const VALID_MCP_TOKEN = "valid-mcp-token";
vi.mock("./verify-token", () => ({
  verifyMcpToken: async (_req: Request, bearerToken?: string) =>
    bearerToken === VALID_MCP_TOKEN
      ? {
          token: bearerToken,
          clientId: "workos_user_test",
          scopes: ["worthline:read"],
          extra: { workspaceId: "wl_ws_test", dbUrl: "libsql://wl-test.turso.io" },
        }
      : undefined,
}));

const MCP_URL = "http://localhost:3000/api/mcp";
const PROTOCOL_VERSION = "2024-11-05";
const METADATA_PATH = "/.well-known/oauth-protected-resource";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  },
};

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = original;
  }
}

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

  test("lists the 18 agent-view tools with their catalog schemas", async () => {
    const response = await mcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    expect(response.status).toBe(200);
    const body = (await parseSingleMcpMessage(response)) as {
      result: {
        tools: Array<{
          name: string;
          inputSchema: unknown;
          outputSchema: unknown;
          description: string;
        }>;
      };
    };
    const tools = body.result.tools;

    expect(tools).toHaveLength(18);
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
        "get_price_freshness",
        "get_operations",
        "get_connected_source_positions",
        "list_connected_sources",
        "get_source_freshness",
        "get_workspace",
        "get_warning_overrides",
        "get_member_profile",
        "list_goals",
        "get_fire_projection",
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

    const financialContext = tools.find((tool) => tool.name === "get_financial_context");
    expect(financialContext?.description).toContain("amountMinor");
    expect(financialContext?.description).toContain("minor currency units");
    expect(financialContext?.description).toContain("not euros");
    expect(financialContext?.outputSchema).toMatchObject({
      type: "object",
      description: expect.stringContaining("minor currency units"),
      properties: {
        data: {
          description: expect.stringContaining("#/$defs/money"),
        },
      },
      $defs: {
        money: {
          properties: {
            amountMinor: {
              description: expect.stringContaining("minor currency units"),
            },
            currency: {
              description: expect.stringContaining("ISO 4217"),
            },
          },
        },
      },
    });
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

  test("a malformed call returns a tool error before stub execution", async () => {
    const response = await mcpRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "list_scopes",
        arguments: { unexpected: true },
      },
    });

    expect(response.status).toBe(200);
    const body = (await parseSingleMcpMessage(response)) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    const payload = JSON.parse(body.result.content[0]?.text ?? "");
    expect(body.result.isError).toBe(true);
    expect(payload).toMatchObject({
      error: {
        code: "bad_request",
        details: { properties: ["unexpected"] },
      },
    });
  });

  test("an invalid limit returns a tool error instead of defaulting to 100", async () => {
    const response = await mcpRequest({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "get_snapshot_history",
        arguments: { limit: 0 },
      },
    });

    expect(response.status).toBe(200);
    const body = (await parseSingleMcpMessage(response)) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    const payload = JSON.parse(body.result.content[0]?.text ?? "");
    expect(body.result.isError).toBe(true);
    expect(payload.error.code).toBe("bad_request");
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

describe("POST /api/mcp (hosted — auth configured)", () => {
  const originalId = process.env.AUTH_GOOGLE_ID;
  const originalSecret = process.env.AUTH_GOOGLE_SECRET;
  const originalPersonaCookie = mockPersonaCookie;

  beforeAll(() => {
    // The hosted multi-tenant deploy: auth configured, no persona cookie, no
    // session ⇒ MCP requests must complete the OAuth handshake (ADR 0034).
    mockPersonaCookie = undefined;
    process.env.AUTH_GOOGLE_ID = "test-google-id";
    process.env.AUTH_GOOGLE_SECRET = "test-google-secret";
  });

  afterAll(() => {
    // Restore precisely: assigning `undefined` would set the string "undefined"
    // (truthy), leaving auth "configured" and gating the later demo block.
    mockPersonaCookie = originalPersonaCookie;
    restoreEnv("AUTH_GOOGLE_ID", originalId);
    restoreEnv("AUTH_GOOGLE_SECRET", originalSecret);
  });

  test("no token → 401 with WWW-Authenticate pointing at the metadata (kills 'Failed to parse JSON')", async () => {
    const response = await mcpRequest(initialize);

    expect(response.status).toBe(401);
    const wwwAuth = response.headers.get("www-authenticate") ?? "";
    expect(wwwAuth.toLowerCase()).toContain("bearer");
    expect(wwwAuth).toContain("resource_metadata=");
    expect(wwwAuth).toContain(METADATA_PATH);
  });

  test("invalid token → 401", async () => {
    const response = await mcpRequest(initialize, {
      Authorization: "Bearer not-a-real-token",
    });

    expect(response.status).toBe(401);
  });

  test("a token the verifier accepts passes through to the handler (200)", async () => {
    const response = await mcpRequest(initialize, {
      Authorization: `Bearer ${VALID_MCP_TOKEN}`,
    });

    expect(response.status).toBe(200);
    const body = await parseSingleMcpMessage(response);
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "worthline" } },
    });
  });
});

describe("POST /api/mcp (demo mode)", () => {
  beforeAll(() => {
    // A logged-out persona cookie ⇒ the read-only demo (real-clock; seeded
    // relative to "now", no env pin).
    mockPersonaCookie = "familia";
  });

  afterAll(() => {
    mockPersonaCookie = undefined;
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

  test("explain_figure returns a real explanation for net_worth", {
    timeout: 30000,
  }, async () => {
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
  });

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

  test("get_snapshot_history clamps an over-max limit like the HTTP contract", {
    timeout: 30000,
  }, async () => {
    const response = await mcpRequest({
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: { name: "get_snapshot_history", arguments: { limit: 9999 } },
    });

    expect(response.status).toBe(200);
    const body = (await parseSingleMcpMessage(response)) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    const payload = JSON.parse(body.result.content[0]?.text ?? "") as {
      meta: { limit: number };
    };
    expect(body.result.isError).not.toBe(true);
    expect(payload.meta.limit).toBe(500);
  });

  test("documented error envelopes set isError true", { timeout: 30000 }, async () => {
    const response = await mcpRequest({
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: { name: "get_connected_source_positions", arguments: {} },
    });

    expect(response.status).toBe(200);
    const body = (await parseSingleMcpMessage(response)) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    const payload = JSON.parse(body.result.content[0]?.text ?? "");
    expect(body.result.isError).toBe(true);
    expect(payload.error.code).toBe("unprocessable_entity");
  });

  test("get_fire_context returns real demo FIRE context", {
    timeout: 30000,
  }, async () => {
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
  });
});
