import { createInMemoryStore } from "@worthline/db";
import { describe, expect, test, vi } from "vitest";

import { confirmMixedDocumentProposalAction } from "./mixed-document-proposal-action";
import { buildMixedDocumentProposal } from "./mixed-document-proposals";

const SHA = "a".repeat(64);

describe("mixed document proposal router", () => {
  test("asks for clarification instead of guessing a doubtful segment", async () => {
    const create = vi.fn();
    const result = await buildMixedDocumentProposal(
      { assistantProposals: { create } } as never,
      {
        documentName: "mezcla.xlsx",
        documentSha256: SHA,
        segments: [{ confidence: "uncertain", kind: "property_valuation" }],
      },
      "2026-07-12",
    );

    expect(result).toEqual({
      ok: false,
      error:
        "El segmento 1 tiene una clasificación dudosa. Pregunta al usuario antes de proponer cambios.",
    });
    expect(create).not.toHaveBeenCalled();
  });

  test("routes typed sections into one durable mixed proposal", async () => {
    const appendDocument = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue({ id: "proposal-1" });
    const result = await buildMixedDocumentProposal(
      {
        assets: {
          readAnnualAppreciationRate: vi.fn().mockResolvedValue(null),
          readAssets: vi.fn().mockResolvedValue([
            {
              currentValue: { amountMinor: 300_000_00, currency: "EUR" },
              id: "home-1",
              name: "Vivienda",
              type: "real_estate",
            },
          ]),
          readValuationAnchors: vi.fn().mockResolvedValue([]),
        },
        assistantProposals: { appendDocument, create },
      } as never,
      {
        documentName: "mezcla.xlsx",
        documentSha256: SHA,
        segments: [
          {
            assetId: "home-1",
            confidence: "certain",
            kind: "property_valuation",
            valuationDate: "2024-01-01",
            valueMinor: 250_000_00,
          },
        ],
      },
      "2026-07-12",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.draft.proposalId).toBe("proposal-1");
      expect(result.proposal.sections).toEqual([
        expect.objectContaining({ assetKey: "home-1", kind: "property_valuation" }),
      ]);
    }
    expect(create).toHaveBeenCalledWith({ kind: "mixed_document_import" });
    expect(appendDocument).toHaveBeenCalledWith(
      "proposal-1",
      expect.objectContaining({
        facts: [
          {
            kind: "property_valuation_anchor",
            row: {
              assetId: "home-1",
              valuationDate: "2024-01-01",
              valueMinor: 250_000_00,
            },
          },
        ],
      }),
    );
  });

  test("groups investment segments by fund and returns one mixed proposal with per-asset trust", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "m", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      isin: "ES00WL000001",
      liquidityTier: "market",
      manualPricePerUnit: "10",
      name: "Fondo",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 300_000_00,
      id: "home",
      liquidityTier: "housing",
      name: "Casa",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
      type: "real_estate",
    });
    await store.liabilities.createLiability({
      balanceMinor: 140_000_00,
      currency: "EUR",
      id: "mortgage",
      name: "Hipoteca",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
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
      { today: "2026-07-12" },
    );
    const header =
      "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre";
    const result = await buildMixedDocumentProposal(
      store,
      {
        documentName: "mezcla.xlsx",
        documentSha256: SHA,
        segments: [
          {
            broker: "plantilla",
            confidence: "certain",
            kind: "investment_statement",
            rawText: `${header}\r\n05/01/2024;Fondo;ES00WL000001;Compra;2;20;;Fondo`,
          },
          {
            broker: "plantilla",
            confidence: "certain",
            kind: "investment_statement",
            rawText: `${header}\r\n05/02/2024;Fondo;ES00WL000001;Compra;3;30;;Fondo`,
          },
          {
            confidence: "certain",
            kind: "debt_balance_history",
            liabilityId: "mortgage",
            rows: [{ balanceMinor: 140_000_00, date: "2026-07-12" }],
          },
          {
            confidence: "certain",
            kind: "debt_balance_history",
            liabilityId: "mortgage",
            rows: [{ balanceMinor: 139_000_00, date: "2026-08-12" }],
          },
          {
            assetId: "home",
            confidence: "certain",
            kind: "property_valuation",
            valuationDate: "2024-01-01",
            valueMinor: 250_000_00,
          },
          {
            assetId: "home",
            confidence: "certain",
            kind: "property_valuation",
            valuationDate: "2025-01-01",
            valueMinor: 275_000_00,
          },
        ],
      },
      "2026-07-12",
      async () => ({ status: "not_found" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.sections).toHaveLength(3);
    const investment = result.proposal.sections.find(
      (section) => section.kind === "investment_statement",
    );
    expect(
      investment?.kind === "investment_statement" && investment.preview.funds,
    ).toHaveLength(1);
    if (investment?.kind === "investment_statement") {
      expect(investment.preview.funds[0]).toMatchObject({
        executedCount: 2,
        positionImpact: { beforeUnits: "0", afterUnits: "5" },
      });
    }
    const debt = result.proposal.sections.find(
      (section) => section.kind === "debt_balance_history",
    );
    expect(debt?.kind === "debt_balance_history" && debt.preview.points).toHaveLength(2);
    const property = result.proposal.sections.find(
      (section) => section.kind === "property_valuation",
    );
    expect(
      property?.kind === "property_valuation" && property.preview.anchors,
    ).toHaveLength(2);
    expect(result.proposal.sections.map((section) => section.preview.trust.tier)).toEqual(
      ["reconciled", "reconciled", "unverified"],
    );
    const persisted = await store.assistantProposals.read(
      result.proposal.draft.proposalId,
    );
    expect(persisted?.documents).toHaveLength(1);
    expect(persisted?.documents[0]?.facts).toHaveLength(6);

    await store.liabilities.updateLiabilityBalance("mortgage", 130_000_00);
    const staleConfirm = await confirmMixedDocumentProposalAction(
      result.proposal.draft,
      store,
      { today: () => "2026-07-12" },
    );
    expect(staleConfirm).toEqual({
      message: "Una deuda ya no reconcilia con su saldo actual.",
      status: "error",
    });
    expect(await store.operations.readOperations("fund")).toEqual([]);
    expect(await store.assets.readValuationAnchors("home")).toEqual([]);
    expect(
      await store.assistantProposals.read(result.proposal.draft.proposalId),
    ).toMatchObject({
      status: "draft",
    });
    await store.liabilities.updateLiabilityBalance("mortgage", 140_000_00);

    const apply = {
      funds: [
        {
          assetId: "fund",
          creates: [
            {
              assetId: "fund",
              currency: "EUR" as const,
              executedAt: "2024-01-05",
              feesMinor: 0,
              id: "mixed_op",
              kind: "buy" as const,
              pricePerUnit: "10",
              source: "agent" as const,
              units: "2",
            },
          ],
          kind: "matched" as const,
          overwrites: [],
        },
      ],
      proposalId: result.proposal.draft.proposalId,
      today: "2026-07-12",
    };
    await expect(
      store.command.applyAssistantMixedProposal({
        ...apply,
        propertyValuations: [
          {
            adjustsPriorCurve: true,
            assetId: "missing-home",
            id: "bad-anchor",
            source: "agent",
            valuationDate: "2024-01-01",
            valueMinor: 250_000_00,
          },
        ],
      }),
    ).rejects.toThrow();
    expect(await store.operations.readOperations("fund")).toEqual([]);
    expect(await store.assistantProposals.read(apply.proposalId)).toMatchObject({
      status: "draft",
    });

    await store.command.applyAssistantMixedProposal({
      ...apply,
      propertyValuations: [
        {
          adjustsPriorCurve: true,
          assetId: "home",
          id: "good-anchor",
          source: "agent",
          valuationDate: "2024-01-01",
          valueMinor: 250_000_00,
        },
      ],
    });
    expect(await store.operations.readOperations("fund")).toMatchObject([
      { id: "mixed_op", source: "agent" },
    ]);
    expect(await store.assets.readValuationAnchors("home")).toMatchObject([
      { id: "good-anchor", source: "agent" },
    ]);
    expect(await store.assistantProposals.read(apply.proposalId)).toMatchObject({
      status: "applied",
    });
    store.close();
  });
});
