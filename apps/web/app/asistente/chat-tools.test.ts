/**
 * Chat tool boundary tests (#629, ADR 0047): the assistant's read tool
 * resolves real facts through the agent-view layer — same figures the
 * dashboard computes — and cannot write because it only ever sees the
 * read store. Seeded like seed-persona.test.ts (in-memory store, familia).
 */

import { buildFinancialContext } from "@web/agent-view/financial-context";
import { createAgentViewMcpToolCatalog } from "@web/agent-view/mcp";
import { listAgentViewScopes } from "@web/agent-view/scopes";
import { createChatTools } from "@web/asistente/chat-tools";
import { seedPersona } from "@web/demo/seed-persona";
import { FAMILIA_SPEC } from "@web/demo/specs/familia";
import type { AgentViewReadStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { formatMoneyMinor } from "@worthline/domain";
import { describe, expect, it } from "vitest";

const AS_OF = "2026-06-19";
const SEED_TIMEOUT_MS = 15_000;

async function seededStore() {
  const store = await createInMemoryStore();
  await seedPersona(store, FAMILIA_SPEC, AS_OF);
  return store;
}

function toolsOver(agentView: AgentViewReadStore) {
  return createChatTools({ runWithStore: (run) => run({ agentView }), asOf: AS_OF });
}

async function firstHoldingPublicId(agentView: AgentViewReadStore): Promise<string> {
  const holding = (await agentView.readPublicIds()).find(
    (row) => row.entityType === "holding",
  );
  if (!holding) throw new Error("seed has no holding public id");
  return holding.publicId;
}

describe("createChatTools · get_financial_context", () => {
  it(
    "reads the default scope's real figures through the agent-view boundary, with source links",
    async () => {
      const store = await seededStore();
      const tools = createChatTools({
        runWithStore: (run) => run({ agentView: store.agentView }),
        asOf: AS_OF,
      });

      const tool = tools["get_financial_context"];
      expect(tool).toBeDefined();
      const result = await tool?.execute?.({}, toolCallContext());

      const scopes = await listAgentViewScopes(store.agentView);
      const defaultScope = scopes.find((s) => s.isDefault) ?? scopes[0];
      const expected = await buildFinancialContext(store.agentView, {
        scopeId: defaultScope?.id ?? "",
        asOf: AS_OF,
        holdingLimit: 10,
      });

      // Amounts arrive FORMATTED (es-ES strings): a model reading raw
      // amountMinor recites céntimos as euros — the #629 smoke bug.
      expect(result.summary.netWorth).toBe(formatMoneyMinor(expected.summary.netWorth));
      expect(result.summary.netWorth).toMatch(/€/);
      expect(JSON.stringify(result)).not.toContain("amountMinor");

      expect(result.scope.id).toBe(defaultScope?.id);
      expect(result.liquidity.length).toBeGreaterThan(0);
      expect(result.exposure.byGeography.coverage).toEqual({
        classified: formatMoneyMinor(expected.exposure.byGeography.coverage.classified),
        notApplicable: formatMoneyMinor(
          expected.exposure.byGeography.coverage.notApplicable,
        ),
        unknown: formatMoneyMinor(expected.exposure.byGeography.coverage.unknown),
      });
      expect(result.holdings.length).toBeGreaterThan(0);
      expect(Object.keys(result.links).length).toBeGreaterThan(0);
    },
    SEED_TIMEOUT_MS,
  );

  it(
    "mutates nothing observable in the workspace",
    async () => {
      const store = await seededStore();
      const scopes = await listAgentViewScopes(store.agentView);
      const scopeId = (scopes.find((s) => s.isDefault) ?? scopes[0])?.id ?? "";
      const before = await buildFinancialContext(store.agentView, {
        scopeId,
        asOf: AS_OF,
      });

      const tools = createChatTools({
        runWithStore: (run) => run({ agentView: store.agentView }),
        asOf: AS_OF,
      });
      await tools["get_financial_context"]?.execute?.({}, toolCallContext());

      const after = await buildFinancialContext(store.agentView, {
        scopeId,
        asOf: AS_OF,
      });
      expect(after).toEqual(before);
    },
    SEED_TIMEOUT_MS,
  );

  it("reports an empty workspace instead of inventing figures", async () => {
    const store = await createInMemoryStore();
    const tools = createChatTools({
      runWithStore: (run) => run({ agentView: store.agentView }),
      asOf: AS_OF,
    });

    const result = await tools["get_financial_context"]?.execute?.({}, toolCallContext());

    expect(result).toEqual({ error: "empty_workspace" });
  });
});

describe("createChatTools · full read catalog (#630)", () => {
  it("serves every agent-view read tool the MCP catalog exposes", () => {
    // ADR 0047 keeps chat as a separate catalog, but it should still expose the
    // same read lenses by name unless a divergence is intentional and documented.
    // It may add non-read tools (e.g. suggest_actions, #631) on top.
    const mcp = createAgentViewMcpToolCatalog({ get: async () => ({}) as never });
    const chat = new Set(Object.keys(toolsOver({} as AgentViewReadStore)));
    for (const name of Object.keys(mcp)) {
      expect(chat).toContain(name);
    }
  });

  it(
    "get_holding_detail resolves a real holding with amounts already formatted",
    async () => {
      const store = await seededStore();
      const holdingId = await firstHoldingPublicId(store.agentView);
      const tools = toolsOver(store.agentView);

      const result = await tools["get_holding_detail"]?.execute?.(
        { holdingId },
        toolCallContext(),
      );

      // Real fact resolved through the boundary, no raw céntimos recited.
      expect(result.id).toBe(holdingId);
      expect(JSON.stringify(result)).not.toContain("amountMinor");
      expect(JSON.stringify(result)).toMatch(/€/);
    },
    SEED_TIMEOUT_MS,
  );

  it(
    "surfaces uncertainty for an unknown holding instead of throwing",
    async () => {
      const store = await seededStore();
      const tools = toolsOver(store.agentView);

      const result = await tools["get_holding_detail"]?.execute?.(
        { holdingId: "wl_hld_doesnotexist" },
        toolCallContext(),
      );

      // ADR 0048: a missing fact is a stated error envelope, never a guess.
      expect(result.error.code).toBe("not_found");
    },
    SEED_TIMEOUT_MS,
  );

  it("rejects a bad connected-source-positions selector (neither/both)", async () => {
    const store = await createInMemoryStore();
    const tools = toolsOver(store.agentView);

    const neither = await tools["get_connected_source_positions"]?.execute?.(
      {},
      toolCallContext(),
    );
    const both = await tools["get_connected_source_positions"]?.execute?.(
      { holdingId: "wl_hld_a", sourceId: "wl_src_b" },
      toolCallContext(),
    );

    expect(neither.error.code).toBe("unprocessable_entity");
    expect(both.error.code).toBe("unprocessable_entity");
  });

  it("rejects an unknown figure name for explain_figure", async () => {
    const store = await createInMemoryStore();
    const tools = toolsOver(store.agentView);

    const result = await tools["explain_figure"]?.execute?.(
      { figure: "not_a_figure" },
      toolCallContext(),
    );

    expect(result.error.code).toBe("bad_request");
  });

  it("reports an empty workspace for scope-defaulting tools", async () => {
    const store = await createInMemoryStore();
    const tools = toolsOver(store.agentView);

    const result = await tools["get_data_quality"]?.execute?.({}, toolCallContext());

    expect(result).toEqual({ error: "empty_workspace" });
  });

  it(
    "reports invalid paginated limits instead of silently clamping to one",
    async () => {
      const store = await seededStore();
      const tools = toolsOver(store.agentView);

      const result = await tools["get_snapshot_history"]?.execute?.(
        { limit: 0 },
        toolCallContext(),
      );

      expect(result.error.code).toBe("bad_request");
      expect(result.error.message).toBe("limit must be a positive integer.");
    },
    SEED_TIMEOUT_MS,
  );
});

describe("createChatTools · suggest_actions (#631)", () => {
  it(
    "resolves a cited holding to its worthline surface and keeps follow-ups",
    async () => {
      const store = await seededStore();
      const holding = (await store.agentView.readPublicIds()).find(
        (row) => row.entityType === "holding",
      )!;
      const tools = toolsOver(store.agentView);

      const result = await tools["suggest_actions"]?.execute?.(
        {
          actions: [
            {
              type: "openInternalSource",
              label: "Ver posición",
              holding: holding.publicId,
            },
            { type: "openInternalSource", label: "Histórico", section: "historico" },
            {
              type: "runSuggestedAnalysis",
              label: "¿Y mi FIRE?",
              prompt: "¿Cómo va mi FIRE?",
            },
          ],
        },
        toolCallContext(),
      );

      expect(result.actions).toEqual([
        {
          type: "openInternalSource",
          label: "Ver posición",
          href: `/patrimonio/${holding.entityId}/editar`,
        },
        { type: "openInternalSource", label: "Histórico", href: "/historico" },
        {
          type: "runSuggestedAnalysis",
          label: "¿Y mi FIRE?",
          prompt: "¿Cómo va mi FIRE?",
        },
      ]);
    },
    SEED_TIMEOUT_MS,
  );

  it("drops actions it cannot resolve or that fall outside the typed set", async () => {
    const store = await createInMemoryStore();
    const tools = toolsOver(store.agentView);

    const result = await tools["suggest_actions"]?.execute?.(
      {
        actions: [
          { type: "openInternalSource", label: "Fantasma", holding: "wl_hld_ghost" },
          { type: "mutateHolding", label: "Borrar", holding: "wl_hld_x" },
          { type: "runSuggestedAnalysis", label: "sin prompt" },
        ],
      },
      toolCallContext(),
    );

    expect(result.actions).toEqual([]);
  });
});

describe("createChatTools · propose_exposure_profiles (#706)", () => {
  it("returns a preview proposal without writing exposure profiles", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "world",
      instrument: "etf",
      isin: "IE00B4L5Y983",
      liquidityTier: "market",
      name: "iShares MSCI World",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      providerSymbol: "SWDA",
    });
    await store.exposureProfiles.saveExposureProfile({
      key: "IE00B4L5Y983",
      source: "user",
      ter: "0.002",
    });
    const before = await store.exposureProfiles.readExposureProfiles();
    const tools = toolsOver(store.agentView);

    const result = await tools["propose_exposure_profiles"]?.execute?.(
      {
        drafts: [
          {
            key: "IE00B4L5Y983",
            breakdowns: { geography: { us: "0.7" } },
            trackedIndex: "MSCI World",
          },
        ],
      },
      toolCallContext(),
    );

    expect(result.proposalType).toBe("exposure_profiles");
    expect(result.previews).toEqual([
      {
        after: {
          breakdowns: { geography: { us: "0.7" } },
          hedged: false,
          ter: "0.002",
          trackedIndex: "MSCI World",
        },
        before: {
          breakdowns: {},
          hedged: false,
          ter: "0.002",
          trackedIndex: null,
        },
        key: "IE00B4L5Y983",
        labels: ["iShares MSCI World"],
      },
    ]);
    expect(await store.exposureProfiles.readExposureProfiles()).toEqual(before);
  });
});

describe("createChatTools · list_exposure_profile_fill_targets (#707)", () => {
  it("lists only hand-enterable exposure targets, gap-first", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "world",
      instrument: "etf",
      isin: "IE00B4L5Y983",
      liquidityTier: "market",
      name: "MSCI World",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      providerSymbol: "SWDA",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "sp500",
      instrument: "etf",
      isin: "IE00B5BMR087",
      liquidityTier: "market",
      name: "S&P 500",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      providerSymbol: "CSPX",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "btc",
      instrument: "crypto",
      liquidityTier: "market",
      name: "Bitcoin",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      providerSymbol: "bitcoin",
    });
    await store.exposureProfiles.saveExposureProfile({
      key: "IE00B5BMR087",
      breakdowns: {
        assetClass: { equity: "1" },
        currency: { USD: "1" },
        geography: { us: "1" },
      },
    });
    const tools = toolsOver(store.agentView);

    const result = await tools["list_exposure_profile_fill_targets"]?.execute?.(
      {},
      toolCallContext(),
    );

    expect(result.policy).toEqual({
      neverNormalizePartialBreakdowns: true,
      noWebLookup: true,
      underDeclareWhenUnsure: true,
    });
    expect(result.targets).toEqual([
      {
        gapDimensions: ["geography", "currency", "assetClass"],
        key: "IE00B4L5Y983",
        labels: ["MSCI World"],
        status: "missing_profile",
      },
      {
        gapDimensions: [],
        key: "IE00B5BMR087",
        labels: ["S&P 500"],
        status: "classified",
      },
    ]);
  });
});

/** Minimal execution options the AI SDK passes to execute — unused by our tools. */
function toolCallContext(): never {
  return { toolCallId: "call-1", messages: [] } as unknown as never;
}
