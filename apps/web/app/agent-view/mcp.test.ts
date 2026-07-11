import { describe, expect, test } from "vitest";
import type {
  AgentViewConnectedSourceListEntry,
  AgentViewEnvelope,
  AgentViewFireProjection,
  AgentViewGoal,
  AgentViewMemberProfile,
  AgentViewPriceFreshnessResult,
  AgentViewScope,
  AgentViewSourceFreshnessResult,
  AgentViewWarningOverride,
  AgentViewWorkspaceInfo,
} from "./contract";
import { createAgentViewMcpToolCatalog } from "./mcp";

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

  test("get_workspace takes no input and hits the workspace path", async () => {
    const response: AgentViewEnvelope<AgentViewWorkspaceInfo> = {
      data: { object: "workspace", mode: "household", baseCurrency: "EUR" },
    };
    const calls: string[] = [];
    const catalog = createAgentViewMcpToolCatalog({
      get: async <T>(path: string): Promise<T> => {
        calls.push(path);
        return response as T;
      },
    });

    await expect(catalog.get_workspace.invoke({})).resolves.toEqual(response);
    expect(calls).toEqual(["/api/v1/agent-view/workspace"]);
    expect(catalog.get_workspace.inputSchema).toEqual({
      additionalProperties: false,
      properties: {},
      type: "object",
    });
  });

  test("get_warning_overrides takes no input and hits the warning-overrides path", async () => {
    const response: AgentViewEnvelope<AgentViewWarningOverride[]> = {
      data: [
        {
          object: "warning_override",
          code: "ZERO_VALUE_ASSET",
          holding: "wl_hld_abc123",
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

    await expect(catalog.get_warning_overrides.invoke({})).resolves.toEqual(response);
    expect(calls).toEqual(["/api/v1/agent-view/warning-overrides"]);
    expect(catalog.get_warning_overrides.inputSchema).toEqual({
      additionalProperties: false,
      properties: {},
      type: "object",
    });
  });

  test("get_member_profile takes no input and hits the members path", async () => {
    const response: AgentViewEnvelope<AgentViewMemberProfile[]> = {
      data: [
        {
          object: "member_profile",
          id: "wl_mbr_abc123",
          name: "Jose",
          birthYear: 1990,
          fiscalCountry: "ES",
          riskTolerance: "moderate",
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

    await expect(catalog.get_member_profile.invoke({})).resolves.toEqual(response);
    expect(calls).toEqual(["/api/v1/agent-view/members"]);
    expect(catalog.get_member_profile.inputSchema).toEqual({
      additionalProperties: false,
      properties: {},
      type: "object",
    });
  });

  test("list_goals hits the scoped goals path", async () => {
    const response: AgentViewEnvelope<AgentViewGoal[]> = {
      data: [
        {
          object: "goal",
          id: "g1",
          name: "Coche",
          targetAmount: { amountMinor: 3_000_000, currency: "EUR" },
          deadline: "2027-06-01",
          priority: "high",
          assignedHoldings: ["wl_hld_abc123"],
          reservedAmount: { amountMinor: 2_280_000, currency: "EUR" },
          fundedRatio: "0.76",
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

    await expect(
      catalog.list_goals.invoke({ scopeId: "wl_scp_abc123" }),
    ).resolves.toEqual(response);
    expect(calls).toEqual(["/api/v1/agent-view/scopes/wl_scp_abc123/goals"]);
  });

  test("get_fire_projection hits the scoped fire-projection path", async () => {
    const response: AgentViewEnvelope<AgentViewFireProjection> = {
      data: {
        object: "fire_projection",
        scope: {
          id: "wl_scp_abc123",
          isDefault: true,
          label: "Hogar",
          members: [],
          object: "scope",
          type: "household",
        },
        status: "configured",
        fireNumber: { amountMinor: 75_000_000, currency: "EUR" },
        scenarios: [],
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
      catalog.get_fire_projection.invoke({ scopeId: "wl_scp_abc123" }),
    ).resolves.toEqual(response);
    expect(calls).toEqual(["/api/v1/agent-view/scopes/wl_scp_abc123/fire-projection"]);
  });

  test("get_contribution_plan hits the scoped contribution-plan path", async () => {
    const response: AgentViewEnvelope<{ object: string }> = {
      data: {
        object: "contribution_plan_context",
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
      catalog.get_contribution_plan.invoke({
        scopeId: "wl_scp_abc123",
        month: "2026-07",
        growthAssumption: "historical",
        reconciliationWindowDays: 60,
      }),
    ).resolves.toEqual(response);
    expect(calls).toEqual([
      "/api/v1/agent-view/scopes/wl_scp_abc123/contribution-plan?month=2026-07&growthAssumption=historical&reconciliationWindowDays=60",
    ]);
  });
});
