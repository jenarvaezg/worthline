// The persistence escape hatch: seeding a live position needs `recordOperation`,
// which the narrowed application store does not expose.
import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import { describe, expect, test } from "vitest";

import type { ExtractedHoldingEvent } from "./attachment-extraction-contract";
import {
  confirmOperationProposalAction,
  discardOperationProposalAction,
} from "./operation-proposal-action";
import { buildOperationProposal } from "./operation-proposals";

/**
 * `propose_operation` end to end (#1374), on the real case that opened the issue: the
 * MyInvestor aportación confirmation of 05/08/2026 — 5,92 títulos a 21,12 €, 125,00 €,
 * comisión 0 — against a plan de pensiones that already holds 262,012 participaciones.
 * Confirming must leave the position at 267,932 and the ledger with exactly ONE more
 * operation, written by the operations engine with `source: agent`.
 */

/** es-ES puts a NBSP/narrow-NBSP before the symbol; compare in plain spaces. */
const NBSP = /[\u00a0\u202f]/g;

const TODAY = "2026-08-05";
const clock = { today: () => TODAY, now: () => `${TODAY}T09:00:00.000Z` };
const PLAN_ISIN = "ES0173516115";
const OWNERSHIP = [{ memberId: "m", shareBps: 10_000 }];

const APORTACION: ExtractedHoldingEvent = {
  amount: 125,
  currency: "EUR",
  date: TODAY,
  fees: { amount: 0, currency: "EUR" },
  isin: PLAN_ISIN,
  kind: "other",
  label: "APORTACION P.P. MYINVESTOR INDEXADO SP 500 PP",
  pricePerUnit: { amount: 21.12, currency: "EUR" },
  units: 5.92,
};

async function seedPortfolio(
  overrides: { isin?: string | undefined; units?: string } = {},
): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "plan-sp500",
    instrument: "pension_plan",
    name: "MyInvestor Indexado SP500",
    ownership: OWNERSHIP,
    ...(overrides.isin === undefined && "isin" in overrides
      ? {}
      : {
          securityId: {
            kind: "isin" as const,
            value: overrides.isin ?? PLAN_ISIN,
          },
        }),
  });
  await store.operations.recordOperation({
    assetId: "plan-sp500",
    currency: "EUR",
    executedAt: "2025-09-15",
    id: "op-seed",
    kind: "buy",
    pricePerUnit: "20",
    units: overrides.units ?? "262.012",
  });
  return store;
}

function storeFor(store: WorthlineStore) {
  return {
    agentView: store.agentView,
    assets: store.assets,
    assistantProposals: store.assistantProposals,
    operations: store.operations,
  };
}

async function draft(
  store: WorthlineStore,
  event: ExtractedHoldingEvent = APORTACION,
  kind: "buy" | "sell" | "contribution" = "contribution",
) {
  const built = await buildOperationProposal(
    storeFor(store),
    {
      assetId: "plan-sp500",
      kind,
      publicHoldingId: "wl_hld_plan",
      source: { event, from: "document" },
    },
    TODAY,
  );
  if (!built.ok) throw new Error(`build failed: ${built.error}`);
  return built.proposal;
}

describe("buildOperationProposal (#1374) · the card", () => {
  test("prints the document, the destination and the fact — and no invented value", async () => {
    const store = await seedPortfolio();

    const proposal = await draft(store);

    expect(proposal.proposalType).toBe("investment_operation");
    expect(proposal.document.line).toBe(
      `APORTACION P.P. MYINVESTOR INDEXADO SP 500 PP · ${PLAN_ISIN}`,
    );
    // The acceptance line of the issue (NBSP normalized for comparison).
    expect(proposal.document.fact.replace(NBSP, " ")).toBe(
      "05/08/2026 · aportación · 5,92 part. × 21,1149 € · comisión 0 € · 125 €",
    );
    // The destination is a SEPARATE line, so a jump of holding is visible (#1373).
    expect(proposal.holding.destination).toBe(
      `Anotar en «MyInvestor Indexado SP500» · ${PLAN_ISIN}`,
    );
    expect(proposal.position).toEqual({
      unitsAfter: "267,932",
      unitsBefore: "262,012",
    });
    expect(proposal.impact.deltaMinor).toBe(125_00);
    expect(proposal.impactCaption).toContain("estimado");
    expect(proposal.notes).toEqual([]);
    // Nowhere in the card is the position's current value: nobody had to fill it.
    //
    // El id del borrador queda FUERA de la comprobación: es un uuid, y uno de cada
    // ~4.300 uuids contiene «5387» por puro azar, así que dejarlo dentro convertía
    // esta línea en una lotería que fallaba sola de vez en cuando. Lo que la frase
    // quiere decir es «en la TARJETA no está el valor de la posición», y el id opaco
    // del borrador no es tarjeta: se comprueba aparte, que exista.
    const { draft: draftRef, ...card } = proposal;
    expect(draftRef.proposalId).toBeTruthy();
    expect(JSON.stringify(card)).not.toContain("5387");
    store.close();
  });

  test("persists the fact as ONE draft whose figures are the document's", async () => {
    const store = await seedPortfolio();

    const proposal = await draft(store);

    const persisted = await store.assistantProposals.read(proposal.draft.proposalId);
    expect(persisted?.kind).toBe("investment_operation");
    expect(persisted?.status).toBe("draft");
    const facts = persisted?.documents.flatMap((document) => document.facts) ?? [];
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      kind: "investment_operation",
      row: {
        amountMinor: 125_00,
        assetId: "plan-sp500",
        executedAt: TODAY,
        feesMinor: 0,
        isin: PLAN_ISIN,
        kind: "buy",
        units: "5.92",
      },
    });
    store.close();
  });
});

describe("buildOperationProposal (#1374) · the impact", () => {
  /**
   * The delta is what the LEDGER will value the operation at — participaciones ×
   * precio, i.e. the amount net of the commission — and not the gross figure the
   * document states. The fee is a cost, not position value: a gross delta would
   * overstate the change in net worth by exactly the commission.
   */
  test("counts the operation net of the commission, not the document's gross", async () => {
    const store = await seedPortfolio();

    const proposal = await draft(store, {
      ...APORTACION,
      amount: 1000,
      fees: { amount: 1.5, currency: "EUR" },
      pricePerUnit: undefined,
      units: 10,
    });

    expect(proposal.impact.deltaMinor).toBe(998_50);
    expect(proposal.impact.afterMinor).toBe(
      (proposal.impact.beforeMinor as number) + 998_50,
    );
    // And the document's own gross figure is still what the fact line prints.
    expect(proposal.document.fact.replace(NBSP, " ")).toContain("· 1000 €");
    store.close();
  });
});

describe("confirmOperationProposalAction (#1374) · the write", () => {
  test("writes exactly one agent operation and squares the position", async () => {
    const store = await seedPortfolio();
    const proposal = await draft(store);

    const result = await confirmOperationProposalAction(proposal.draft, store, clock);

    expect(result.status).toBe("applied");
    const operations = await store.operations.readOperations("plan-sp500");
    expect(operations).toHaveLength(2);
    const written = operations.find((operation) => operation.id !== "op-seed");
    expect(written).toMatchObject({
      currency: "EUR",
      kind: "buy",
      source: "agent",
      units: "5.92",
    });
    expect(written?.executedAt.slice(0, 10)).toBe(TODAY);
    // The price is derived so the cash amount is reproduced to the cent.
    expect(Math.round(Number(written?.units) * Number(written?.pricePerUnit) * 100)).toBe(
      125_00,
    );
    // A printed zero commission is «sin comisión»: the domain's own default.
    expect(written?.feesMinor ?? 0).toBe(0);
    expect((await store.assistantProposals.read(proposal.draft.proposalId))?.status).toBe(
      "applied",
    );
    store.close();
  });

  /**
   * The acceptance figure of the issue: «el ripple deja la posición cuadrada (para
   * este caso: 267,932 part. y 5.508,68 €)». With the plan's participación priced at
   * 20,56 €, 267,932 × 20,56 € is exactly that — so this pins the whole chain, not
   * just the ledger row: the operation lands, the ripple runs, and the live position
   * reads the units and the value the user was promised.
   */
  test("the ripple leaves the position squared: 267,932 part. and 5.508,68 €", async () => {
    const store = await seedPortfolio();
    await store.operations.upsertPrice({
      assetId: "plan-sp500",
      currency: "EUR",
      fetchedAt: `${TODAY}T08:00:00.000Z`,
      freshnessState: "fresh",
      price: "20.56",
      source: "manual",
    });
    const proposal = await draft(store);

    expect(await confirmOperationProposalAction(proposal.draft, store, clock)).toEqual({
      status: "applied",
    });

    const position = (await store.snapshots.readPositions()).find(
      (row) => row.assetId === "plan-sp500",
    );
    expect(position?.currentUnits).toBe("267.932");
    expect(position?.marketValue?.amountMinor).toBe(5_508_68);
    store.close();
  });

  test("a sale carries the opposite sign and takes the participaciones out", async () => {
    const store = await seedPortfolio();
    const proposal = await draft(
      store,
      { ...APORTACION, kind: "withdrawal", label: "VENTA PARCIAL" },
      "sell",
    );

    expect(proposal.impact.deltaMinor).toBe(-125_00);
    expect(proposal.position).toEqual({
      unitsAfter: "256,092",
      unitsBefore: "262,012",
    });
    expect(await confirmOperationProposalAction(proposal.draft, store, clock)).toEqual({
      status: "applied",
    });
    const written = (await store.operations.readOperations("plan-sp500")).find(
      (operation) => operation.id !== "op-seed",
    );
    expect(written?.kind).toBe("sell");
    store.close();
  });

  test("discarding writes nothing and resolves the draft", async () => {
    const store = await seedPortfolio();
    const proposal = await draft(store);

    const result = await discardOperationProposalAction(proposal.draft, store, clock);

    expect(result).toEqual({ status: "discarded" });
    expect(await store.operations.readOperations("plan-sp500")).toHaveLength(1);
    expect((await store.assistantProposals.read(proposal.draft.proposalId))?.status).toBe(
      "discarded",
    );
    // And a second confirm on a resolved draft is refused, never re-applied.
    const again = await confirmOperationProposalAction(proposal.draft, store, clock);
    expect(again.status).toBe("error");
    expect(await store.operations.readOperations("plan-sp500")).toHaveLength(1);
    store.close();
  });

  test("re-uploading the same receipt does not double the position", async () => {
    const store = await seedPortfolio();
    const first = await draft(store);
    expect(await confirmOperationProposalAction(first.draft, store, clock)).toEqual({
      status: "applied",
    });

    const built = await buildOperationProposal(
      storeFor(store),
      {
        assetId: "plan-sp500",
        source: { event: APORTACION, from: "document" },
        kind: "contribution",
        publicHoldingId: "wl_hld_plan",
      },
      TODAY,
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("ya está anotada");
    expect(await store.operations.readOperations("plan-sp500")).toHaveLength(2);
    store.close();
  });

  /**
   * And the guard compares through the DECIMAL SEAM, not as strings: the ledger stores
   * whatever the writer normalized, so «5,920» and «5,92» are one quantity. A string
   * compare here would let the second upload of one receipt double the position.
   */
  test("catches the duplicate even when the stored quantity reads differently", async () => {
    const store = await seedPortfolio();
    await store.operations.recordOperation({
      assetId: "plan-sp500",
      currency: "EUR",
      executedAt: TODAY,
      id: "op-manual",
      kind: "buy",
      pricePerUnit: "21.114864864864864865",
      units: "5.920",
    });

    const built = await buildOperationProposal(
      storeFor(store),
      {
        assetId: "plan-sp500",
        source: { event: APORTACION, from: "document" },
        kind: "contribution",
        publicHoldingId: "wl_hld_plan",
      },
      TODAY,
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("ya está anotada");
    store.close();
  });
});

describe("buildOperationProposal (#1374) · the frontiers", () => {
  test("refuses a holding a connected source materializes", async () => {
    const store = await seedPortfolio();
    const built = await buildOperationProposal(
      {
        ...storeFor(store),
        agentView: {
          ...store.agentView,
          readConnectedSources: async () => [
            {
              adapter: "binance" as const,
              assetIds: ["plan-sp500"],
              id: "src-1",
              label: "Binance",
            },
          ],
        } as unknown as WorthlineStore["agentView"],
      },
      {
        assetId: "plan-sp500",
        source: { event: APORTACION, from: "document" },
        kind: "contribution",
        publicHoldingId: "wl_hld_plan",
      },
      TODAY,
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("fuente conectada");
    expect(built.error).toContain("/ajustes/conexiones");
    store.close();
  });

  /**
   * The refusal must not MISDIAGNOSE: the read that answers this is a list of
   * investments, so «no existe» and «existe pero es una cuenta» arrive identically.
   * It names both ways out instead of asserting which one happened.
   */
  test("refuses a holding that does not exist as an investment", async () => {
    const store = await seedPortfolio();
    const built = await buildOperationProposal(
      storeFor(store),
      {
        assetId: "no-existe",
        source: { event: APORTACION, from: "document" },
        kind: "contribution",
        publicHoldingId: "wl_hld_fantasma",
      },
      TODAY,
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("o no existe, o es de otra familia");
    expect(built.error).toContain("dala de alta");
    expect(built.error).not.toContain("Esa posición no es una inversión");
    store.close();
  });

  /**
   * The document's ISIN contradicting the holding's is the wrong-holding jump this
   * lane exists to make visible — here it is refused outright, because the paper is
   * about a different instrument (#1331/#1366's lesson).
   */
  test("refuses a document whose ISIN contradicts the holding's", async () => {
    const store = await seedPortfolio({ isin: "IE00B03HCZ61" });

    const built = await buildOperationProposal(
      storeFor(store),
      {
        assetId: "plan-sp500",
        source: { event: APORTACION, from: "document" },
        kind: "contribution",
        publicHoldingId: "wl_hld_plan",
      },
      TODAY,
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain(PLAN_ISIN);
    expect(built.error).toContain("IE00B03HCZ61");
    store.close();
  });

  test("accepts a holding with no ISIN registered: nothing to contradict", async () => {
    const store = await seedPortfolio({ isin: undefined });

    const proposal = await draft(store);

    expect(proposal.holding.destination).toBe("Anotar en «MyInvestor Indexado SP500»");
    store.close();
  });

  test("refuses a sale that would leave the position in negative", async () => {
    const store = await seedPortfolio({ units: "2" });

    const built = await buildOperationProposal(
      storeFor(store),
      {
        assetId: "plan-sp500",
        source: { event: { ...APORTACION, kind: "withdrawal" }, from: "document" },
        kind: "sell",
        publicHoldingId: "wl_hld_plan",
      },
      TODAY,
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("negativo");
    store.close();
  });

  test("refuses a document in another currency than the holding", async () => {
    const store = await seedPortfolio();

    const built = await buildOperationProposal(
      storeFor(store),
      {
        assetId: "plan-sp500",
        source: {
          event: {
            ...APORTACION,
            currency: "USD",
            fees: { amount: 0, currency: "USD" },
            pricePerUnit: { amount: 21.12, currency: "USD" },
          },
          from: "document",
        },
        kind: "contribution",
        publicHoldingId: "wl_hld_plan",
      },
      TODAY,
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("no convierto divisas");
    store.close();
  });

  test("refuses a receipt dated in the future", async () => {
    const store = await seedPortfolio();

    const built = await buildOperationProposal(
      storeFor(store),
      {
        assetId: "plan-sp500",
        source: { event: { ...APORTACION, date: "2026-09-01" }, from: "document" },
        kind: "contribution",
        publicHoldingId: "wl_hld_plan",
      },
      TODAY,
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("fecha futura");
    store.close();
  });
});

describe("buildOperationProposal (#1374) · a document with no participaciones", () => {
  test("derives them from the printed price and says so on the card", async () => {
    const store = await seedPortfolio();

    const proposal = await draft(store, { ...APORTACION, units: undefined });

    expect(proposal.notes[0]).toContain("no dice las participaciones");
    expect(proposal.document.fact.replace(NBSP, " ")).toContain(
      "5,918561 part. × 21,12 €",
    );
    expect(await confirmOperationProposalAction(proposal.draft, store, clock)).toEqual({
      status: "applied",
    });
    const written = (await store.operations.readOperations("plan-sp500")).find(
      (operation) => operation.id !== "op-seed",
    );
    // The amount stays exact: no quantity was invented to make it fit.
    expect(Math.round(Number(written?.units) * Number(written?.pricePerUnit) * 100)).toBe(
      125_00,
    );
    store.close();
  });
});
