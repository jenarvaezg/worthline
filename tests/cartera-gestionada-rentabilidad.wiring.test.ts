/**
 * The return of a managed portfolio, from the store to the ficha's block (#1552).
 *
 * Why this suite exists. The figure the owner carea against his manager's app
 * («+11,32 %») crosses three seams before it is printed: the operations the store
 * keeps, the loader that pairs them with the members' values and their frozen
 * monthly closes, and the shared engine that aggregates the subset. Each of the
 * three is tested apart; what this one holds is that the seam between them says
 * what the manager's app says — the cash out of the rate, and a traspaso between
 * two members counted as the internal move it is, not as fresh capital.
 *
 * Real in-memory store, no network (an all-EUR book pays no FX call).
 */

import { portfolioWitnessView } from "@web/patrimonio/carteras/carteras-view";
import { loadCarteras } from "@web/patrimonio/carteras/load-carteras";
import { loadPortfolioReturns } from "@web/patrimonio/carteras/load-portfolio-returns";
import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { afterEach, describe, expect, test } from "vitest";

const MEMBER_ID = "member_yo";
const SCOPE_ID = "household";
const FUND_A = "asset_fondo_a";
const FUND_B = "asset_fondo_b";
const TODAY = "2026-08-21";

let store: WorthlineStore;

afterEach(() => {
  store?.close();
});

async function setup(): Promise<WorthlineStore> {
  store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Yo" }],
    mode: "individual",
  });

  for (const [id, name, price] of [
    [FUND_A, "Fondo A", "12"],
    [FUND_B, "Fondo B", "11"],
  ] as const) {
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id,
      liquidityTier: "market",
      manualPricePerUnit: price,
      name,
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    });
  }

  // 1.000 € en el fondo A, año y medio antes de hoy.
  await store.command.recordInvestmentOperation(
    {
      assetId: FUND_A,
      currency: "EUR",
      executedAt: "2025-01-10",
      feesMinor: 0,
      id: "op_compra_a",
      kind: "buy",
      pricePerUnit: "10",
      units: "100",
    },
    { today: TODAY },
  );

  return store;
}

async function returnsOf(portfolioId: string) {
  const model = await loadCarteras({
    baseCurrency: "EUR",
    scopeId: SCOPE_ID,
    store,
    today: TODAY,
  });
  const portfolio = model.allPortfolios.find(
    (candidate) => candidate.id === portfolioId,
  )!;
  return {
    model,
    portfolio,
    returns: await loadPortfolioReturns({
      baseCurrency: "EUR",
      model,
      portfolio,
      store,
      today: TODAY,
    }),
  };
}

describe("la rentabilidad de una cartera gestionada", () => {
  test("mide los fondos y deja el efectivo del contenedor fuera del retorno", async () => {
    await setup();
    const created = await store.managedPortfolios.createManagedPortfolio({
      containerOwnership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
      memberHoldingIds: [FUND_A],
      name: "Cartera Indexada Metal",
      provider: "MyInvestor",
      scopeId: SCOPE_ID,
    });

    // El efectivo del contenedor, con saldo: entra en el valor, nunca en la tasa.
    const cashId = created.holdingIds.find((id) => id !== FUND_A)!;
    await store.assets.updateAssetValuation(cashId, 5_000);

    const { model, portfolio, returns } = await returnsOf(created.id);

    expect(returns).not.toBeNull();
    // 100 participaciones compradas a 10 € valen hoy 1.200 €: +200 sobre 1.000.
    expect(returns?.investedMinor).toBe(100_000);
    expect(returns?.gainMinor).toBe(20_000);
    expect(returns?.view.totalReturnRatio).toBeCloseTo(0.2, 10);
    expect(returns?.cashMinor).toBe(5_000);
    expect(returns?.coveredMinor).toBe(120_000);

    // La base de la tasa es exactamente el valor de mercado que la ficha imprime
    // en su careo: una cifra, un motor (#1422).
    const witness = portfolioWitnessView({
      baseCurrency: "EUR",
      moneyByHoldingId: model.moneyByHoldingId,
      portfolio,
      typeByHoldingId: model.typeByHoldingId,
    });
    expect(witness.investmentMinor).toBe(returns?.coveredMinor);
    expect(witness.cashMinor).toBe(returns?.cashMinor);
  });

  test("un traspaso entre dos miembros no cuenta como capital nuevo", async () => {
    await setup();
    const created = await store.managedPortfolios.createManagedPortfolio({
      containerOwnership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
      memberHoldingIds: [FUND_A, FUND_B],
      name: "Cartera Indexada Metal",
      provider: "MyInvestor",
      scopeId: SCOPE_ID,
    });

    // Todo el fondo A se traspasa al B a mitad de camino, ya con plusvalía.
    const written = await store.command.recordInvestmentTransfer({
      destinationAssetId: FUND_B,
      destinationPricePerUnit: "11",
      executedAt: "2026-02-10",
      inOperationId: "op_in",
      originAssetId: FUND_A,
      originPricePerUnit: "11",
      outOperationId: "op_out",
      portion: { kind: "all" },
      today: TODAY,
      transferId: "trf_1",
    });
    expect(written.ok).toBe(true);

    const { returns } = await returnsOf(created.id);

    // Lo invertido sigue siendo el único dinero que entró de fuera: 1.000 €.
    // Sin la cancelación en fecha leería 2.100 € y la tasa saldría a la mitad.
    expect(returns?.investedMinor).toBe(100_000);
    expect(returns?.measuredCount).toBe(2);
  });

  test("una cartera solo con su parte sin detallar no fabrica un retorno", async () => {
    await setup();
    const created = await store.managedPortfolios.createManagedPortfolio({
      containerOwnership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
      name: "Cartera sin detallar",
      scopeId: SCOPE_ID,
      undetailedValueMinor: 60_000,
    });

    const { returns } = await returnsOf(created.id);

    expect(returns).toBeNull();
  });

  test("con parte detallada y parte sin detallar, la medida declara lo que deja fuera", async () => {
    await setup();
    const created = await store.managedPortfolios.createManagedPortfolio({
      containerOwnership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
      name: "Cartera Indexada Metal",
      scopeId: SCOPE_ID,
      undetailedValueMinor: 60_000,
    });
    await store.managedPortfolios.updateManagedPortfolio(created.id, {
      memberHoldingIds: [FUND_A],
    });

    const { returns } = await returnsOf(created.id);

    expect(returns?.coveredMinor).toBe(120_000);
    expect(returns?.uncoveredMinor).toBe(60_000);
    expect(returns?.message).toContain("sin detallar");
  });
});
