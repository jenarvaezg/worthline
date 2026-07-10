import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { derivePosition } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  buildStatementImportProposal,
  parseStatementImportProposalDraft,
} from "./statement-import-proposals";

const PLANTILLA_CSV = [
  "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre",
  "05/01/2024;Fondo;ES00WL000001;Compra;34,2857;1200;;",
  "05/02/2024;Fondo;ES00WL000001;Compra;33,9120;1200;;",
  "10/01/2024;Fondo;LU00WL000002;Compra;12,3456;600;;",
].join("\r\n");

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

describe("parseStatementImportProposalDraft", () => {
  test("accepts a valid plantilla draft", () => {
    const parsed = parseStatementImportProposalDraft({
      broker: "plantilla",
      rawText: PLANTILLA_CSV,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.draft.broker).toBe("plantilla");
    expect(parsed.draft.rawText).toBe(PLANTILLA_CSV);
  });

  test("rejects malformed broker or empty text", () => {
    expect(
      parseStatementImportProposalDraft({ broker: "nope", rawText: PLANTILLA_CSV }).ok,
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

    const built = await buildStatementImportProposal(store.agentView, {
      broker: "plantilla",
      rawText: PLANTILLA_CSV,
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.proposal.proposalType).toBe("statement_import");
    expect(built.proposal.funds).toHaveLength(2);
    expect(built.proposal.funds[0]?.bucket).toBe("matched");
    expect(built.proposal.funds[1]?.bucket).toBe("new");
    expect(built.proposal.funds[0]?.positionImpact.afterUnits).not.toBe("0");
  });
});

describe("confirmStatementImportProposalAction regression", () => {
  test("agent confirm matches manual import position for the same CSV", async () => {
    const { confirmStatementImportProposalAction } = await import(
      "./statement-import-proposal-action"
    );
    const store = await createInMemoryStore();
    await seedMatchedFund(store);

    const result = await confirmStatementImportProposalAction(
      { broker: "plantilla", rawText: PLANTILLA_CSV },
      store,
    );

    expect(result).toEqual({ created: 1, included: 2, status: "applied" });

    const matchedOps = await store.operations.readOperations("matched_fund");
    const newAsset = (await store.assets.readInvestmentAssetsWithMeta()).find(
      (asset) => asset.isin === "LU00WL000002",
    );
    expect(newAsset).toBeDefined();
    const newOps = await store.operations.readOperations(newAsset!.id);

    const matchedPosition = derivePosition(matchedOps, {
      assetId: "matched_fund",
      currency: "EUR",
      currentPricePerUnit: "35",
    });
    const newPosition = derivePosition(newOps, {
      assetId: newAsset!.id,
      currency: "EUR",
      ...(newOps.at(-1)?.pricePerUnit
        ? { currentPricePerUnit: newOps.at(-1)!.pricePerUnit }
        : {}),
    });

    expect(matchedPosition.currentUnits).toBe("68.1977");
    expect(newPosition.currentUnits).toBe("12.3456");
    expect(matchedOps.every((op) => op.source === "agent")).toBe(true);
    expect(newOps.every((op) => op.source === "agent")).toBe(true);
  });
});
