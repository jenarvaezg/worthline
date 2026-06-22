import { describe, expect, test } from "vitest";

import { createAgentViewMcpToolCatalog } from "./mcp";
import type {
  AgentViewConnectedSourceListEntry,
  AgentViewEnvelope,
  AgentViewPriceFreshnessResult,
  AgentViewScope,
  AgentViewSourceFreshnessResult,
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

  test("list_connected_sources takes no input and hits the connected-sources path", async () => {
    const response: AgentViewEnvelope<AgentViewConnectedSourceListEntry[]> = {
      data: [
        {
          id: "wl_src_abc123",
          object: "connected_source",
          adapter: "binance",
          label: "Binance",
          lastSyncAt: "2026-06-16T10:00:00.000Z",
          holdings: ["wl_hld_def456"],
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

    await expect(catalog.list_connected_sources.invoke({})).resolves.toEqual(response);
    expect(calls).toEqual(["/api/v1/agent-view/connected-sources"]);
    expect(catalog.list_connected_sources.inputSchema).toEqual({
      additionalProperties: false,
      properties: {},
      type: "object",
    });
  });

  test("get_source_freshness requires a sourceId and hits the source's freshness path", async () => {
    const response: AgentViewEnvelope<AgentViewSourceFreshnessResult> = {
      data: {
        object: "source_freshness",
        source: "wl_src_abc123",
        freshness: {
          freshnessState: "stale",
          fetchedAt: "2026-06-16T09:00:00.000Z",
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
      catalog.get_source_freshness.invoke({ sourceId: "wl_src_abc123" }),
    ).resolves.toEqual(response);
    expect(calls).toEqual([
      "/api/v1/agent-view/connected-sources/wl_src_abc123/freshness",
    ]);
    expect(catalog.get_source_freshness.inputSchema).toEqual({
      additionalProperties: false,
      properties: { sourceId: { type: "string" } },
      required: ["sourceId"],
      type: "object",
    });
  });
});
