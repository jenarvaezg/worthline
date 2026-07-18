import {
  confirmImportStatementAction,
  type IsinLookupResult,
  type IsinSymbolResolver,
  previewImportStatementAction,
} from "@web/patrimonio/importar-extracto/actions";
import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { asInstant, derivePosition } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  buildStatementImportProposal,
  parseStatementImportProposalDraft,
} from "./statement-import-proposals";

const IDLE = { status: "idle" as const };

const MULTI_ISIN_CSV = [
  "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre",
  "05/01/2024;Fondo;ES00WL000001;Compra;34,2857;1200;;",
  "05/02/2024;Fondo;ES00WL000001;Compra;33,9120;1200;;",
  "10/01/2024;Fondo;LU00WL000002;Compra;12,3456;600;;",
  "10/02/2024;Fondo;LU00WL000002;Compra;12,4011;600;;",
  "15/01/2024;Fondo;IE00WL000003;Compra;21,0000;900;;",
  "15/02/2024;Fondo;IE00WL000003;Compra;20,7500;900;;",
  "20/01/2024;Fondo;FR00WL000004;Compra;6,0000;300;;",
].join("\r\n");

const RESOLVER_RESULTS: Record<string, IsinLookupResult> = {
  LU00WL000002: {
    name: "Fondo Brújula",
    provider: "yahoo",
    status: "found",
    symbol: "BRUJULA.FAKE",
  },
  IE00WL000003: { status: "not_found" },
  FR00WL000004: { status: "not_found" },
};

function fakeResolver(results: Record<string, IsinLookupResult>): IsinSymbolResolver {
  return async (isin) => results[isin] ?? { status: "not_found" };
}

const TEST_RESOLVER = fakeResolver(RESOLVER_RESULTS);

async function seedMatchedFund(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "matched_fund",
    isin: "ES00WL000001",
    liquidityTier: "market",
    manualPricePerUnit: "35",
    name: "Fondo existente",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });
}

function uploadForm(csv = MULTI_ISIN_CSV): FormData {
  const fd = new FormData();
  fd.set("broker", "plantilla");
  fd.set("currentUrl", "/patrimonio/importar-extracto");
  fd.set("file", new File([csv], "plantilla.csv", { type: "text/csv" }));
  return fd;
}

async function confirmManual(store: WorthlineStore, fd: FormData): Promise<void> {
  try {
    await confirmImportStatementAction(fd, store);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message !== "NEXT_REDIRECT") throw err;
  }
}

async function unitsByIsin(store: WorthlineStore): Promise<Map<string, string>> {
  const metas = await store.assets.readInvestmentAssetsWithMeta();
  const out = new Map<string, string>();

  for (const meta of metas) {
    const key = meta.isin ?? meta.id;
    const ops = await store.operations.readOperations(meta.id);
    const position = derivePosition(ops, {
      assetId: meta.id,
      currency: "EUR",
      ...(ops.at(-1)?.pricePerUnit
        ? { currentPricePerUnit: ops.at(-1)!.pricePerUnit }
        : {}),
    });
    out.set(key, position.currentUnits);
  }

  return out;
}

describe("parseStatementImportProposalDraft", () => {
  test("accepts only a persisted proposal reference", () => {
    const parsed = parseStatementImportProposalDraft({ proposalId: "proposal_123" });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.draft).toEqual({ proposalId: "proposal_123" });
  });

  test("rejects a missing id and never accepts raw document text", () => {
    expect(parseStatementImportProposalDraft({}).ok).toBe(false);
    expect(parseStatementImportProposalDraft({ proposalId: " " }).ok).toBe(false);
    expect(parseStatementImportProposalDraft({ rawText: MULTI_ISIN_CSV }).ok).toBe(false);
  });
});

describe("buildStatementImportProposal", () => {
  test("persists typed facts and a document reference, never the raw document", async () => {
    const store = await createInMemoryStore();
    await seedMatchedFund(store);

    const built = await buildStatementImportProposal(
      store,
      {
        broker: "plantilla",
        documentName: "enero.csv",
        rawText: MULTI_ISIN_CSV,
      },
      TEST_RESOLVER,
    );

    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.proposal.proposalType).toBe("statement_import");
    expect(built.proposal.draft.proposalId).toEqual(expect.any(String));
    expect(built.proposal.funds).toHaveLength(4);
    expect(built.proposal.funds[0]?.bucket).toBe("matched");
    expect(built.proposal.funds[1]?.bucket).toBe("new");
    const newFund = built.proposal.funds[1];
    if (newFund?.bucket === "new") {
      expect(newFund.suggestedSymbol).toBe("BRUJULA.FAKE");
    }

    expect(JSON.stringify(built.proposal)).not.toContain("rawText");
    expect(JSON.stringify(built.proposal)).not.toContain("Fecha;Tipo de activo");
    const persisted = await store.assistantProposals.read(
      built.proposal.draft.proposalId,
    );
    expect(persisted).toMatchObject({
      status: "draft",
      documents: [
        {
          document: {
            name: "enero.csv",
            provenance: "agent",
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      ],
    });
    expect(JSON.stringify(persisted)).not.toContain("Fecha;Tipo de activo");
  });

  test("a second document accumulates typed facts in the same proposal", async () => {
    const store = await createInMemoryStore();
    await seedMatchedFund(store);

    const first = await buildStatementImportProposal(
      store,
      {
        broker: "plantilla",
        documentName: "enero.csv",
        rawText: MULTI_ISIN_CSV,
      },
      TEST_RESOLVER,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const secondCsv = [
      "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre",
      "10/03/2024;Fondo;LU00WL000002;Compra;10,0000;500;;",
    ].join("\r\n");
    const second = await buildStatementImportProposal(
      store,
      {
        broker: "plantilla",
        documentName: "marzo.csv",
        proposalId: first.proposal.draft.proposalId,
        rawText: secondCsv,
      },
      TEST_RESOLVER,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.proposal.draft).toEqual(first.proposal.draft);
    expect(
      second.proposal.funds.find((fund) => fund.isin === "LU00WL000002")?.executedCount,
    ).toBe(3);
    expect(
      (await store.assistantProposals.read(first.proposal.draft.proposalId))?.documents,
    ).toHaveLength(2);
  });
});

describe("confirmStatementImportProposalAction regression", () => {
  test("persists the source instant carried by a proposed statement row", async () => {
    const { confirmStatementImportProposalAction } = await import(
      "./statement-import-proposal-action"
    );
    const store = await createInMemoryStore();
    await seedMatchedFund(store);
    const proposal = await store.assistantProposals.create({ kind: "statement_import" });
    await store.assistantProposals.appendDocument(proposal.id, {
      document: {
        name: "timed.csv",
        provenance: "agent",
        sha256: "8".repeat(64),
      },
      facts: [
        {
          currency: "EUR",
          dateKey: "2024-04-10",
          feesMinor: 0,
          isin: "ES00WL000001",
          kind: "buy",
          occurredAt: asInstant("2024-04-10T11:25:00.000Z"),
          pricePerUnit: "10",
          units: "2",
        },
      ],
    });

    expect(
      await confirmStatementImportProposalAction({ proposalId: proposal.id }, store),
    ).toEqual({ created: 0, included: 1, status: "applied" });
    expect(await store.operations.readOperations("matched_fund")).toMatchObject([
      { occurredAt: "2024-04-10T11:25:00.000Z" },
    ]);
  });

  test("agent confirm matches manual import positions for the same CSV and resolver", async () => {
    const { confirmStatementImportProposalAction } = await import(
      "./statement-import-proposal-action"
    );

    const manualStore = await createInMemoryStore();
    const agentStore = await createInMemoryStore();
    await seedMatchedFund(manualStore);
    await seedMatchedFund(agentStore);

    const manualFd = uploadForm();
    for (const isin of ["ES00WL000001", "LU00WL000002", "IE00WL000003", "FR00WL000004"]) {
      manualFd.set(`include_${isin}`, "on");
    }
    manualFd.set("name_LU00WL000002", "Fondo Brújula");
    manualFd.set("symbol_LU00WL000002", "BRUJULA.FAKE");

    await previewImportStatementAction(IDLE, manualFd, manualStore, TEST_RESOLVER);
    await confirmManual(manualStore, manualFd);

    const built = await buildStatementImportProposal(
      agentStore,
      {
        broker: "plantilla",
        documentName: "plantilla.csv",
        rawText: MULTI_ISIN_CSV,
      },
      TEST_RESOLVER,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const result = await confirmStatementImportProposalAction(
      built.proposal.draft,
      agentStore,
      TEST_RESOLVER,
    );
    expect(result).toEqual({ created: 3, included: 4, status: "applied" });

    expect(await unitsByIsin(manualStore)).toEqual(await unitsByIsin(agentStore));

    const brujula = (await agentStore.assets.readInvestmentAssetsWithMeta()).find(
      (asset) => asset.isin === "LU00WL000002",
    );
    expect(brujula?.providerSymbol).toBe("BRUJULA.FAKE");

    const agentOps = await agentStore.operations.readOperations("matched_fund");
    expect(agentOps.every((op) => op.source === "agent")).toBe(true);
    expect(
      await agentStore.assistantProposals.read(built.proposal.draft.proposalId),
    ).toMatchObject({ status: "applied" });
  });

  test("confirm re-derives matching from live positions instead of the saved preview", async () => {
    const { confirmStatementImportProposalAction } = await import(
      "./statement-import-proposal-action"
    );
    const store = await createInMemoryStore();
    await seedMatchedFund(store);

    const csv = [
      "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre",
      "10/01/2024;Fondo;LU00WL000002;Compra;12,0000;600;;",
    ].join("\r\n");
    const built = await buildStatementImportProposal(
      store,
      { broker: "plantilla", documentName: "nuevo.csv", rawText: csv },
      TEST_RESOLVER,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.funds[0]?.bucket).toBe("new");

    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "created_after_preview",
      isin: "LU00WL000002",
      liquidityTier: "market",
      name: "Creado tras preview",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });

    expect(
      await confirmStatementImportProposalAction(
        built.proposal.draft,
        store,
        TEST_RESOLVER,
      ),
    ).toEqual({ created: 0, included: 1, status: "applied" });
    expect(await store.operations.readOperations("created_after_preview")).toHaveLength(
      1,
    );
  });
});

describe("discardStatementImportProposalAction", () => {
  test("persists discard and prevents a later confirmation", async () => {
    const { confirmStatementImportProposalAction, discardStatementImportProposalAction } =
      await import("./statement-import-proposal-action");
    const store = await createInMemoryStore();
    await seedMatchedFund(store);
    const built = await buildStatementImportProposal(
      store,
      {
        broker: "plantilla",
        documentName: "descartar.csv",
        rawText: MULTI_ISIN_CSV,
      },
      TEST_RESOLVER,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(
      await discardStatementImportProposalAction(built.proposal.draft, store),
    ).toEqual({ status: "discarded" });
    expect(
      await store.assistantProposals.read(built.proposal.draft.proposalId),
    ).toMatchObject({ status: "discarded" });
    expect(
      await confirmStatementImportProposalAction(
        built.proposal.draft,
        store,
        TEST_RESOLVER,
      ),
    ).toEqual({ status: "error", message: "La propuesta ya no está disponible." });
  });
});
