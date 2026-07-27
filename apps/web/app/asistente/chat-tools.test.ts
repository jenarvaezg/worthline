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
import {
  HOLDING_REFERENCE_FIELDS,
  NON_HOLDING_ID_FIELDS,
  requiresGroundedHoldingIds,
} from "@web/asistente/holding-id-provenance";
import { hasUnvalidatedProvenance } from "@web/asistente/proposal-provenance";
import { isPublicHoldingId } from "@web/asistente/public-holding-id";
import { UNVALIDATED_EVIDENCE_CLASSES } from "@web/asistente/unvalidated-evidence-gate";
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

function toolsOver(agentView: AgentViewReadStore, groundedHoldingIds: string[] = []) {
  return createChatTools({
    runWithStore: (run) => run({ agentView }),
    asOf: AS_OF,
    // What the route seeds from the conversation's own tool outputs (#1263). A
    // fixture that hands an id straight to a write tool is, to the guard, a model
    // inventing one — so a test about another boundary says where its id came from.
    groundedHoldingIds,
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
      groundedHoldingIds: [holding?.publicId ?? ""],
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
      groundedHoldingIds: [publicId],
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
    const tools = toolsOver(store.agentView, ["wl_hld_x"]);

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
      // Grounded but no longer resolvable — a holding the conversation surfaced and
      // that has since gone. It is the state this test needs: the payload records a
      // null trace with a reason instead of inventing the arithmetic.
      groundedHoldingIds: ["wl_hld_unknown"],
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
      groundedHoldingIds: ["wl_hld_x"],
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

/**
 * The unvalidated-evidence boundary (#1248, PRD #1241) as code, not prompt: a
 * single fact verifiable at a glance may feed a proposal; a bulk import from a
 * document worthline never validated is routed to the deterministic path.
 *
 * Every list here is DERIVED from `UNVALIDATED_EVIDENCE_CLASSES`, so classifying
 * a new tool without wiring its guard fails CI instead of shipping a hole.
 */
describe("createChatTools \u00b7 unvalidated-evidence boundary (#1248)", () => {
  const toolsOfClass = (kind: string) =>
    Object.entries(UNVALIDATED_EVIDENCE_CLASSES)
      .filter(([, value]) => value === kind)
      .map(([name]) => name);
  const REJECTED_TOOLS = toolsOfClass("rejects");
  const WHITELIST_TOOLS = toolsOfClass("accepts");

  const CUENTA = {
    currentValueMinor: 2_500_00,
    family: "stored",
    instrument: "current_account",
    name: "Cuenta BBVA",
  };

  /**
   * One set of args that really builds a proposal, per whitelisted tool — so the
   * cap is proven for ALL of them, not just the cheapest one to call.
   */
  const WHITELIST_ARGS: Record<
    string,
    (ids: Record<string, string>) => Record<string, unknown>
  > = {
    propose_correction: (ids) => ({
      correction: { kind: "edit_config", name: "Cuenta renombrada" },
      holdingId: ids["cuenta"],
    }),
    propose_early_repayment: (ids) => ({
      amountMinor: 91_32,
      liabilityId: ids["prestamo"],
      mode: "reduce-term",
      repaymentDate: "2026-05-20",
    }),
    propose_holding: () => ({ ...CUENTA }),
    propose_property_valuation_anchor: (ids) => ({
      assetId: ids["casa"],
      documentName: "tasacion.pdf",
      documentSha256: "a".repeat(64),
      valuationDate: "2020-06-15",
      valueMinor: 220_000_00,
    }),
  };

  async function workspaceStore(): Promise<WorthlineStore> {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 2_500_00,
      id: "cuenta",
      instrument: "current_account",
      liquidityTier: "cash",
      name: "Cuenta BBVA",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 300_000_00,
      id: "casa",
      isPrimaryResidence: true,
      liquidityTier: "housing",
      name: "Casa",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "real_estate",
    });
    // An amortizable debt with a live plan, so `propose_early_repayment` has a real
    // schedule to project against (#1245).
    await store.liabilities.createLiability({
      balanceMinor: 4_200_00,
      currency: "EUR",
      id: "prestamo",
      name: "Préstamo Revolut",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "debt",
    });
    await store.liabilities.setDebtModel("prestamo", "amortizable");
    await store.command.createAmortizationPlan(
      {
        annualInterestRate: "0.089",
        disbursementDate: "2025-08-15",
        firstPaymentDate: "2025-09-15",
        id: "prestamo_plan",
        initialCapitalMinor: 5_000_00,
        liabilityId: "prestamo",
        termMonths: 36,
      },
      { today: AS_OF },
    );
    return store;
  }

  /** entityId \u2192 public `wl_hld_\u2026` id, which is what the tools take. */
  async function publicIds(store: WorthlineStore): Promise<Record<string, string>> {
    const rows = await store.agentView.readPublicIds();
    return Object.fromEntries(
      rows
        .filter((row) => row.entityType === "holding")
        .map((row) => [row.entityId, row.publicId]),
    );
  }

  async function toolsWithEvidence(
    store: WorthlineStore,
    unvalidatedEvidence = true,
    alsoGrounded: string[] = [],
  ) {
    return createChatTools({
      // This block is about the evidence frontier, not about provenance (#1263):
      // its fixtures read the id table directly, so they declare those ids as
      // already surfaced.
      groundedHoldingIds: [...Object.values(await publicIds(store)), ...alsoGrounded],
      runWithStore: (run) =>
        run({
          agentView: store.agentView,
          assets: store.assets,
          assistantProposals: store.assistantProposals,
          liabilities: store.liabilities,
          workspace: store.workspace,
        }),
      asOf: AS_OF,
      unvalidatedEvidence,
    });
  }

  it("has a real success fixture for every whitelisted tool", () => {
    // Forces the next slice that whitelists a tool to prove it can build.
    expect(Object.keys(WHITELIST_ARGS).sort()).toEqual([...WHITELIST_TOOLS].sort());
  });

  it.each(
    REJECTED_TOOLS,
  )("routes %s to the deterministic path, without touching the builder", async (name) => {
    const store = await workspaceStore();
    let storeReads = 0;
    const tools = createChatTools({
      runWithStore: (run) => {
        storeReads += 1;
        return run({
          agentView: store.agentView,
          assets: store.assets,
          assistantProposals: store.assistantProposals,
          liabilities: store.liabilities,
          workspace: store.workspace,
        });
      },
      asOf: AS_OF,
      unvalidatedEvidence: true,
    });

    const result = (await tools[name]?.execute?.({}, toolCallContext())) as {
      error?: string;
      message?: string;
    };

    expect(result?.error, name).toBe("unvalidated_evidence");
    // The message ROUTES to the deterministic surface instead of asking again
    // for the very file the user just uploaded.
    expect(result?.message, name).toMatch(/importar-extracto/);
    expect(result?.message, name).not.toMatch(/sube el fichero/i);
    // No proposal was ever prepared: the store was not even opened.
    expect(storeReads, name).toBe(0);
  });

  it.each(WHITELIST_TOOLS)("keeps %s working in that same turn", async (name) => {
    const store = await workspaceStore();
    const tools = await toolsWithEvidence(store);

    const result = (await tools[name]?.execute?.(
      WHITELIST_ARGS[name]!(await publicIds(store)) as never,
      toolCallContext(),
    )) as { proposalType?: string };

    // Every success carries `proposalType` — the positive contract the cap reads.
    expect(result?.proposalType, name).toBeTruthy();
  });

  it.each(
    WHITELIST_TOOLS,
  )("spends the turn's single proposal slot when %s succeeds", async (name) => {
    const store = await workspaceStore();
    const tools = await toolsWithEvidence(store);
    const ids = await publicIds(store);

    const first = (await tools[name]?.execute?.(
      WHITELIST_ARGS[name]!(ids) as never,
      toolCallContext(),
    )) as { proposalType?: string };
    expect(first?.proposalType, name).toBeTruthy();

    // The cap spans the several tool rounds of a turn and covers every
    // whitelisted tool, not just the one that spent it.
    for (const other of WHITELIST_TOOLS) {
      const capped = (await tools[other]?.execute?.(
        WHITELIST_ARGS[other]!(ids) as never,
        toolCallContext(),
      )) as { error?: string };
      expect(capped?.error, `${name} \u2192 ${other}`).toBe("unvalidated_evidence_limit");
    }
  });

  /**
   * The cap must hold when the model fires several tool-calls in the SAME step:
   * the AI SDK executes them with `Promise.all`, so a check-then-consume around
   * an `await` would let all of them through with `used = 0` \u2014 the bulk import
   * walking in through the door this slice claims to close.
   */
  it("holds the cap under concurrent tool calls in one step", async () => {
    const store = await workspaceStore();
    let drafts = 0;
    const tools = createChatTools({
      runWithStore: (run) =>
        run({
          agentView: store.agentView,
          assets: store.assets,
          assistantProposals: {
            ...store.assistantProposals,
            create: (proposal) => {
              drafts += 1;
              return store.assistantProposals.create(proposal);
            },
          },
          liabilities: store.liabilities,
          workspace: store.workspace,
        }),
      asOf: AS_OF,
      unvalidatedEvidence: true,
    });

    const results = (await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        tools["propose_holding"]?.execute?.(
          { ...CUENTA, name: `Cuenta ${index}` },
          toolCallContext(),
        ),
      ),
    )) as { proposalType?: string; error?: string }[];

    expect(results.filter((result) => result?.proposalType)).toHaveLength(1);
    expect(
      results.filter((result) => result?.error === "unvalidated_evidence_limit"),
    ).toHaveLength(3);
    // And only one draft ever reached the store.
    expect(drafts).toBe(1);
  });

  it("does not spend the cap on a builder validation error", async () => {
    const store = await workspaceStore();
    const tools = await toolsWithEvidence(store);

    const rejected = (await tools["propose_holding"]?.execute?.(
      { family: "stored", instrument: "current_account", name: "" },
      toolCallContext(),
    )) as { error?: string };
    expect(rejected?.error).toBeTruthy();
    expect(rejected?.error).not.toBe("unvalidated_evidence_limit");

    // The cup was never drunk: the real proposal still goes through.
    const result = await tools["propose_holding"]?.execute?.(CUENTA, toolCallContext());
    expect(result).toMatchObject({ proposalType: "holding_creation" });
  });

  it("gives the slot back when the builder throws", async () => {
    const store = await workspaceStore();
    // A holding the conversation surfaced and that no longer resolves — a deleted
    // one. Since #1263 that is the only way past the evidence gate into a throw:
    // an id nothing ever surfaced is refused before resolution is even attempted.
    const tools = await toolsWithEvidence(store, true, ["wl_hld_nope"]);

    await expect(
      tools["propose_correction"]?.execute?.(
        { correction: { kind: "edit_config", name: "x" }, holdingId: "wl_hld_nope" },
        toolCallContext(),
      ),
    ).rejects.toThrow();

    const result = await tools["propose_holding"]?.execute?.(CUENTA, toolCallContext());
    expect(result).toMatchObject({ proposalType: "holding_creation" });
  });

  // A turn with no unvalidated evidence behaves exactly as before the boundary
  // existed \u2014 including the default (flag absent), which read-only fixtures and
  // the evals rely on.
  it.each([
    { label: "explicit false", unvalidatedEvidence: false },
    { label: "flag absent (the default)", unvalidatedEvidence: undefined },
  ])("gates nothing on a turn with no unvalidated evidence \u00b7 $label", async ({
    unvalidatedEvidence,
  }) => {
    const store = await workspaceStore();
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
      ...(unvalidatedEvidence === undefined ? {} : { unvalidatedEvidence }),
    });

    for (const name of REJECTED_TOOLS) {
      // Past the gate the builder may reject empty fixture args however it likes
      // (envelope or throw) \u2014 what matters is that it RAN.
      const result = await callToolSafely(tools, name);
      expect(result?.error, name).not.toBe("unvalidated_evidence");
    }
    // And more than one single-fact proposal per turn stays possible: the cap
    // exists only to stop a bulk import sneaking in through the side door.
    for (const name of ["Cuenta 1", "Cuenta 2"]) {
      const result = await tools["propose_holding"]?.execute?.(
        { ...CUENTA, name },
        toolCallContext(),
      );
      expect(result, name).toMatchObject({ proposalType: "holding_creation" });
    }
  });

  /**
   * The trash family stays `neutral` in the classification — born from ids already
   * read, reversible through the papelera — and is capped anyway (#1246 review).
   * Capping is not reclassifying: it took a LIST of holdings, which made it the one
   * proposal family with no per-turn limit while unvalidated evidence was on the
   * table, and «varios apuntes de golpe son una importación» applies to bajas too.
   */
  it("budgets a baja without moving it to the rejected side", async () => {
    const store = await workspaceStore();
    const tools = await toolsWithEvidence(store);
    const ids = await publicIds(store);

    // Not rejected outright — the class is unchanged, the proposal is prepared…
    const removal = await tools["propose_holding_removal"]?.execute?.(
      { holdingIds: [ids["cuenta"]] } as never,
      toolCallContext(),
    );
    expect(removal).toMatchObject({ proposalType: "holding_removal" });

    // …and it spends the turn's single slot like any other proposal, so a second
    // family cannot ride along behind it. This is the asymmetry #1246 closes: a
    // batch baja was the one prepared write with no per-turn limit.
    const after = (await tools["propose_holding"]?.execute?.(
      { ...CUENTA, name: "Otra cuenta" } as never,
      toolCallContext(),
    )) as { error?: string };
    expect(after?.error).toBe("unvalidated_evidence_limit");
  });

  /**
   * The provenance mark (#1257): a proposal born in a turn with unvalidated
   * evidence travels to the client already stamped, so the card can say where it
   * comes from without asking the model to admit it.
   */
  it.each(WHITELIST_TOOLS)("stamps %s with the provenance mark", async (name) => {
    const store = await workspaceStore();
    const tools = await toolsWithEvidence(store);

    const result = await tools[name]?.execute?.(
      WHITELIST_ARGS[name]!(await publicIds(store)) as never,
      toolCallContext(),
    );

    expect(hasUnvalidatedProvenance(result), name).toBe(true);
  });

  it("stamps a baja born in that same turn", async () => {
    const store = await workspaceStore();
    const tools = await toolsWithEvidence(store);
    const ids = await publicIds(store);

    // `neutral` in the classification, stamped all the same: what the mark reports
    // is the TURN the proposal was born in, and the text that talked the user into
    // a baja can come out of the unvalidated file just as easily.
    const removal = await tools["propose_holding_removal"]?.execute?.(
      { holdingIds: [ids["cuenta"]] } as never,
      toolCallContext(),
    );

    expect(hasUnvalidatedProvenance(removal)).toBe(true);
  });

  it("leaves an ordinary conversation unmarked", async () => {
    const store = await workspaceStore();
    const tools = await toolsWithEvidence(store, false);

    const result = await tools["propose_holding"]?.execute?.(CUENTA, toolCallContext());

    expect(result).toMatchObject({ proposalType: "holding_creation" });
    expect(hasUnvalidatedProvenance(result)).toBe(false);
  });

  /**
   * The mark is a server signal, and the model's only channel into a tool is its
   * arguments — `jsonSchema()` carries no `validate`, so an undeclared field really
   * does reach `execute`. It must die there: nothing the model writes may forge the
   * stamp on a turn that never carried unvalidated evidence.
   */
  it("ignores a mark the model tries to pass in its arguments", async () => {
    const store = await workspaceStore();
    const tools = await toolsWithEvidence(store, false);

    const result = await tools["propose_holding"]?.execute?.(
      { ...CUENTA, unvalidatedEvidence: true } as never,
      toolCallContext(),
    );

    expect(hasUnvalidatedProvenance(result)).toBe(false);
  });

  it("budgets a restauración too, without rejecting it", async () => {
    const store = await workspaceStore();
    const ids = await publicIds(store);

    // Nothing is in the papelera in this fixture, so the builder answers with its
    // own error — which is precisely why a restoration can never demonstrate the
    // cap by itself: a builder failure rightly gives the slot back. What matters
    // here is that the gate did NOT reject it.
    const fresh = await toolsWithEvidence(store);
    const allowed = (await fresh["propose_holding_restoration"]?.execute?.(
      { holdingIds: [ids["cuenta"]] } as never,
      toolCallContext(),
    )) as { error?: string };
    expect(allowed?.error).not.toBe("unvalidated_evidence");
    expect(allowed?.error).not.toBe("unvalidated_evidence_limit");

    // And with the turn's slot already spent, it is capped — so it really does go
    // through the budget wrapper rather than around it.
    const spent = await toolsWithEvidence(store);
    expect(
      await spent["propose_holding"]?.execute?.(
        { ...CUENTA } as never,
        toolCallContext(),
      ),
    ).toMatchObject({ proposalType: "holding_creation" });
    const capped = (await spent["propose_holding_restoration"]?.execute?.(
      { holdingIds: [ids["cuenta"]] } as never,
      toolCallContext(),
    )) as { error?: string };
    expect(capped?.error).toBe("unvalidated_evidence_limit");
  });

  it("leaves the trash family uncapped on an ordinary turn", async () => {
    const store = await workspaceStore();
    const tools = await toolsWithEvidence(store, false);
    const ids = await publicIds(store);

    // The cap belongs to the boundary, not to the tool: with no unvalidated
    // evidence in play, nothing about the ordinary papelera flow changes.
    for (const id of [ids["cuenta"], ids["casa"]]) {
      const result = (await tools["propose_holding_removal"]?.execute?.(
        { holdingIds: [id] } as never,
        toolCallContext(),
      )) as { error?: string };
      expect(result?.error).not.toBe("unvalidated_evidence_limit");
    }
  });

  it("accumulates with the premium ingestion gate instead of replacing it", async () => {
    const store = await workspaceStore();
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
      ingestionAllowed: false,
      unvalidatedEvidence: true,
    });

    // Where the paywall applied, it still answers: the reason is different.
    const premium = (await tools["propose_statement_import"]?.execute?.(
      {},
      toolCallContext(),
    )) as { error?: string };
    expect(premium?.error).toBe("premium_required");

    // A bulk-import tool with no paywall of its own still hits the boundary.
    const boundary = (await tools["propose_balance_history_import"]?.execute?.(
      {},
      toolCallContext(),
    )) as { error?: string };
    expect(boundary?.error).toBe("unvalidated_evidence");

    // Free + unvalidated evidence: manual tracking of a single fact stays open.
    const alta = await tools["propose_holding"]?.execute?.(CUENTA, toolCallContext());
    expect(alta).toMatchObject({ proposalType: "holding_creation" });
  });
});

/**
 * The vocabulary of holding references, derived from the tool schemas themselves.
 *
 * The guard reads named FIELDS, so a write tool that names a holding in a field
 * nobody classified would walk past the invariant in silence. This is the #1248
 * guardian's shape applied to the other frontier: every id-shaped property of every
 * guarded tool must be declared either a holding reference or explicitly not one.
 */
describe("createChatTools · holding-reference fields are classified (#1263)", () => {
  it(
    "classifies every id-shaped field of every guarded tool",
    async () => {
      const store = await seededStore();
      const tools = toolsOver(store.agentView);

      const unclassified: string[] = [];
      for (const [name, tool] of Object.entries(tools)) {
        if (!requiresGroundedHoldingIds(name)) continue;
        const schema = (tool.inputSchema as { jsonSchema?: unknown }).jsonSchema;
        for (const field of idShapedFields(schema)) {
          if (HOLDING_REFERENCE_FIELDS.has(field) || NON_HOLDING_ID_FIELDS.has(field)) {
            continue;
          }
          unclassified.push(`${name}.${field}`);
        }
      }

      expect(unclassified).toEqual([]);
    },
    SEED_TIMEOUT_MS,
  );
});

/** Every `…Id`/`…Ids` property name in a JSON schema, at any depth. */
function idShapedFields(schema: unknown): Set<string> {
  const fields = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" && typeof value === "object" && value !== null) {
        for (const property of Object.keys(value)) {
          if (/(^ids?|Ids?)$/.test(property)) fields.add(property);
        }
      }
      walk(value);
    }
  };
  walk(schema);
  return fields;
}

/**
 * Holding-id provenance (#1263): an id that reaches a write came out of a read.
 *
 * The production incident, end to end — the model announced one id, then another
 * «he verificado los datos», and called a write tool with a string it had made up.
 */
describe("createChatTools · holding-id provenance (#1263)", () => {
  it(
    "hands the model each holding's id in the compact context",
    async () => {
      const store = await seededStore();
      const tools = toolsOver(store.agentView);

      const context = (await tools["get_financial_context"]?.execute?.(
        {},
        toolCallContext(),
      )) as { holdings: Array<{ id: string; label: string }> };

      // Without this, a write needs an id the always-first read never showed —
      // which is the gap the model filled with its own monologue.
      expect(context.holdings.length).toBeGreaterThan(0);
      for (const holding of context.holdings) {
        // Real minted ids, so this is also what pins `isPublicHoldingId` — the guard
        // and the redaction both lean on it — to what the minter actually produces.
        expect(isPublicHoldingId(holding.id), holding.label).toBe(true);
      }
    },
    SEED_TIMEOUT_MS,
  );

  it(
    "refuses a write whose id no read surfaced, without opening the store",
    async () => {
      const store = await seededStore();
      let storeReads = 0;
      const tools = createChatTools({
        runWithStore: (run) => {
          storeReads += 1;
          return run({
            agentView: store.agentView,
            assets: store.assets,
            assistantProposals: store.assistantProposals,
            liabilities: store.liabilities,
          });
        },
        asOf: AS_OF,
      });

      // The exact string the pool model sent to a write tool.
      const result = (await tools["propose_correction"]?.execute?.(
        {
          correction: { kind: "edit_config", name: "x" },
          holdingId: "wl_hld_mortgage_id_placeholder_need_to_find_it",
        },
        toolCallContext(),
      )) as { error?: string; message?: string };

      expect(result?.error).toBe("ungrounded_holding_id");
      expect(result?.message).toMatch(/identificador/);
      // It never reached id resolution, so the turn does not die on an internal
      // error the user has to read — and nothing was written.
      expect(storeReads).toBe(0);
    },
    SEED_TIMEOUT_MS,
  );

  it(
    "refuses an ungrounded id on the maintainer alert too",
    async () => {
      const store = await seededStore();
      let raised = 0;
      const tools = createChatTools({
        runWithStore: (run) => run({ agentView: store.agentView }),
        asOf: AS_OF,
        raiseMaintainerAlert: async () => {
          raised += 1;
          return null;
        },
      });

      const result = (await tools["raise_maintainer_alert"]?.execute?.(
        { holdingId: "wl_hld_invented", category: "infidelity", summary: "x" },
        toolCallContext(),
      )) as { error?: string };

      expect(result?.error).toBe("ungrounded_holding_id");
      expect(raised).toBe(0);
    },
    SEED_TIMEOUT_MS,
  );

  it(
    "lets the write through once a read in the same turn surfaced the id",
    async () => {
      const store = await seededStore();
      const tools = createChatTools({
        runWithStore: (run) =>
          run({
            agentView: store.agentView,
            assets: store.assets,
            assistantProposals: store.assistantProposals,
            liabilities: store.liabilities,
          }),
        asOf: AS_OF,
      });

      // The honest order, with no seeded history: read first, propose after.
      const context = (await tools["get_financial_context"]?.execute?.(
        {},
        toolCallContext(),
      )) as { holdings: Array<{ id: string }> };
      const holdingId = context.holdings[0]?.id;

      const result = (await tools["propose_correction"]?.execute?.(
        { correction: { kind: "edit_config", name: "Renombrado" }, holdingId },
        toolCallContext(),
      )) as { error?: string };

      // Whatever the builder makes of it, the gate is not what stopped it.
      expect(result?.error).not.toBe("ungrounded_holding_id");
    },
    SEED_TIMEOUT_MS,
  );
});

/** Execute a tool tolerating a builder that throws on fixture-empty args. */
async function callToolSafely(
  tools: ReturnType<typeof createChatTools>,
  name: string,
): Promise<{ error?: string } | undefined> {
  try {
    return (await tools[name]?.execute?.({} as never, toolCallContext())) as {
      error?: string;
    };
  } catch {
    return { error: "builder_threw" };
  }
}

function toolCallContext(): never {
  return { toolCallId: "call-1", messages: [] } as unknown as never;
}
