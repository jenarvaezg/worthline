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
import {
  DEFAULT_SNAPSHOT_LIMIT,
  MAX_SNAPSHOT_LIMIT_WITH_HOLDING_ROWS,
} from "@web/agent-view/snapshot-history";
import { extractedDocumentSchema } from "@web/asistente/attachment-extraction-contract";
import { createChatTools } from "@web/asistente/chat-tools";
import {
  HOLDING_REFERENCE_FIELDS,
  NON_HOLDING_ID_FIELDS,
  requiresGroundedHoldingIds,
} from "@web/asistente/holding-id-provenance";
import type { MaintainerAlertPayload } from "@web/asistente/maintainer-alert";
import { hasUnvalidatedProvenance } from "@web/asistente/proposal-provenance";
import { isPublicHoldingId } from "@web/asistente/public-holding-id";
import { buildReconstructionProposal } from "@web/asistente/reconstruction-proposals";
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

  it(
    "caps the per-position decomposition to a short window, not the whole series (#1268)",
    async () => {
      const store = await seededStore();
      const tools = toolsOver(store.agentView);

      const shape = await tools["get_snapshot_history"]?.execute?.({}, toolCallContext());
      const detailed = await tools["get_snapshot_history"]?.execute?.(
        { includeHoldingRows: "full" },
        toolCallContext(),
      );

      // The cheap read still walks the whole default page — the seed has more
      // closes than the window, so the cap has something to bite on.
      expect(shape.entries.length).toBeGreaterThan(MAX_SNAPSHOT_LIMIT_WITH_HOLDING_ROWS);
      expect(detailed.entries.length).toBe(MAX_SNAPSHOT_LIMIT_WITH_HOLDING_ROWS);
      expect(detailed.meta.holdingRowsWindow).toEqual({
        requestedLimit: DEFAULT_SNAPSHOT_LIMIT,
      });
      // Narrowed, never truncated: the rest of the series is one cursor away.
      expect(detailed.meta.hasNext).toBe(true);
    },
    SEED_TIMEOUT_MS,
  );

  it("tells the model what each holding-rows mode costs (#1268)", () => {
    const description = createChatTools({
      runWithStore: (run) => run({ agentView: {} as AgentViewReadStore }),
      asOf: AS_OF,
    })["get_snapshot_history"]?.description;

    // The most expensive read in the assistant cannot be chosen blind: the
    // description names the modes, the window they force, and how to pick which
    // snapshots land inside it.
    expect(description).toContain("includeHoldingRows");
    for (const mode of ["none", "summary", "full"]) {
      expect(description, mode).toContain(mode);
    }
    expect(description).toContain(String(MAX_SNAPSHOT_LIMIT_WITH_HOLDING_ROWS));
    expect(description).toContain("sort=-date");
    expect(description).toContain("get_holding_detail");
  });
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
          // The chip's href carries the PUBLIC id (#1318) — the same one the
          // model cited and the one the route now takes; it used to splice in
          // the internal id, so the link never resolved.
          href: `/patrimonio/${holding.publicId}/editar`,
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

  /**
   * The model names the holding instead of citing its id (#1375) — «holding:
   * «N5396 - Myinvestor Indexado Global PP»» — which used to be dropped in silence,
   * leaving the turn with no chip at all and its prose block with nothing to match.
   */
  describe("a holding named instead of cited (#1375)", () => {
    async function storeWithFunds(names: readonly string[]): Promise<WorthlineStore> {
      const store = await createInMemoryStore();
      await store.workspace.initializeWorkspace({
        members: [{ id: "m", name: "Titular" }],
        mode: "individual",
      });
      for (const [index, name] of names.entries()) {
        await store.assets.createInvestmentAsset({
          currency: "EUR",
          id: `fund-${index}`,
          instrument: "fund",
          name,
          ownership: [{ memberId: "m", shareBps: 10_000 }],
        });
      }
      return store;
    }

    async function chipFor(store: WorthlineStore, holding: string) {
      const result = await toolsOver(store.agentView)["suggest_actions"]?.execute?.(
        { actions: [{ type: "openInternalSource", label: "Abrir detalles", holding }] },
        toolCallContext(),
      );
      return result.actions;
    }

    it("resolves the name, guillemets and all, to the holding's own surface", async () => {
      const store = await storeWithFunds(["N5396 - Myinvestor Indexado Global PP"]);
      const publicId = await firstHoldingPublicId(store.agentView);

      expect(await chipFor(store, "«N5396 - Myinvestor Indexado Global PP»")).toEqual([
        {
          type: "openInternalSource",
          label: "Abrir detalles",
          href: `/patrimonio/${publicId}/editar`,
        },
      ]);
    });

    it("drops an ambiguous name rather than opening the likeliest holding", async () => {
      const store = await storeWithFunds(["Fondo Global A", "Fondo Global B"]);

      expect(await chipFor(store, "Fondo Global")).toEqual([]);
    });

    it("drops a name no live holding carries", async () => {
      const store = await storeWithFunds(["Fondo Global A"]);

      expect(await chipFor(store, "Plan de Pensiones Inventado")).toEqual([]);
    });

    it("never lets a made-up destination through the name via (#1289)", async () => {
      const store = await storeWithFunds(["Fondo Global A"]);

      expect(
        await chipFor(
          store,
          "openInternalSource?holding=Fondo Global A&section=patrimonio",
        ),
      ).toEqual([]);
      expect(await chipFor(store, "https://evil.test")).toEqual([]);
    });
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

  /**
   * The document lane of #1487. Jorge's DEGIRO export is read deterministically, so the
   * rows the proposal persists must be the READING's — the model relays nothing, and a
   * `rawText` it typed anyway is dropped rather than merged (the #1418 provenance rule).
   */
  it("builds from a validated transactions document, ignoring text the model typed", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "sxr1",
      isin: "IE00B5BMR087",
      liquidityTier: "market",
      name: "iShares Core S&P 500",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    const ledger = extractedDocumentSchema.parse({
      documentType: "broker_transactions",
      transactions: [
        {
          amount: "562.44",
          currency: "EUR",
          date: "2026-02-12",
          feesMinor: 100,
          isin: "IE00B5BMR087",
          kind: "buy",
          name: "ISHARES CORE S&P 500",
          pricePerUnit: "187.48",
          units: "3",
        },
      ],
      warnings: [],
    });
    const tools = createChatTools({
      runWithStore: (run) =>
        run({
          agentView: store.agentView,
          assistantProposals: store.assistantProposals,
        }),
      asOf: AS_OF,
      validatedDocuments: [ledger],
    });

    const result = await tools["propose_statement_import"]?.execute?.(
      { documentName: "Transactions.xlsx", rawText: "Fecha;Importe\n01/01/2026;99999" },
      toolCallContext(),
    );

    expect(result).toMatchObject({
      proposalType: "statement_import",
      funds: [{ bucket: "matched", isin: "IE00B5BMR087" }],
    });
    const proposalId = result.draft.proposalId as string;
    expect(await store.assistantProposals.read(proposalId)).toMatchObject({
      documents: [
        {
          document: { name: "Transactions.xlsx" },
          facts: [{ kind: "statement_operation", row: { units: "3", feesMinor: 100 } }],
        },
      ],
    });
  });

  it("refuses without a document and without text, and says where to go", async () => {
    const store = await createInMemoryStore();
    const tools = createChatTools({
      runWithStore: (run) =>
        run({
          agentView: store.agentView,
          assistantProposals: store.assistantProposals,
        }),
      asOf: AS_OF,
    });

    const result = await tools["propose_statement_import"]?.execute?.(
      {},
      toolCallContext(),
    );

    expect(result).toMatchObject({ error: expect.any(String) });
  });
});

describe("createChatTools · propose_reconcile (#1108, frontera de documento #1373)", () => {
  /**
   * The lane is document-only (#1373): the rows come from an extraction worthline
   * validated and the model only selects among them. Every case here therefore
   * starts from a real validated document — the same one, so the difference between
   * cases is what the MODEL says about it.
   */
  const VALIDATED_CARTERA = extractedDocumentSchema.parse({
    documentType: "positions_movements",
    holdings: [
      {
        name: "Amundi MSCI World",
        type: "Fondo",
        isin: "LU1681043599",
        value: 12_000,
        currency: "EUR",
        fidelity: "value_only",
      },
      {
        name: "Vanguard Global",
        type: "ETF",
        value: 5_000,
        currency: "EUR",
        fidelity: "value_only",
      },
    ],
    movements: [],
    warnings: [],
  });

  async function reconcileStore() {
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
    return store;
  }

  function reconcileTools(
    store: Awaited<ReturnType<typeof reconcileStore>>,
    validatedDocuments: Parameters<typeof createChatTools>[0]["validatedDocuments"],
  ) {
    return createChatTools({
      runWithStore: (run) =>
        run({
          agentView: store.agentView,
          assets: store.assets,
          assistantProposals: store.assistantProposals,
          liabilities: store.liabilities,
          workspace: store.workspace,
        }),
      asOf: AS_OF,
      ...(validatedDocuments ? { validatedDocuments } : {}),
    });
  }

  it("merges an extracted portfolio into an editable reconcile proposal", async () => {
    const store = await reconcileStore();
    const tools = reconcileTools(store, [VALIDATED_CARTERA]);

    const result = await tools["propose_reconcile"]?.execute?.(
      {
        documentName: "cartera.xlsx",
        holdings: [{ name: "Amundi MSCI World" }, { name: "Vanguard Global" }],
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

  it("takes the figures from the document, not from what the model typed (#1373)", async () => {
    const store = await reconcileStore();
    const tools = reconcileTools(store, [VALIDATED_CARTERA]);

    const result = await tools["propose_reconcile"]?.execute?.(
      // The model relays the row it must, and the value is right to the euro: the
      // cents still come from the extraction, never from the relay.
      { holdings: [{ name: "Vanguard Global", value: 5_000 }] },
      toolCallContext(),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe("Vanguard Global");
    expect(result.rows[0].valueMinor).toBe(500_000);
  });

  /**
   * A refused call must not even open the store: no draft, no read, no write. The
   * store here throws if it is touched, which is the strongest form of that check.
   */
  function refusingTools(
    validatedDocuments: Parameters<typeof createChatTools>[0]["validatedDocuments"],
  ) {
    return createChatTools({
      runWithStore: () => {
        throw new Error("the reconcile must not open the store to refuse");
      },
      asOf: AS_OF,
      ...(validatedDocuments ? { validatedDocuments } : {}),
    });
  }

  it("refuses a turn with no validated positions document, and routes (#1373)", async () => {
    const tools = refusingTools(undefined);

    const result = (await tools["propose_reconcile"]?.execute?.(
      {
        holdings: [
          // The invention of the session: the workspace's own holding, typed in.
          { name: "Amundi MSCI World", type: "Fondo", value: 12_000, currency: "EUR" },
        ],
      },
      toolCallContext(),
    )) as { error?: string; message?: string };

    expect(result.error).toBe("reconcile_document_required");
    expect(result.message).toContain("importar-extracto");
  });

  it("refuses a row that is not in the validated document (#1373)", async () => {
    const tools = refusingTools([VALIDATED_CARTERA]);

    const result = (await tools["propose_reconcile"]?.execute?.(
      { holdings: [{ name: "N5396 - Myinvestor Indexado Global PP", value: 5_387 }] },
      toolCallContext(),
    )) as { error?: string; message?: string };

    expect(result.error).toBe("reconcile_row_not_in_document");
    expect(result.message).toContain("Amundi MSCI World");
  });
});

describe("createChatTools · propose_operation (#1374)", () => {
  /**
   * The lane «añádeme esta compra» had none of (#1374). Its fact comes from a
   * validated `holding_event` — the MyInvestor aportación confirmation of the issue —
   * and the model only points at it and says which way it runs.
   */
  const VALIDATED_APORTACION = extractedDocumentSchema.parse({
    documentType: "holding_event",
    event: {
      date: "2026-08-05",
      amount: 125,
      currency: "EUR",
      label: "APORTACION P.P. MYINVESTOR INDEXADO SP 500 PP",
      kind: "other",
      isin: "ES0173516115",
      units: 5.92,
      pricePerUnit: { amount: 21.12, currency: "EUR" },
      fees: { amount: 0, currency: "EUR" },
    },
    warnings: [],
  });

  async function operationStore() {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset-plan",
      instrument: "pension_plan",
      isin: "ES0173516115",
      name: "MyInvestor Indexado SP500",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    // Seeded through the intent-level command: the narrowed application store this
    // suite uses does not expose the raw persistence seam.
    await store.command.recordInvestmentOperation(
      {
        assetId: "asset-plan",
        currency: "EUR",
        executedAt: "2025-09-15",
        id: "op-seed",
        kind: "buy",
        pricePerUnit: "20",
        units: "262.012",
      },
      { today: "2026-08-05" },
    );
    return store;
  }

  async function operationTools(
    store: Awaited<ReturnType<typeof operationStore>>,
    validatedDocuments: Parameters<typeof createChatTools>[0]["validatedDocuments"],
  ) {
    const publicId = (await store.agentView.readPublicIds()).find(
      (row) => row.entityId === "asset-plan",
    )?.publicId;
    return {
      publicId: publicId ?? "",
      tools: createChatTools({
        groundedHoldingIds: publicId ? [publicId] : [],
        runWithStore: (run) =>
          run({
            agentView: store.agentView,
            assets: store.assets,
            assistantProposals: store.assistantProposals,
            operations: store.operations,
          }),
        asOf: "2026-08-05",
        ...(validatedDocuments ? { validatedDocuments } : {}),
      }),
    };
  }

  it("turns the attached confirmation into ONE operation proposal", async () => {
    const store = await operationStore();
    const { publicId, tools } = await operationTools(store, [VALIDATED_APORTACION]);

    const result = await tools["propose_operation"]?.execute?.(
      {
        holdingId: publicId,
        kind: "contribution",
        date: "2026-08-05",
        amount: 125,
        currency: "EUR",
        units: 5.92,
        pricePerUnit: 21.12,
        fees: 0,
      },
      toolCallContext(),
    );

    expect(result).toMatchObject({
      proposalType: "investment_operation",
      draft: { proposalId: expect.any(String) },
    });
    expect(result.position).toEqual({ unitsAfter: "267,932", unitsBefore: "262,012" });
    expect(await store.assistantProposals.read(result.draft.proposalId)).toMatchObject({
      kind: "investment_operation",
      status: "draft",
    });
  });

  /** A refused call must not even open the store: no draft, no read, no write. */
  function refusingOperationTools(
    validatedDocuments: Parameters<typeof createChatTools>[0]["validatedDocuments"],
  ) {
    return createChatTools({
      groundedHoldingIds: ["wl_hld_plan"],
      runWithStore: () => {
        throw new Error("the operation must not open the store to refuse");
      },
      asOf: "2026-08-05",
      ...(validatedDocuments ? { validatedDocuments } : {}),
    });
  }

  it("refuses a turn with no validated receipt, and routes", async () => {
    const tools = refusingOperationTools(undefined);

    const result = (await tools["propose_operation"]?.execute?.(
      { holdingId: "wl_hld_plan", kind: "contribution", amount: 125 },
      toolCallContext(),
    )) as { error?: string; message?: string };

    expect(result.error).toBe("operation_document_required");
    expect(result.message).toContain("justificante");
  });

  it("refuses a figure the validated receipt does not carry", async () => {
    const tools = refusingOperationTools([VALIDATED_APORTACION]);

    const result = (await tools["propose_operation"]?.execute?.(
      // The invention of the session: a snapshot of the portfolio as the figure.
      { holdingId: "wl_hld_plan", kind: "contribution", amount: 5_387 },
      toolCallContext(),
    )) as { error?: string; message?: string };

    expect(result.error).toBe("operation_fact_not_in_document");
    expect(result.message).toContain("125");
  });

  /**
   * The direction is the ONE judgement the document cannot make, so it is never
   * defaulted: `jsonSchema()`'s `required` is not validated at runtime, and code
   * picking «buy» would be code reading the paper. Same for the destination holding.
   */
  it("refuses to pick the direction, or the holding, for the model", async () => {
    const tools = refusingOperationTools([VALIDATED_APORTACION]);

    const noKind = (await tools["propose_operation"]?.execute?.(
      { holdingId: "wl_hld_plan", amount: 125 },
      toolCallContext(),
    )) as { error?: string; message?: string };
    expect(noKind.error).toBe("operation_kind_required");
    expect(noKind.message).toContain("No lo elijo yo");

    const badKind = (await tools["propose_operation"]?.execute?.(
      { holdingId: "wl_hld_plan", kind: "aportación" },
      toolCallContext(),
    )) as { error?: string };
    expect(badKind.error).toBe("operation_kind_required");

    const noHolding = (await tools["propose_operation"]?.execute?.(
      { kind: "contribution" },
      toolCallContext(),
    )) as { error?: string };
    expect(noHolding.error).toBe("operation_holding_required");
  });

  /**
   * The routing half of #1374's acceptance: the description has to say when this tool
   * is the one and when the batch lanes are, so the model does not reach for a
   * portfolio reconcile to record a single dated fact.
   */
  it("names the batch lanes it is NOT, in its own description", async () => {
    const tools = refusingOperationTools([VALIDATED_APORTACION]);
    const description = tools["propose_operation"]?.description ?? "";

    expect(description).toContain("propose_reconcile");
    expect(description).toContain("propose_statement_import");
    expect(description).toContain("propose_holding");
    expect(description).toContain("propose_correction");
  });
});

describe("createChatTools · propose_transfer (#1482)", () => {
  /**
   * The lane «he traspasado 1.018,67 € del fondo A al fondo B» had none (#1482). What
   * this block drives is the WIRING of its frontier, which the parser's own suite
   * cannot see: the tool takes no importe and no date, so unless worthline read them
   * off the user's message there is nothing to build from — and the refusal has to say
   * which gap it fell into.
   */
  async function transferStore() {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jorge" }],
      mode: "individual",
    });
    for (const [id, name, price] of [
      ["asset-origen", "Indexado PP", "12"],
      ["asset-destino", "Cartera Permanente PP", "14.50"],
    ] as const) {
      await store.assets.createInvestmentAsset({
        currency: "EUR",
        id,
        instrument: "pension_plan",
        manualPricePerUnit: price,
        name,
        ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      });
    }
    await store.command.recordInvestmentOperation(
      {
        assetId: "asset-origen",
        currency: "EUR",
        executedAt: "2025-09-15",
        id: "op-seed",
        kind: "buy",
        pricePerUnit: "10",
        units: "100",
      },
      { today: "2026-08-21" },
    );
    return store;
  }

  async function transferTools(
    store: WorthlineStore,
    typedTransfer: Parameters<typeof createChatTools>[0]["typedTransfer"],
  ) {
    const publicIds = await store.agentView.readPublicIds();
    const idOf = (entityId: string) =>
      publicIds.find((row) => row.entityId === entityId)?.publicId ?? "";
    const origin = idOf("asset-origen");
    const destination = idOf("asset-destino");
    return {
      destination,
      origin,
      tools: createChatTools({
        asOf: "2026-08-21",
        groundedHoldingIds: [origin, destination],
        runWithStore: (run) =>
          run({
            agentView: store.agentView,
            assets: store.assets,
            assistantProposals: store.assistantProposals,
            operations: store.operations,
          }),
        ...(typedTransfer ? { typedTransfer } : {}),
      }),
    };
  }

  const DICTATED = {
    status: "read",
    transfer: {
      executedAt: "2026-08-14",
      portion: { amountMinor: 73_922, kind: "amount" },
    },
  } as const;

  it("builds ONE traspaso proposal from the figures worthline read in the message", async () => {
    const store = await transferStore();
    const { destination, origin, tools } = await transferTools(store, DICTATED);

    const result = await tools["propose_transfer"]?.execute?.(
      { destinationHoldingId: destination, originHoldingId: origin },
      toolCallContext(),
    );

    expect(result).toMatchObject({
      dictated: "14/08/2026 · 739,22\u00a0€",
      proposalType: "investment_transfer",
      draft: { proposalId: expect.any(String) },
    });
    store.close();
  });

  it("refuses when worthline read no traspaso in the message, naming both gaps", async () => {
    const store = await transferStore();
    const { destination, origin, tools } = await transferTools(store, undefined);

    const result = (await tools["propose_transfer"]?.execute?.(
      // The figures a model might try to smuggle are not even fields of the schema, so
      // this is the whole of what it can send — and it is not enough.
      { destinationHoldingId: destination, originHoldingId: origin },
      toolCallContext(),
    )) as { error?: string; message?: string };

    expect(result.error).toBe("transfer_not_in_message");
    expect(result.message).toContain("no he visto cuánto se ha traspasado");
    expect(result.message).toContain("no he visto la fecha");
    store.close();
  });

  it("relays which gap the message fell into when the reading was ambiguous", async () => {
    const store = await transferStore();
    const { destination, origin, tools } = await transferTools(store, {
      missing: ["ambiguous_amount"],
      status: "incomplete",
    });

    const result = (await tools["propose_transfer"]?.execute?.(
      { destinationHoldingId: destination, originHoldingId: origin },
      toolCallContext(),
    )) as { error?: string; message?: string };

    expect(result.error).toBe("transfer_not_in_message");
    expect(result.message).toContain("más de una cifra");
    expect(result.message).toContain("«Traspasar»");
    store.close();
  });

  it("refuses a call that names only one side of the pair", async () => {
    const store = await transferStore();
    const { origin, tools } = await transferTools(store, DICTATED);

    const result = (await tools["propose_transfer"]?.execute?.(
      { originHoldingId: origin },
      toolCallContext(),
    )) as { error?: string; message?: string };

    expect(result.error).toBe("transfer_holdings_required");
    store.close();
  });

  it("routes away from the two lanes a traspaso is NOT", async () => {
    const store = await transferStore();
    const { tools } = await transferTools(store, DICTATED);
    const description = tools["propose_transfer"]?.description ?? "";

    expect(description).toContain("propose_holding");
    expect(description).toContain("propose_operation");
    // And the sibling points back, which is what stops a venta + compra (#1393).
    expect(tools["propose_operation"]?.description ?? "").toContain("propose_transfer");
    store.close();
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

describe("createChatTools · propose_reconstruction_amendment (#1423)", () => {
  async function mortgageTools() {
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
    return { holdingId: holding?.publicId ?? "", store, tools };
  }

  it("excluye por rango sobre la propuesta abierta y devuelve una tarjeta nueva", async () => {
    const { holdingId, store, tools } = await mortgageTools();
    const open = (await tools["propose_reconstruction"]?.execute?.(
      {
        documentName: "extracto.pdf",
        holdingId,
        rows: [
          { balanceMinor: 145_000_00, date: "2026-05-12" },
          { balanceMinor: 140_000_00, date: AS_OF },
        ],
      },
      toolCallContext(),
    )) as { draft: { proposalId: string } };

    const amended = await tools["propose_reconstruction_amendment"]?.execute?.(
      {
        operations: [{ action: "exclude", from: AS_OF }],
        proposalId: open.draft.proposalId,
      },
      toolCallContext(),
    );

    expect(amended).toMatchObject({ mode: "reconstruir", proposalType: "correction" });
    const series = (amended as { series: Array<{ date: string; excluded?: boolean }> })
      .series;
    expect(series.find((point) => point.date === AS_OF)?.excluded).toBe(true);
    // La anterior queda descartada: su tarjeta ya no puede aplicar la serie vieja.
    expect(await store.assistantProposals.read(open.draft.proposalId)).toMatchObject({
      status: "discarded",
    });
    store.close();
  });

  it("relaya un error honesto cuando la propuesta ya no está abierta", async () => {
    const { store, tools } = await mortgageTools();

    const amended = await tools["propose_reconstruction_amendment"]?.execute?.(
      { operations: [{ action: "exclude", date: AS_OF }], proposalId: "no_existe" },
      toolCallContext(),
    );

    expect((amended as { error: string }).error).toContain(
      "ninguna propuesta de reconstrucción abierta",
    );
    store.close();
  });

  it("dice en su descripción que no se reemita la serie recortada", async () => {
    const { store, tools } = await mortgageTools();
    const description = tools["propose_reconstruction_amendment"]?.description ?? "";

    expect(description).toContain("propose_reconstruction");
    expect(description).toContain("Excluir");
    // Y la hermana apunta a ella, que es donde el modelo la va a buscar.
    expect(tools["propose_reconstruction"]?.description ?? "").toContain(
      "propose_reconstruction_amendment",
    );
    store.close();
  });
});

describe("createChatTools · search_market_symbol (#1186)", () => {
  it(
    "is a read tool wired over resolveMarketSymbolCandidates (blank query → no matches)",
    async () => {
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
    },
    SEED_TIMEOUT_MS,
  );
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

  /**
   * The schema is the model's only channel: a term of the opening it cannot NAME
   * is a term it cannot pass, which is exactly how #1315 lost the títulos and the
   * comisión. `additionalProperties: false` is what makes this a real frontier.
   */
  it("declares units and feesMinor for the opening, and nothing undeclared", async () => {
    const store = await createInMemoryStore();
    const tools = createChatTools({
      runWithStore: (run) => run({ agentView: store.agentView }),
      asOf: AS_OF,
    });

    const schema = (
      tools["propose_holding"]?.inputSchema as {
        jsonSchema: {
          additionalProperties: boolean;
          properties: Record<string, { type: string }>;
        };
      }
    ).jsonSchema;

    expect(schema.properties["units"]).toEqual({ type: "string" });
    expect(schema.properties["feesMinor"]).toEqual({ type: "integer" });
    expect(schema.additionalProperties).toBe(false);
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
  it(
    "reports the alert as unavailable when no raise callback is bound",
    async () => {
      const store = await seededStore();
      const tools = toolsOver(store.agentView, ["wl_hld_x"]);

      const result = await tools["raise_maintainer_alert"]?.execute?.(
        { holdingId: "wl_hld_x", category: "infidelity", summary: "algo huele mal" },
        toolCallContext(),
      );

      expect(result).toEqual({ error: "maintainer_alert_unavailable" });
    },
    SEED_TIMEOUT_MS,
  );

  it(
    "assembles the forensic payload and routes it to the bound raise callback",
    async () => {
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
          // The user's figure: with no trace to adjudicate it, this is the
          // discrepancy the alert stands on (#1347).
          declaredBalanceMinor: 559_200,
          declaredDate: "2026-06-19",
          declaredSource: "extracto del banco",
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
      expect(result).toMatchObject({
        status: "raised",
        alertId: "alert-1",
        created: true,
      });
    },
    SEED_TIMEOUT_MS,
  );

  it(
    "rejects an unknown category",
    async () => {
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
    },
    SEED_TIMEOUT_MS,
  );

  it(
    "refuses to be used as a support ticket, and says where the thing IS done (#1347)",
    async () => {
      const store = await seededStore();
      let raised = 0;
      const refusals: Array<{ category: string; refusal: string }> = [];
      const tools = createChatTools({
        runWithStore: (run) => run({ agentView: store.agentView }),
        asOf: AS_OF,
        groundedHoldingIds: ["wl_hld_unknown"],
        onMaintainerAlertRefused: (rejection) => refusals.push(rejection),
        raiseMaintainerAlert: async () => {
          raised += 1;
          return null;
        },
      });

      // The real 2026-07-30 payload: the user's WISH written as an infidelity
      // alert, with no figure in conflict and no trace behind it.
      const result = (await tools["raise_maintainer_alert"]?.execute?.(
        {
          holdingId: "wl_hld_unknown",
          category: "infidelity",
          summary:
            "El usuario desea asignar el ISIN LU0000000000 al fondo, pero propose_correction no permite editarlo.",
        },
        toolCallContext(),
      )) as { error?: string; message?: string };

      expect(result?.error).toBe("maintainer_alert_without_discrepancy");
      // Nothing reached the control plane: no phantom «Infidelidad» on /admin.
      expect(raised).toBe(0);
      // And the model is handed the honest relay, not just a wall.
      expect(result?.message).toMatch(/no hay ningún equipo/i);
      expect(result?.message).toMatch(/\/patrimonio/);
      // The refusal is reported: a gate over the only forensic channel there is
      // must not be able to over-block in silence.
      expect(refusals).toEqual([
        { category: "infidelity", refusal: "maintainer_alert_without_discrepancy" },
      ]);
    },
    SEED_TIMEOUT_MS,
  );

  it(
    "refuses a declared figure that is only the painted one read back (#1347)",
    async () => {
      const store = await seededStore();
      const payloads: MaintainerAlertPayload[] = [];
      const tools = createChatTools({
        runWithStore: (run) => run({ agentView: store.agentView }),
        asOf: AS_OF,
        raiseMaintainerAlert: async (alert) => {
          payloads.push(alert.payload as MaintainerAlertPayload);
          return null;
        },
      });

      const context = (await tools["get_financial_context"]?.execute?.(
        {},
        toolCallContext(),
      )) as { holdings: Array<{ id: string }> };
      const holdingId = context.holdings[0]!.id;

      // A figure that really conflicts travels — and its payload tells us what
      // the engine paints, in the raw minor units /admin reconciles with.
      const conflicting = (await tools["raise_maintainer_alert"]?.execute?.(
        {
          holdingId,
          category: "residual",
          summary: "El banco dice otra cosa.",
          declaredBalanceMinor: 1,
          declaredDate: AS_OF,
        },
        toolCallContext(),
      )) as { error?: string };
      expect(conflicting?.error).toBeUndefined();
      const painted = payloads[0]?.holding?.currentValue;
      expect(painted).toBeDefined();

      // Hand that very figure back as the user's «correct» one: a number is now
      // no longer a free pass through the gate.
      const result = (await tools["raise_maintainer_alert"]?.execute?.(
        {
          holdingId,
          category: "residual",
          summary: "Creo que esta cifra está mal.",
          declaredBalanceMinor: painted!.amountMinor,
          declaredDate: AS_OF,
        },
        toolCallContext(),
      )) as { error?: string };

      expect(result?.error).toBe("maintainer_alert_figures_agree");
      // Only the conflicting one ever reached the control plane.
      expect(payloads).toHaveLength(1);
    },
    SEED_TIMEOUT_MS,
  );
});

/** Minimal execution options the AI SDK passes to execute — unused by our tools. */
describe("createChatTools · premium ingestion gate (#1162)", () => {
  const GATED_TOOLS = [
    "propose_statement_import",
    "propose_reconstruction",
    // Enmendar una reconstrucción es la misma ingesta, un turno más tarde (#1423).
    "propose_reconstruction_amendment",
    "propose_mixed_document_import",
    "propose_reconcile",
    // Reading an operation off its receipt is document ingestion too (#1374).
    "propose_operation",
  ];

  it(
    "refuses each document-ingestion tool for a free workspace, honestly",
    async () => {
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
    },
    SEED_TIMEOUT_MS,
  );

  it(
    "leaves reads and manual tracking open for a free workspace",
    async () => {
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
    },
    SEED_TIMEOUT_MS,
  );

  it(
    "allows the ingestion tools when premium (the default)",
    async () => {
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
    },
    SEED_TIMEOUT_MS,
  );
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
    (
      ids: Record<string, string>,
      store: WorthlineStore,
    ) => Record<string, unknown> | Promise<Record<string, unknown>>
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
    // Enmendar (#1423) necesita una reconstrucción ABIERTA, así que la arma por el
    // builder: la enmienda no lee ningún documento, solo los puntos ya persistidos.
    propose_reconstruction_amendment: async (ids, store) => {
      const built = await buildReconstructionProposal(
        store,
        {
          liabilityId: "prestamo",
          publicHoldingId: ids["prestamo"] ?? "",
          rows: [
            { balanceMinor: 4_400_00, date: "2026-05-15" },
            { balanceMinor: 4_200_00, date: AS_OF },
          ],
        },
        AS_OF,
      );
      if (!built.ok) throw new Error(built.error);
      return {
        operations: [{ action: "exclude", date: "2026-05-15" }],
        proposalId: built.proposal.draft.proposalId,
      };
    },
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
      (await WHITELIST_ARGS[name]!(await publicIds(store), store)) as never,
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
      (await WHITELIST_ARGS[name]!(ids, store)) as never,
      toolCallContext(),
    )) as { proposalType?: string };
    expect(first?.proposalType, name).toBeTruthy();

    // The cap spans the several tool rounds of a turn and covers every
    // whitelisted tool, not just the one that spent it.
    for (const other of WHITELIST_TOOLS) {
      const capped = (await tools[other]?.execute?.(
        (await WHITELIST_ARGS[other]!(ids, store)) as never,
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
      (await WHITELIST_ARGS[name]!(await publicIds(store), store)) as never,
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

  /**
   * The mark answers the PREMISE, the gate answers the verdict — and this is the
   * turn where they disagree: an unreadable file left its trace in the history and
   * this message also brings a validated document, so nothing is gated (the bulk
   * tools work, the cap is lifted) while the unvalidated grid is still in the
   * model's context. A proposal here must carry the mark; hanging it off the gate's
   * verdict would drop it on exactly the most confusable turn.
   */
  it("marks a turn whose gate a validated document lifted", async () => {
    const store = await workspaceStore();
    const tools = createChatTools({
      groundedHoldingIds: Object.values(await publicIds(store)),
      hasUnvalidatedEvidence: true,
      runWithStore: (run) =>
        run({
          agentView: store.agentView,
          assets: store.assets,
          assistantProposals: store.assistantProposals,
          liabilities: store.liabilities,
          workspace: store.workspace,
        }),
      asOf: AS_OF,
      unvalidatedEvidence: false,
    });

    // Not gated: two single-fact proposals in the same turn, no cap in sight…
    for (const name of ["Cuenta 1", "Cuenta 2"]) {
      const result = await tools["propose_holding"]?.execute?.(
        { ...CUENTA, name },
        toolCallContext(),
      );
      // …and both marked all the same.
      expect(result, name).toMatchObject({ proposalType: "holding_creation" });
      expect(hasUnvalidatedProvenance(result), name).toBe(true);
    }
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

  /**
   * The way out that does not need another upload (#1418). Both halves are asserted
   * here because either one alone would be a hole: the lane has to OPEN, and it has to
   * build from the series worthline parsed off the message — the model is holding the
   * document worthline could not validate, so rows it typed could be figures it
   * remembers from that document.
   */
  it("reopens the debt-history lane with the series the user typed (#1418)", async () => {
    const store = await workspaceStore();
    const ids = await publicIds(store);
    const tools = createChatTools({
      groundedHoldingIds: Object.values(ids),
      runWithStore: (run) =>
        run({
          agentView: store.agentView,
          assets: store.assets,
          assistantProposals: store.assistantProposals,
          liabilities: store.liabilities,
          workspace: store.workspace,
        }),
      asOf: AS_OF,
      typedBalanceSeries: {
        rows: [
          { balanceMinor: 3_900_00, date: "2025-12-15" },
          { balanceMinor: 3_750_00, date: "2026-01-15" },
        ],
        status: "read",
      },
      unvalidatedEvidence: true,
    });

    const proposal = (await tools["propose_balance_history_import"]?.execute?.(
      {
        documentName: "cartera-que-no-pude-leer.xlsx",
        liabilityId: ids["prestamo"],
        // What the model sent: a row nobody typed, from the grid it still has.
        rows: [{ balanceMinor: 99_00, date: "2026-02-15" }],
      } as never,
      toolCallContext(),
    )) as {
      proposalType?: string;
      draft?: { proposalId: string };
      points?: { date: string; balanceMinor: number }[];
    };

    expect(proposal.proposalType).toBe("balance_history_import");
    expect(proposal.points?.map((point) => point.date)).toEqual([
      "2025-12-15",
      "2026-01-15",
    ]);

    // And the document it records is the message, not the file the model named: a
    // write backed by a chat message may not wear a spreadsheet's name.
    const persisted = await store.assistantProposals.read(proposal.draft!.proposalId);
    expect(persisted?.documents.map((entry) => entry.document.name)).toEqual([
      "serie-escrita-en-el-chat",
    ]);
  });

  it("keeps the lane shut when the user typed no series (#1418)", async () => {
    const store = await workspaceStore();
    const ids = await publicIds(store);
    const tools = await toolsWithEvidence(store);

    const refused = (await tools["propose_balance_history_import"]?.execute?.(
      {
        liabilityId: ids["prestamo"],
        rows: [{ balanceMinor: 3_900_00, date: "2025-12-15" }],
      } as never,
      toolCallContext(),
    )) as { error?: string };

    expect(refused?.error).toBe("unvalidated_evidence");
  });

  /**
   * The disease of #1418, one level in: a person who wrote the series and whose paste
   * worthline could not read must get a DIFFERENT answer from silence — otherwise the
   * refusal asks him to do what he has just done.
   */
  it("says so when the user wrote a series it could not read (#1418)", async () => {
    const store = await workspaceStore();
    const ids = await publicIds(store);
    const tools = createChatTools({
      groundedHoldingIds: Object.values(ids),
      runWithStore: (run) =>
        run({
          agentView: store.agentView,
          assets: store.assets,
          assistantProposals: store.assistantProposals,
          liabilities: store.liabilities,
          workspace: store.workspace,
        }),
      asOf: AS_OF,
      typedBalanceSeries: { status: "unreadable" },
      unvalidatedEvidence: true,
    });

    for (const name of ["propose_balance_history_import", "propose_reconstruction"]) {
      const refused = (await tools[name]?.execute?.(
        {
          holdingId: ids["prestamo"],
          liabilityId: ids["prestamo"],
          rows: [{ balanceMinor: 3_900_00, date: "2025-12-15" }],
        } as never,
        toolCallContext(),
      )) as { error?: string; message?: string };

      expect(refused?.error, name).toBe("unreadable_typed_series");
      expect(refused?.message, name).toMatch(/he intentado leer/i);
    }
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

/**
 * «Hay un fondo a 0 €, elimínalo» resolves in ONE turn (uso real 2026-07-30).
 *
 * From a real free-tier transcript: the fund sorted last in the compact context and
 * fell outside its cut, no read took a name or a ticker, and the turn died with the
 * user pasting the exact symbol at an assistant that had nothing to do with it.
 */
describe("createChatTools · find_holdings and the connected-source frontier (uso real 2026-07-30)", () => {
  const SOLO = [{ memberId: "m", shareBps: 10_000 }];

  async function seedTinyWorkspace(): Promise<WorthlineStore> {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "m", name: "Titular" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "closed-fund",
      instrument: "fund",
      name: "Fondo Cerrado Global",
      ownership: SOLO,
      providerSymbol: "0P0000TEST.F",
    });
    return store;
  }

  function chatToolsOver(store: WorthlineStore) {
    return createChatTools({
      runWithStore: (run) =>
        run({
          agentView: store.agentView,
          assets: store.assets,
          assistantProposals: store.assistantProposals,
          liabilities: store.liabilities,
        }),
      asOf: AS_OF,
    });
  }

  it("looks up the 0 € fund by ticker and grounds the baja it enables", async () => {
    const store = await seedTinyWorkspace();
    const tools = chatToolsOver(store);

    const found = (await tools["find_holdings"]?.execute?.(
      { query: "0P0000TEST.F" },
      toolCallContext(),
    )) as { matches: Array<{ id: string; label: string; currentValue: string }> };

    expect(found.matches).toHaveLength(1);
    const match = found.matches[0]!;
    expect(match.label).toBe("Fondo Cerrado Global");
    expect(isPublicHoldingId(match.id)).toBe(true);
    // Money is formatted at the chat boundary like every other read (#629).
    expect(match.currentValue).toMatch(/€/);

    // Same turn: the id the lookup surfaced is grounded, so the baja goes through.
    const proposal = (await tools["propose_holding_removal"]?.execute?.(
      { holdingIds: [match.id] },
      toolCallContext(),
    )) as { error?: string; proposalType?: string };

    expect(proposal.error).toBeUndefined();
    expect(proposal.proposalType).toBe("holding_removal");
  });

  it("relays the sync-owned refusal instead of preparing a hand-declared value", async () => {
    const store = await seedTinyWorkspace();
    const { assetId } = await store.connectedSources.connect({
      adapter: "numista",
      credentialsJson: JSON.stringify({ apiKey: "test-key" }),
      label: "Colección de monedas",
      ownership: SOLO,
    });
    const tools = chatToolsOver(store);

    const found = (await tools["find_holdings"]?.execute?.(
      { query: "monedas" },
      toolCallContext(),
    )) as {
      matches: Array<{ id: string; connectedSource?: { adapter: string } }>;
    };
    const match = found.matches[0]!;
    expect(match.connectedSource?.adapter).toBe("numista");

    const refused = (await tools["propose_correction"]?.execute?.(
      {
        correction: { kind: "declare_value", valueMinor: 4_800_00 },
        holdingId: match.id,
      },
      toolCallContext(),
    )) as { error?: string };

    expect(refused.error).toContain("Colección de monedas");
    // And the sync's asset kept its derived value: nothing was anchored.
    expect(await store.assets.readValuationAnchors(assetId)).toHaveLength(0);
  });
});

/**
 * «Prepara una lista de todos los instrumentos con nombre, ISIN y participaciones»
 * resolves in ONE read (#1346).
 *
 * From a real transcript (2026-07-30 noche): the assistant opened
 * `get_holding_detail` fund by fund, did three of 24, gave up, and then stated that
 * «para el resto el ISIN no consta en el workspace» — 17 of those 24 had one. No row
 * carried an ISIN, a ticker, or units, and the chat's holdings cap was fixed at ten.
 */
describe("createChatTools · the instrument inventory in ONE read (#1346)", () => {
  const SOLO = [{ memberId: "m", shareBps: 10_000 }];

  async function seedTwelveFunds(): Promise<WorthlineStore> {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "m", name: "Titular" }],
      mode: "individual",
    });
    for (let index = 0; index < 12; index += 1) {
      await store.assets.createInvestmentAsset({
        currency: "EUR",
        id: `fund-${index}`,
        instrument: "fund",
        isin: `LU000000${index.toString().padStart(4, "0")}`,
        name: `Fondo ${index}`,
        ownership: SOLO,
        providerSymbol: `0P00000${index.toString().padStart(3, "0")}.F`,
      });
    }
    return store;
  }

  type ContextRows = {
    holdings: Array<{
      label: string;
      isin?: string;
      providerSymbol?: string;
      units?: string;
    }>;
    omittedHoldings: { count: number } | null;
  };

  it("carries the ISIN and the ticker on every row, and raises the cap on demand", async () => {
    const store = await seedTwelveFunds();
    const tools = toolsOver(store.agentView);

    const capped = (await tools["get_financial_context"]?.execute?.(
      {},
      toolCallContext(),
    )) as ContextRows;

    // The default stays cheap: ten rows, the rest counted, never silently dropped.
    expect(capped.holdings).toHaveLength(10);
    expect(capped.omittedHoldings?.count).toBe(2);
    expect(capped.holdings[0]?.isin).toMatch(/^LU00000000\d\d$/);
    expect(capped.holdings[0]?.providerSymbol).toMatch(/^0P00000\d\d\d\.F$/);

    // An enumeration question raises the cap instead of fanning out detail calls.
    const full = (await tools["get_financial_context"]?.execute?.(
      { holdingLimit: 100 },
      toolCallContext(),
    )) as ContextRows;

    expect(full.holdings).toHaveLength(12);
    expect(full.omittedHoldings).toBeNull();
    expect(full.holdings.every((holding) => holding.isin !== undefined)).toBe(true);
  });

  it(
    "carries the net units held on an investment row with a real ledger",
    async () => {
      const store = await seededStore();
      const tools = toolsOver(store.agentView);

      const context = (await tools["get_financial_context"]?.execute?.(
        { holdingLimit: 100 },
        toolCallContext(),
      )) as ContextRows;

      // The familia persona's indexed portfolio: 42 monthly buys of 3 units, minus a
      // 12-unit rebalance sale. The row says what is HELD, not what was bought.
      const etf = context.holdings.find(
        (holding) => holding.label === "Cartera indexada familiar",
      );
      expect(etf?.units).toBe("114");
      // A cash account has no ledger, so it says nothing about units.
      const cash = context.holdings.find(
        (holding) => holding.label === "Depósito a 12 meses",
      );
      expect(cash).toBeDefined();
      expect(cash && "units" in cash).toBe(false);
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
