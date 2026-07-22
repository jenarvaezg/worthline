/**
 * Chat tool boundary tests (#629, ADR 0047): the assistant's read tool
 * resolves real facts through the agent-view layer — same figures the
 * dashboard computes — and cannot write because it only ever sees the
 * read store. Seeded like seed-persona.test.ts (in-memory store, familia).
 */

import { buildFinancialContext } from "@web/agent-view/financial-context";
import { createAgentViewMcpToolCatalog } from "@web/agent-view/mcp";
import { bindScope } from "@web/agent-view/scoped-read";
import { listAgentViewScopes } from "@web/agent-view/scopes";
import { createChatTools } from "@web/asistente/chat-tools";
import { seedPersona } from "@web/demo/seed-persona";
import { FAMILIA_SPEC } from "@web/demo/specs/familia";
import type { AgentViewReadStore, WorthlineStore } from "@worthline/db";
import { createInMemoryStore as createWorthlineInMemoryStore } from "@worthline/db";
import { formatMoneyMinor } from "@worthline/domain";
import { afterEach, describe, expect, it } from "vitest";

const AS_OF = "2026-06-19";
const SEED_TIMEOUT_MS = 15_000;
const openStores = new Set<WorthlineStore>();

async function createInMemoryStore(): Promise<WorthlineStore> {
  const store = await createWorthlineInMemoryStore();
  openStores.add(store);
  return store;
}

afterEach(() => {
  for (const store of openStores) store.close();
  openStores.clear();
});

async function seededStore() {
  const store = await createInMemoryStore();
  await seedPersona(store, FAMILIA_SPEC, AS_OF);
  return store;
}

function toolsOver(agentView: AgentViewReadStore) {
  return createChatTools({
    runWithStore: (run) => run({ agentView }),
    asOf: AS_OF,
  });
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
      const expected = await buildFinancialContext(
        bindScope(store.agentView, defaultScope?.id ?? ""),
        {
          asOf: AS_OF,
          holdingLimit: 10,
        },
      );

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
        // The chat surface mirrors buildFinancialContext, including the #711 S3
        // catalog-availability discriminator (set here: no control plane in tests).
        ...(expected.exposure.byGeography.coverage.catalogUnavailable
          ? {
              catalogUnavailable:
                expected.exposure.byGeography.coverage.catalogUnavailable,
            }
          : {}),
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
      const before = await buildFinancialContext(bindScope(store.agentView, scopeId), {
        asOf: AS_OF,
      });

      const tools = createChatTools({
        runWithStore: (run) => run({ agentView: store.agentView }),
        asOf: AS_OF,
      });
      await tools["get_financial_context"]?.execute?.({}, toolCallContext());

      const after = await buildFinancialContext(bindScope(store.agentView, scopeId), {
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

describe("createChatTools · propose_statement_import (#767)", () => {
  it("persists typed facts through the narrow proposal store and returns no raw text", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "matched_fund",
      isin: "ES00WL000001",
      liquidityTier: "market",
      name: "Fondo existente",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    const tools = createChatTools({
      runWithStore: (run) =>
        run({
          agentView: store.agentView,
          assistantProposals: store.assistantProposals,
        }),
      asOf: AS_OF,
    });
    const rawText = [
      "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre",
      "05/01/2024;Fondo;ES00WL000001;Compra;10,0000;500;;",
    ].join("\r\n");

    const result = await tools["propose_statement_import"]?.execute?.(
      { broker: "plantilla", documentName: "enero.csv", rawText },
      toolCallContext(),
    );

    expect(result).toMatchObject({
      proposalType: "statement_import",
      draft: { proposalId: expect.any(String) },
      funds: [{ bucket: "matched", isin: "ES00WL000001" }],
    });
    expect(JSON.stringify(result)).not.toContain(rawText);
    const proposalId = result.draft.proposalId as string;
    expect(await store.assistantProposals.read(proposalId)).toMatchObject({
      status: "draft",
      documents: [{ document: { name: "enero.csv" } }],
    });
  });
});

describe("createChatTools · propose_reconcile (#1108)", () => {
  it("merges an extracted portfolio into an editable reconcile proposal", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset-amundi",
      instrument: "fund",
      isin: "LU1681043599",
      name: "Amundi MSCI World",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    const tools = createChatTools({
      runWithStore: (run) =>
        run({
          agentView: store.agentView,
          assets: store.assets,
          assistantProposals: store.assistantProposals,
          liabilities: store.liabilities,
          workspace: store.workspace,
        }),
      asOf: AS_OF,
    });

    const result = await tools["propose_reconcile"]?.execute?.(
      {
        documentName: "cartera.xlsx",
        holdings: [
          {
            name: "Amundi MSCI World",
            type: "Fondo",
            isin: "LU1681043599",
            value: 12000,
            currency: "EUR",
            fidelity: "value_only",
          },
          {
            name: "Vanguard Global",
            type: "ETF",
            value: 5000,
            currency: "EUR",
            fidelity: "value_only",
          },
        ],
        movements: [],
      },
      toolCallContext(),
    );

    expect(result).toMatchObject({
      proposalType: "reconcile",
      draft: { proposalId: expect.any(String) },
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].match.decision).toBe("update");
    expect(result.rows[1].match.decision).toBe("create");
    expect(await store.assistantProposals.read(result.draft.proposalId)).toMatchObject({
      kind: "reconcile",
      status: "draft",
    });
  });
});

describe("createChatTools · propose_reconstruction (#1053)", () => {
  it("builds a superficie-C reconstruct proposal from a dated balance series", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.liabilities.createLiability({
      balanceMinor: 140_000_00,
      currency: "EUR",
      id: "mortgage",
      name: "Hipoteca",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "mortgage",
    });
    await store.liabilities.setDebtModel("mortgage", "amortizable");
    await store.command.createAmortizationPlan(
      {
        annualInterestRate: "0.03",
        disbursementDate: "2026-01-15",
        firstPaymentDate: "2026-02-15",
        id: "plan",
        initialCapitalMinor: 150_000_00,
        liabilityId: "mortgage",
        termMonths: 240,
      },
      { today: AS_OF },
    );
    const holding = (await store.agentView.readPublicIds()).find(
      (row) => row.entityType === "holding",
    );
    const tools = createChatTools({
      asOf: AS_OF,
      runWithStore: (run) =>
        run({
          agentView: store.agentView,
          assistantProposals: store.assistantProposals,
          liabilities: store.liabilities,
        }),
    });

    const result = await tools["propose_reconstruction"]?.execute?.(
      {
        documentName: "extracto.pdf",
        holdingId: holding?.publicId,
        rows: [{ balanceMinor: 140_000_00, date: AS_OF }],
      },
      toolCallContext(),
    );

    expect(result).toMatchObject({
      holding: { name: "Hipoteca" },
      mode: "reconstruir",
      proposalType: "correction",
    });
    const proposalId = (result as { draft: { proposalId: string } }).draft.proposalId;
    expect(await store.assistantProposals.read(proposalId)).toMatchObject({
      kind: "correction",
      status: "draft",
    });
    store.close();
  });
});

describe("createChatTools · search_market_symbol (#1186)", () => {
  it("is a read tool wired over resolveMarketSymbolCandidates (blank query → no matches)", async () => {
    const store = await seededStore();
    const tools = toolsOver(store.agentView);
    const tool = tools["search_market_symbol"];
    expect(tool).toBeDefined();

    // A blank query short-circuits before any network call — deterministic wiring
    // check; the routing/disambiguation logic is covered in market-symbol-search.test.
    const result = await tool?.execute?.(
      { query: "   ", instrument: "etf" },
      toolCallContext(),
    );

    expect(result).toEqual({ matches: [] });
  });
});

describe("createChatTools · propose_holding (#1105)", () => {
  it("builds an alta proposal and persists a holding_creation draft", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    const tools = createChatTools({
      runWithStore: (run) =>
        run({
          agentView: store.agentView,
          assets: store.assets,
          assistantProposals: store.assistantProposals,
          liabilities: store.liabilities,
          workspace: store.workspace,
        }),
      asOf: AS_OF,
    });

    const result = await tools["propose_holding"]?.execute?.(
      {
        currentValueMinor: 2_500_00,
        family: "stored",
        instrument: "current_account",
        name: "Cuenta BBVA",
      },
      toolCallContext(),
    );

    expect(result).toMatchObject({
      family: "stored",
      holding: { name: "Cuenta BBVA" },
      proposalType: "holding_creation",
    });
    const proposalId = (result as { draft: { proposalId: string } }).draft.proposalId;
    expect(await store.assistantProposals.read(proposalId)).toMatchObject({
      kind: "holding_creation",
      status: "draft",
    });
    store.close();
  });
});

describe("createChatTools · propose_holding_removal (#1106)", () => {
  it("builds a baja proposal and persists a holding_removal draft", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 2_500_00,
      id: "a1",
      instrument: "current_account",
      liquidityTier: "cash",
      name: "Cuenta BBVA",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });
    const publicId = (await store.agentView.readPublicIds()).find(
      (row) => row.entityType === "holding" && row.entityId === "a1",
    )!.publicId;
    const tools = createChatTools({
      runWithStore: (run) =>
        run({
          agentView: store.agentView,
          assets: store.assets,
          assistantProposals: store.assistantProposals,
          liabilities: store.liabilities,
          workspace: store.workspace,
        }),
      asOf: AS_OF,
    });

    const result = await tools["propose_holding_removal"]?.execute?.(
      { holdingIds: [publicId] },
      toolCallContext(),
    );

    expect(result).toMatchObject({
      operation: "remove",
      proposalType: "holding_removal",
    });
    const proposalId = (result as { draft: { proposalId: string } }).draft.proposalId;
    expect(await store.assistantProposals.read(proposalId)).toMatchObject({
      kind: "holding_removal",
      status: "draft",
    });
    store.close();
  });
});

describe("createChatTools · raise_maintainer_alert (#1050)", () => {
  it("reports the alert as unavailable when no raise callback is bound", async () => {
    const store = await seededStore();
    const tools = toolsOver(store.agentView);

    const result = await tools["raise_maintainer_alert"]?.execute?.(
      { holdingId: "wl_hld_x", category: "infidelity", summary: "algo huele mal" },
      toolCallContext(),
    );

    expect(result).toEqual({ error: "maintainer_alert_unavailable" });
  });

  it("assembles the forensic payload and routes it to the bound raise callback", async () => {
    const store = await seededStore();
    const raised: Array<{
      holdingId: string;
      category: string;
      payload: unknown;
    }> = [];
    const tools = createChatTools({
      runWithStore: (run) => run({ agentView: store.agentView }),
      asOf: AS_OF,
      raiseMaintainerAlert: async (alert) => {
        raised.push(alert);
        return {
          alert: {
            id: "alert-1",
            workspaceId: "ws-x",
            holdingId: alert.holdingId,
            category: alert.category,
            status: "open",
            occurrenceCount: 1,
            firstSeenAt: "2026-06-19T00:00:00.000Z",
            lastSeenAt: "2026-06-19T00:00:00.000Z",
            resolutionNote: null,
            resolutionLink: null,
            resolvedAt: null,
            supersedesAlertId: null,
            createdAt: "2026-06-19T00:00:00.000Z",
            updatedAt: "2026-06-19T00:00:00.000Z",
          },
          created: true,
        };
      },
    });

    const result = await tools["raise_maintainer_alert"]?.execute?.(
      {
        holdingId: "wl_hld_unknown",
        category: "infidelity",
        summary: "El saldo pintado no coincide con el recomputado.",
        conversationRef: "msg-42",
      },
      toolCallContext(),
    );

    // The alert reached the callback with the raw category + holding id.
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      holdingId: "wl_hld_unknown",
      category: "infidelity",
    });
    // The payload is assembled server-side: the model's summary + conversation
    // ref, and a null trace with a documented reason when the holding is not a
    // traceable debt (the tool never fabricates the arithmetic).
    expect(raised[0]?.payload).toMatchObject({
      category: "infidelity",
      summary: "El saldo pintado no coincide con el recomputado.",
      conversationRef: "msg-42",
      calculationTrace: null,
    });
    expect(result).toMatchObject({ status: "raised", alertId: "alert-1", created: true });
  });

  it("rejects an unknown category", async () => {
    const store = await seededStore();
    const tools = createChatTools({
      runWithStore: (run) => run({ agentView: store.agentView }),
      asOf: AS_OF,
      raiseMaintainerAlert: async () => null,
    });

    const result = await tools["raise_maintainer_alert"]?.execute?.(
      { holdingId: "wl_hld_x", category: "nonsense", summary: "x" } as never,
      toolCallContext(),
    );

    expect(result).toMatchObject({ error: { code: "bad_request" } });
  });
});

/** Minimal execution options the AI SDK passes to execute — unused by our tools. */
describe("createChatTools · premium ingestion gate (#1162)", () => {
  const GATED_TOOLS = [
    "propose_statement_import",
    "propose_reconstruction",
    "propose_mixed_document_import",
    "propose_reconcile",
  ];

  it("refuses each document-ingestion tool for a free workspace, honestly", async () => {
    const store = await seededStore();
    const tools = createChatTools({
      runWithStore: (run) => run({ agentView: store.agentView }),
      asOf: AS_OF,
      ingestionAllowed: false,
    });

    for (const name of GATED_TOOLS) {
      const result = (await tools[name]?.execute?.({}, toolCallContext())) as {
        error?: string;
        message?: string;
      };
      expect(result?.error, name).toBe("premium_required");
      expect((result?.message ?? "").length, name).toBeGreaterThan(0);
    }
  });

  it("leaves reads and manual tracking open for a free workspace", async () => {
    const store = await seededStore();
    const tools = createChatTools({
      runWithStore: (run) => run({ agentView: store.agentView }),
      asOf: AS_OF,
      ingestionAllowed: false,
    });

    const read = (await tools["get_financial_context"]?.execute?.(
      {},
      toolCallContext(),
    )) as { error?: string };
    expect(read?.error).not.toBe("premium_required");
  });

  it("allows the ingestion tools when premium (the default)", async () => {
    const store = await seededStore();
    const tools = toolsOver(store.agentView);

    for (const name of GATED_TOOLS) {
      const result = (await tools[name]?.execute?.({}, toolCallContext())) as {
        error?: string;
      };
      // Past the gate: the persistence-unavailable fixture error is fine — what
      // matters is that it is NOT the premium wall.
      expect(result?.error, name).not.toBe("premium_required");
    }
  });
});

function toolCallContext(): never {
  return { toolCallId: "call-1", messages: [] } as unknown as never;
}
