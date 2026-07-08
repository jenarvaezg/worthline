import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { createWorthlineStore } from "@worthline/db";

// A pure token-authenticated MCP request: no persona cookie, no Auth.js session.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

// Mint a distinct workspace per token. The dbUrls are temp files created in
// beforeAll, so the AuthInfo is registered there (the mock factory can't see
// runtime values; the hoisted Map bridges them).
const { mcpAuthByToken } = vi.hoisted(() => ({
  mcpAuthByToken: new Map<
    string,
    {
      token: string;
      clientId: string;
      scopes: string[];
      extra: { workspaceId: string; dbUrl: string };
    }
  >(),
}));
vi.mock("./verify-token", () => ({
  verifyMcpToken: async (_req: Request, bearerToken?: string) =>
    bearerToken ? (mcpAuthByToken.get(bearerToken) ?? undefined) : undefined,
}));

import { POST } from "./route";

const MCP_URL = "http://localhost:3000/api/mcp";
const PROTOCOL_VERSION = "2024-11-05";

const TOKEN_A = "token-workspace-a";
const TOKEN_B = "token-workspace-b";
const TOKEN_EMPTY = "token-empty-workspace";
// Distinct, known net worths — a single cash asset per workspace.
const NET_WORTH_A = 750_000;
const NET_WORTH_B = 500_000;

function authFor(workspaceId: string, dbUrl: string) {
  return {
    token: `oauth-${workspaceId}`,
    clientId: `user-${workspaceId}`,
    scopes: ["worthline:read"],
    extra: { workspaceId, dbUrl },
  };
}

/** Seed a workspace with a single known-value cash asset (no ripple machinery). */
async function seedWorkspace(url: string, cashMinor: number): Promise<void> {
  const store = await createWorthlineStore({ url });
  try {
    await store.workspace.initializeWorkspace({
      members: [{ id: "m1", name: "Uno" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: cashMinor,
      id: "a_cash",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "m1", shareBps: 10_000 }],
      type: "cash",
    });
  } finally {
    store.close();
  }
}

async function callNetWorth(bearerToken: string): Promise<number> {
  const message = (await callTool(bearerToken, "get_financial_context", {})) as {
    result: { content: Array<{ text: string }> };
  };
  const payload = JSON.parse(message.result.content[0]!.text) as {
    data: { summary: { netWorth: { amountMinor: number } } };
  };
  return payload.data.summary.netWorth.amountMinor;
}

async function callTool(
  bearerToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await POST(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Mcp-Protocol-Version": PROTOCOL_VERSION,
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line!.slice("data: ".length));
}

describe("POST /api/mcp — tenant isolation (a token reaches only its own workspace)", () => {
  const originalId = process.env.AUTH_GOOGLE_ID;
  const originalSecret = process.env.AUTH_GOOGLE_SECRET;

  beforeAll(async () => {
    process.env.AUTH_GOOGLE_ID = "test-google-id";
    process.env.AUTH_GOOGLE_SECRET = "test-google-secret";

    // File DBs (not :memory:) so the data survives withStore's close-after-use.
    const dir = mkdtempSync(join(tmpdir(), "wl-mcp-isolation-"));
    const urlA = `file:${join(dir, "workspace-a.db")}`;
    const urlB = `file:${join(dir, "workspace-b.db")}`;
    const urlEmpty = `file:${join(dir, "workspace-empty.db")}`;

    await seedWorkspace(urlA, NET_WORTH_A);
    await seedWorkspace(urlB, NET_WORTH_B);

    mcpAuthByToken.set(TOKEN_A, authFor("ws-a", urlA));
    mcpAuthByToken.set(TOKEN_B, authFor("ws-b", urlB));
    mcpAuthByToken.set(TOKEN_EMPTY, authFor("ws-empty", urlEmpty));
  }, 30000);

  afterAll(() => {
    if (originalId === undefined) delete process.env.AUTH_GOOGLE_ID;
    else process.env.AUTH_GOOGLE_ID = originalId;
    if (originalSecret === undefined) delete process.env.AUTH_GOOGLE_SECRET;
    else process.env.AUTH_GOOGLE_SECRET = originalSecret;
  });

  test("a workspace-A token reads A's data, never B's", { timeout: 30000 }, async () => {
    const fromA = await callNetWorth(TOKEN_A);
    expect(fromA).toBe(NET_WORTH_A);
    expect(fromA).not.toBe(NET_WORTH_B);
  });

  test("a workspace-B token reads B's data, never A's", { timeout: 30000 }, async () => {
    const fromB = await callNetWorth(TOKEN_B);
    expect(fromB).toBe(NET_WORTH_B);
    expect(fromB).not.toBe(NET_WORTH_A);
  });

  test("a just-provisioned empty workspace returns an MCP tool error envelope", async () => {
    const message = (await callTool(TOKEN_EMPTY, "get_financial_context", {})) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    const payload = JSON.parse(message.result.content[0]!.text);

    expect(message.result.isError).toBe(true);
    expect(payload).toEqual({
      error: {
        code: "empty_workspace",
        message: "Workspace has no agent-view scopes yet.",
      },
    });
  });
});
