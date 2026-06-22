import { describe, expect, test } from "vitest";

import { createAgentViewMcpToolCatalog } from "./mcp";
import type {
  AgentViewEnvelope,
  AgentViewPriceFreshnessResult,
  AgentViewScope,
} from "./contract";

describe("agent-view MCP tools", () => {
  test("list_scopes calls the HTTP API and returns the same response shape", async () => {
    const response: AgentViewEnvelope<AgentViewScope[]> = {
      data: [
        {
          id: "wl_scp_abc123",
          isDefault: true,
          label: "Hogar",
          members: [{ id: "wl_mbr_def456", label: "Ana", object: "member" }],
          object: "scope",
          type: "household",
        },
      ],
    };
    const calls: string[] = [];
    const catalog = createAgentViewMcpToolCatalog({
      get: async <T>(path: string): Promise<T> => {
        calls.push(path);
        return response as T;
      },
    });

    await expect(catalog.list_scopes.invoke({})).resolves.toEqual(response);
    expect(calls).toEqual(["/api/v1/agent-view/scopes"]);
    expect(catalog.list_scopes.inputSchema).toEqual({
      additionalProperties: false,
      properties: {},
      type: "object",
    });
  });

  test("get_price_freshness requires a holdingId and hits the holding's freshness path", async () => {
    const response: AgentViewEnvelope<AgentViewPriceFreshnessResult> = {
      data: {
        object: "price_freshness",
        holding: "wl_hld_abc123",
        freshness: {
          freshnessState: "stale",
          fetchedAt: "2026-01-01T00:00:00.000Z",
          source: "yahoo",
          staleReason: "Precio caducado",
        },
      },
    };
    const calls: string[] = [];
    const catalog = createAgentViewMcpToolCatalog({
      get: async <T>(path: string): Promise<T> => {
        calls.push(path);
        return response as T;
      },
    });

    await expect(
      catalog.get_price_freshness.invoke({ holdingId: "wl_hld_abc123" }),
    ).resolves.toEqual(response);
    expect(calls).toEqual(["/api/v1/agent-view/holdings/wl_hld_abc123/price-freshness"]);
    expect(catalog.get_price_freshness.inputSchema).toEqual({
      additionalProperties: false,
      properties: { holdingId: { type: "string" } },
      required: ["holdingId"],
      type: "object",
    });
  });
});
