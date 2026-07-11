import {
  confirmImportStatementAction,
  type IsinLookupResult,
  type IsinSymbolResolver,
  previewImportStatementAction,
} from "@web/patrimonio/importar-extracto/actions";
import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { derivePosition } from "@worthline/domain";
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
  test("accepts a valid plantilla draft", () => {
    const parsed = parseStatementImportProposalDraft({
      broker: "plantilla",
      rawText: MULTI_ISIN_CSV,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.draft.broker).toBe("plantilla");
    expect(parsed.draft.rawText).toBe(MULTI_ISIN_CSV);
  });

  test("rejects malformed broker or empty text", () => {
    expect(
      parseStatementImportProposalDraft({ broker: "nope", rawText: MULTI_ISIN_CSV }).ok,
    ).toBe(false);
    expect(
      parseStatementImportProposalDraft({ broker: "plantilla", rawText: " " }).ok,
    ).toBe(false);
  });
});

describe("buildStatementImportProposal", () => {
  test("builds matched/new preview rows without writing", async () => {
    const store = await createInMemoryStore();
    await seedMatchedFund(store);

    const built = await buildStatementImportProposal(
      store.agentView,
      { broker: "plantilla", rawText: MULTI_ISIN_CSV },
      TEST_RESOLVER,
    );

    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.proposal.proposalType).toBe("statement_import");
    expect(built.proposal.funds).toHaveLength(4);
    expect(built.proposal.funds[0]?.bucket).toBe("matched");
    expect(built.proposal.funds[1]?.bucket).toBe("new");
    const newFund = built.proposal.funds[1];
    if (newFund?.bucket === "new") {
      expect(newFund.suggestedSymbol).toBe("BRUJULA.FAKE");
    }
  });
});

describe("confirmStatementImportProposalAction regression", () => {
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
      agentStore.agentView,
      { broker: "plantilla", rawText: MULTI_ISIN_CSV },
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
  });
});
