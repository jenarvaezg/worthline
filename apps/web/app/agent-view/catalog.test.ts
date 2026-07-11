import { describe, expect, test } from "vitest";

import {
  type AgentViewBackend,
  connectedSourcePositionsSelectorError,
  createAgentViewCatalog,
} from "./catalog";
import type { AgentViewEnvelope, AgentViewScope } from "./contract";

const SCOPES: AgentViewEnvelope<AgentViewScope[]> = {
  data: [
    {
      id: "wl_scp_member",
      isDefault: false,
      label: "Ana",
      members: [],
      object: "scope",
      type: "member",
    },
    {
      id: "wl_scp_home",
      isDefault: true,
      label: "Hogar",
      members: [],
      object: "scope",
      type: "household",
    },
  ],
};

interface Call {
  method: string;
  args: unknown[];
}

/**
 * A recording backend: every method returns a marker envelope tagged with the
 * method name and echoes back what the catalog dispatched, so a test can assert
 * the shared logic (scope defaulting, the XOR selector) without any store or HTTP.
 */
function recordingBackend(overrides: Partial<AgentViewBackend> = {}): {
  backend: AgentViewBackend;
  calls: Call[];
} {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return { data: { method, args } } as never;
    };

  const backend: AgentViewBackend = {
    listScopes: async () => {
      calls.push({ method: "listScopes", args: [] });
      return SCOPES;
    },
    financialContext: record("financialContext"),
    fireContext: record("fireContext"),
    explainFigure: record("explainFigure"),
    snapshotHistory: record("snapshotHistory"),
    dataQuality: record("dataQuality"),
    trashSummary: record("trashSummary"),
    holdingDetail: record("holdingDetail"),
    priceFreshness: record("priceFreshness"),
    operations: record("operations"),
    holdingConnectedSourcePositions: record("holdingConnectedSourcePositions"),
    sourceConnectedSourcePositions: record("sourceConnectedSourcePositions"),
    connectedSources: record("connectedSources"),
    sourceFreshness: record("sourceFreshness"),
    workspace: record("workspace"),
    warningOverrides: record("warningOverrides"),
    memberProfiles: record("memberProfiles"),
    goals: record("goals"),
    fireProjection: record("fireProjection"),
    contributionPlan: record("contributionPlan"),
    ...overrides,
  };

  return { backend, calls };
}

describe("agent-view catalog · single source of truth (#576)", () => {
  test("exposes exactly the 19 agent-view tools, each with matching metadata", () => {
    const catalog = createAgentViewCatalog();
    const names = Object.values(catalog)
      .map((tool) => tool.name)
      .sort();

    expect(names).toEqual(
      [
        "explain_figure",
        "get_connected_source_positions",
        "get_contribution_plan",
        "get_data_quality",
        "get_financial_context",
        "get_fire_context",
        "get_fire_projection",
        "get_holding_detail",
        "get_member_profile",
        "get_operations",
        "get_price_freshness",
        "get_snapshot_history",
        "get_source_freshness",
        "get_trash_summary",
        "get_warning_overrides",
        "get_workspace",
        "list_connected_sources",
        "list_goals",
        "list_scopes",
      ].sort(),
    );

    // Each entry's record key equals its declared name and carries a schema.
    for (const [key, tool] of Object.entries(catalog)) {
      expect(tool.name).toBe(key);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  test("FIRE tool descriptions agree that in-horizon goals reserve eligible capital", () => {
    const catalog = createAgentViewCatalog();

    expect(catalog.list_goals.description).not.toContain(
      "Goals do not yet change FIRE eligibility",
    );
    expect(catalog.list_goals.description).toContain("FIRE-eligible");
    expect(catalog.get_fire_context.description).toContain("goal reservations");
    expect(catalog.get_fire_projection.description).toContain(
      "goal-reservation-adjusted",
    );
  });

  test("get_contribution_plan labels the whole response as forecast, never truth (ADR 0041)", () => {
    const catalog = createAgentViewCatalog();

    expect(catalog.get_contribution_plan.description).toContain("forecast layer");
    expect(catalog.get_contribution_plan.description).toContain(
      "never enters net worth or snapshots",
    );
    expect(catalog.get_contribution_plan.description).toContain("auto-match");
    expect(catalog.get_contribution_plan.inputSchema.properties).toHaveProperty(
      "growthAssumption",
    );
  });
});

describe("agent-view catalog · scope defaulting", () => {
  test("defaults a scope-taking tool to the household (isDefault) scope", async () => {
    const catalog = createAgentViewCatalog();
    const { backend, calls } = recordingBackend();

    await catalog.get_financial_context.run({}, backend);

    expect(calls[0]?.method).toBe("listScopes");
    expect(calls[1]).toEqual({
      method: "financialContext",
      args: ["wl_scp_home", {}],
    });
  });

  test("uses an explicit scopeId without resolving the default", async () => {
    const catalog = createAgentViewCatalog();
    const { backend, calls } = recordingBackend();

    await catalog.get_fire_context.run({ scopeId: "wl_scp_member" }, backend);

    expect(calls).toEqual([{ method: "fireContext", args: ["wl_scp_member"] }]);
  });

  test("falls back to the first scope when none is marked default", async () => {
    const catalog = createAgentViewCatalog();
    const { backend, calls } = recordingBackend({
      listScopes: async () => ({
        data: [{ ...SCOPES.data[0]!, isDefault: false }],
      }),
    });

    await catalog.list_goals.run({}, backend);

    // The override's listScopes does not record; the goals read is the first call.
    expect(calls[0]).toEqual({ method: "goals", args: ["wl_scp_member"] });
  });

  test("throws when the workspace has no scopes at all", async () => {
    const catalog = createAgentViewCatalog();
    const { backend } = recordingBackend({ listScopes: async () => ({ data: [] }) });

    await expect(catalog.get_financial_context.run({}, backend)).rejects.toThrow(
      /no agent-view scopes/i,
    );
  });

  test("defaults get_contribution_plan to the household scope and forwards the growth toggle", async () => {
    const catalog = createAgentViewCatalog();
    const { backend, calls } = recordingBackend();

    await catalog.get_contribution_plan.run({}, backend);
    await catalog.get_contribution_plan.run(
      { growthAssumption: "flat", scopeId: "wl_scp_member" },
      backend,
    );

    expect(calls[1]).toEqual({ method: "contributionPlan", args: ["wl_scp_home", {}] });
    expect(calls[2]).toEqual({
      method: "contributionPlan",
      args: ["wl_scp_member", { growthAssumption: "flat" }],
    });
  });

  test("strips scopeId before handing pagination params to the backend", async () => {
    const catalog = createAgentViewCatalog();
    const { backend, calls } = recordingBackend();

    await catalog.get_snapshot_history.run(
      { scopeId: "wl_scp_member", limit: 5, granularity: "raw" },
      backend,
    );

    expect(calls).toEqual([
      {
        method: "snapshotHistory",
        args: ["wl_scp_member", { limit: 5, granularity: "raw" }],
      },
    ]);
  });
});

describe("agent-view catalog · connected-source positions selector", () => {
  test("rejects neither holdingId nor sourceId with a 422 before any read", async () => {
    const catalog = createAgentViewCatalog();
    const { backend, calls } = recordingBackend();

    const result = await catalog.get_connected_source_positions.run({}, backend);

    expect(result).toEqual({
      error: {
        code: "unprocessable_entity",
        message:
          "Supply exactly one of holdingId or sourceId for connected-source positions.",
      },
    });
    expect(calls).toEqual([]);
  });

  test("rejects both holdingId and sourceId with a 422 before any read", async () => {
    const catalog = createAgentViewCatalog();
    const { backend, calls } = recordingBackend();

    await catalog.get_connected_source_positions.run(
      { holdingId: "wl_hld_a", sourceId: "wl_src_b" },
      backend,
    );

    expect(calls).toEqual([]);
  });

  test("routes a holdingId-only call to the holding positions read", async () => {
    const catalog = createAgentViewCatalog();
    const { backend, calls } = recordingBackend();

    await catalog.get_connected_source_positions.run(
      { holdingId: "wl_hld_a", limit: 3 },
      backend,
    );

    expect(calls).toEqual([
      {
        method: "holdingConnectedSourcePositions",
        args: [{ holdingId: "wl_hld_a", limit: 3 }],
      },
    ]);
  });

  test("routes a sourceId-only call to the source positions read", async () => {
    const catalog = createAgentViewCatalog();
    const { backend, calls } = recordingBackend();

    await catalog.get_connected_source_positions.run({ sourceId: "wl_src_b" }, backend);

    expect(calls).toEqual([
      {
        method: "sourceConnectedSourcePositions",
        args: [{ sourceId: "wl_src_b" }],
      },
    ]);
  });

  test("connectedSourcePositionsSelectorError encodes the XOR rule", () => {
    expect(connectedSourcePositionsSelectorError({})).not.toBeNull();
    expect(
      connectedSourcePositionsSelectorError({ holdingId: "h", sourceId: "s" }),
    ).not.toBeNull();
    expect(connectedSourcePositionsSelectorError({ holdingId: "h" })).toBeNull();
    expect(connectedSourcePositionsSelectorError({ sourceId: "s" })).toBeNull();
  });
});
