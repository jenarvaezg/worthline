/**
 * Tests for the /patrimonio load module (issue #1119, arch review 2026-07-17).
 *
 * loadPatrimonio: scope → the board's read model (cache-only GET, #895)
 * - Reads the price cache directly — NO refresh, NO network, NO writes.
 * - Curve-valued holdings, per-holding + per-class returns, the exposure
 *   look-through and the papelera, all assembled here so the page only renders.
 *
 * Exercised through the public interface against the in-memory store — the
 * sibling of load-dashboard.test.ts.
 */

import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import type { ExposureProfile, Workspace } from "@worthline/domain";
import { createFxRateSnapshot, listScopeOptions } from "@worthline/domain";
import { describe, expect, test, vi } from "vitest";

import { deriveExposureAndReturns, loadPatrimonio } from "./load-patrimonio";

// The ECB is the only network the loader may touch, and only when a foreign
// holding is present (`resolveFxAggregation`). Here it answers with a fixed USD
// rate and no GBP rate at all, so one foreign fund converts and the other is
// excluded — the two FX paths the portfolio-cost lens must ride (#1717).
vi.mock("@worthline/pricing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@worthline/pricing")>()),
  resolveFxRateSnapshot: async () =>
    createFxRateSnapshot({ USD: [{ dateKey: "2026-06-10", eurPerUnit: 0.9 }] }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TODAY = "2026-06-10";

async function makeWorkspace(store: WorthlineStore): Promise<Workspace> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
  const workspace = await store.workspace.readWorkspace();
  if (!workspace) throw new Error("workspace not initialized");
  return workspace;
}

/** The default household scope for a freshly-initialized workspace. */
function householdScope(workspace: Workspace) {
  const scopes = listScopeOptions(workspace);
  return scopes[0];
}

async function makeCashAsset(store: WorthlineStore): Promise<void> {
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 100_000_00,
    id: "asset_cash",
    liquidityTier: "cash",
    name: "Caja",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "cash",
  });
}

/** A market ETF with one buy and a fresh cached price — exercises the returns. */
async function makeFundWithOperation(store: WorthlineStore): Promise<void> {
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "asset_fund",
    instrument: "etf",
    securityId: { kind: "isin", value: "IE00SP500002" },
    name: "S&P 500 ETF",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    providerSymbol: "SXR8.DE",
  });
  await store.operations.recordOperation({
    assetId: "asset_fund",
    currency: "EUR",
    executedAt: "2026-06-01T10:00:00.000Z",
    id: "op_1",
    kind: "buy",
    pricePerUnit: "100",
    units: "10",
  });
  await store.operations.upsertPrice({
    assetId: "asset_fund",
    currency: "EUR",
    fetchedAt: "2026-06-09T09:00:00.000Z",
    freshnessState: "fresh",
    price: "110",
    source: "stooq",
  });
}

// ---------------------------------------------------------------------------
// Empty workspace — nothing assembled, everything empties, never throws.
// ---------------------------------------------------------------------------

describe("loadPatrimonio — empty workspace", () => {
  test("returns empty, non-null figures when there are no holdings", async () => {
    const store = await createInMemoryStore();
    const workspace = await makeWorkspace(store);

    const result = await loadPatrimonio({
      store,
      workspace,
      selectedScope: householdScope(workspace),
      today: TODAY,
      selectedGroup: "direction",
    });

    expect(result.groups).toEqual([]);
    expect(result.hasHoldings).toBe(false);
    expect(result.hasPricedHoldings).toBe(false);
    expect(result.returnsById.size).toBe(0);
    expect(result.operatedAssetIds.size).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.trash).toEqual({ assets: [], liabilities: [] });

    const derived = deriveExposureAndReturns(result.exposureContext, []);
    expect(derived.returnsByClass).toBeNull();
    // The look-through still resolves — it simply classifies nothing.
    expect(derived.exposureFull.assetClass.coverage.classified.amountMinor).toBe(0);
    expect(derived.exposureEquity.assetClass.coverage.classified.amountMinor).toBe(0);

    store.close();
  });

  test("no scope → no projection, so the board groups stay empty even with assets", async () => {
    const store = await createInMemoryStore();
    const workspace = await makeWorkspace(store);
    await makeCashAsset(store);

    const result = await loadPatrimonio({
      store,
      workspace,
      selectedScope: undefined,
      today: TODAY,
      selectedGroup: "direction",
    });

    // The asset exists (hasHoldings) but with no scope there is no projection.
    expect(result.hasHoldings).toBe(true);
    expect(result.groups).toEqual([]);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// A populated board — groups, returns, papelera and the priced-holding gate.
// ---------------------------------------------------------------------------

describe("loadPatrimonio — populated board", () => {
  test("groups the unified list and flags a holding as present", async () => {
    const store = await createInMemoryStore();
    const workspace = await makeWorkspace(store);
    await makeCashAsset(store);

    const result = await loadPatrimonio({
      store,
      workspace,
      selectedScope: householdScope(workspace),
      today: TODAY,
      selectedGroup: "direction",
    });

    expect(result.hasHoldings).toBe(true);
    expect(result.groups.length).toBeGreaterThan(0);
    // The cash asset carries no operations, so it shows no returns.
    expect(result.returnsById.has("asset_cash")).toBe(false);

    store.close();
  });

  test("folds a market holding's operations into per-holding returns and the priced-holding gate", async () => {
    const store = await createInMemoryStore();
    const workspace = await makeWorkspace(store);
    await makeFundWithOperation(store);

    const result = await loadPatrimonio({
      store,
      workspace,
      selectedScope: householdScope(workspace),
      today: TODAY,
      selectedGroup: "direction",
    });

    // A provider-priced holding exists → the "Actualizar precios" control shows.
    expect(result.hasPricedHoldings).toBe(true);
    // The operation-bearing fund appears in the returns map and the fold guard.
    expect(result.returnsById.has("asset_fund")).toBe(true);
    expect(result.operatedAssetIds.has("asset_fund")).toBe(true);
    // Its per-class decomposition is present now there is a market holding.
    const derived = deriveExposureAndReturns(result.exposureContext, []);
    expect(derived.returnsByClass).not.toBeNull();

    store.close();
  });

  test("surfaces soft-deleted holdings in the papelera", async () => {
    const store = await createInMemoryStore();
    const workspace = await makeWorkspace(store);
    await makeCashAsset(store);
    await store.assets.softDeleteAsset("asset_cash", `${TODAY}T10:00:00.000Z`);

    const result = await loadPatrimonio({
      store,
      workspace,
      selectedScope: householdScope(workspace),
      today: TODAY,
      selectedGroup: "direction",
    });

    expect(result.trash.assets.map((asset) => asset.id)).toContain("asset_cash");

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Exposure look-through — the injected catalog reaches the classification.
// ---------------------------------------------------------------------------

describe("loadPatrimonio — exposure look-through", () => {
  test("classifies a holding through the injected exposure catalog", async () => {
    const store = await createInMemoryStore();
    const workspace = await makeWorkspace(store);
    await makeFundWithOperation(store);

    const profiles: ExposureProfile[] = [
      {
        breakdowns: {
          assetClass: { equity: "1" },
          currency: { USD: "1" },
          geography: { us: "1" },
        },
        declaredAt: null,
        hedged: false,
        key: "IE00SP500002",
        source: "user",
      },
    ];

    const result = await loadPatrimonio({
      store,
      workspace,
      selectedScope: householdScope(workspace),
      today: TODAY,
      selectedGroup: "direction",
    });

    const derived = deriveExposureAndReturns(result.exposureContext, profiles);

    // The ETF is now classified as equity — coverage is non-zero, and the
    // equity-restricted lens keeps the whole classified value.
    expect(
      derived.exposureFull.assetClass.coverage.classified.amountMinor,
    ).toBeGreaterThan(0);
    expect(
      derived.exposureEquity.assetClass.coverage.classified.amountMinor,
    ).toBeGreaterThan(0);

    store.close();
  });

  test("el plan del S&P 500 no pierde su ficha curada por el camino (#1745)", async () => {
    // El caso real de Jorge: un plan de pensiones no tiene ISIN — su identificador es
    // el código DGS. La ficha del catálogo vive bajo `dgs:N5394`, y el tablero tiene
    // que llegar a ella desde el par tipado del holding, nunca desde el slug del
    // comercializador (que cambia de una entidad a otra).
    const store = await createInMemoryStore();
    const workspace = await makeWorkspace(store);
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_plan",
      instrument: "pension_plan",
      name: "Plan S&P 500",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      providerSymbol: "N5394-Myinvestor",
      securityId: { kind: "dgs", value: "N5394" },
    });
    await store.operations.recordOperation({
      assetId: "asset_plan",
      currency: "EUR",
      executedAt: "2026-06-01T10:00:00.000Z",
      id: "op_plan",
      kind: "buy",
      pricePerUnit: "100",
      units: "10",
    });

    const profiles: ExposureProfile[] = [
      {
        breakdowns: {
          assetClass: { equity: "1" },
          geography: { other: "0.05", us: "0.95" },
        },
        declaredAt: null,
        hedged: false,
        key: "dgs:N5394",
        source: "user",
        ter: "0.0038",
      },
    ];

    const result = await loadPatrimonio({
      store,
      workspace,
      selectedScope: householdScope(workspace),
      today: TODAY,
      selectedGroup: "direction",
    });
    const derived = deriveExposureAndReturns(result.exposureContext, profiles);

    expect(derived.exposureFull.assetClass.coverage.unknown.amountMinor).toBe(0);
    expect(
      derived.exposureFull.assetClass.coverage.classified.amountMinor,
    ).toBeGreaterThan(0);
    expect(derived.exposureFull.geography.slices).toContainEqual(
      expect.objectContaining({ key: "us", weight: "0.95" }),
    );

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Portfolio cost (#1717) — the TER lens rides the same rows and catalog.
// ---------------------------------------------------------------------------

describe("loadPatrimonio — portfolio cost", () => {
  test("prices the year from the catalog TER over the projection's own rows", async () => {
    const store = await createInMemoryStore();
    const workspace = await makeWorkspace(store);
    await makeCashAsset(store);
    await makeFundWithOperation(store);

    const profiles: ExposureProfile[] = [
      {
        breakdowns: { assetClass: { equity: "1" } },
        declaredAt: null,
        hedged: false,
        key: "IE00SP500002",
        source: "user",
        ter: "0.002",
      },
    ];

    const result = await loadPatrimonio({
      store,
      workspace,
      selectedScope: householdScope(workspace),
      today: TODAY,
      selectedGroup: "direction",
    });
    const { portfolioCost } = deriveExposureAndReturns(result.exposureContext, profiles);

    // The ETF is 10 units × 110 € = 1.100 €; at 0,2 % it costs 2,20 € a year.
    // The 100.000 € of cash has no fund wrapper: not applicable, never a gap.
    expect(portfolioCost.annualCost).toEqual({ amountMinor: 220, currency: "EUR" });
    expect(portfolioCost.weightedTer).toBe("0.002");
    expect(portfolioCost.coverage).toEqual({
      declared: { amountMinor: 110_000, currency: "EUR" },
      notApplicable: { amountMinor: 100_000_00, currency: "EUR" },
      undeclared: { amountMinor: 0, currency: "EUR" },
    });

    store.close();
  });

  test("a fund the catalog gives no TER is the gap, not a free fund", async () => {
    const store = await createInMemoryStore();
    const workspace = await makeWorkspace(store);
    await makeFundWithOperation(store);

    const result = await loadPatrimonio({
      store,
      workspace,
      selectedScope: householdScope(workspace),
      today: TODAY,
      selectedGroup: "direction",
    });
    const { portfolioCost } = deriveExposureAndReturns(result.exposureContext, []);

    expect(portfolioCost.weightedTer).toBeNull();
    expect(portfolioCost.coverage.undeclared).toEqual({
      amountMinor: 110_000,
      currency: "EUR",
    });

    store.close();
  });

  test("a USD fund is priced on its converted euros, never 1:1 (#1065)", async () => {
    const store = await createInMemoryStore();
    const workspace = await makeWorkspace(store);
    await makeForeignFund(store, { currency: "USD", isin: "IE00B5BMR087" });

    const result = await loadPatrimonio({
      store,
      workspace,
      selectedScope: householdScope(workspace),
      today: TODAY,
      selectedGroup: "direction",
    });
    const { exposureFull, portfolioCost } = deriveExposureAndReturns(
      result.exposureContext,
      [terProfile("IE00B5BMR087", "0.002")],
    );

    // 10 units × 110 USD = 1.100 USD, at 0,90 € the dollar = 990 €. At 0,2 % that
    // is 1,98 € a year — summed 1:1 it would have read 2,20 €.
    expect(portfolioCost.coverage.declared).toEqual({
      amountMinor: 99_000,
      currency: "EUR",
    });
    expect(portfolioCost.annualCost).toEqual({ amountMinor: 198, currency: "EUR" });
    // The row keeps its real denomination, so the same position is the USD
    // currency risk the look-through reports (ADR 0039), on the same euros.
    expect(exposureFull.currencyRisk).toEqual([
      { key: "USD", value: { amountMinor: 99_000, currency: "EUR" }, weight: "1" },
    ]);

    store.close();
  });

  test("a position the FX layer cannot convert leaves the cost exactly as it leaves the look-through", async () => {
    const store = await createInMemoryStore();
    const workspace = await makeWorkspace(store);
    await makeFundWithOperation(store);
    // No GBP rate exists in the snapshot: the projection excludes this fund from
    // its rows and its gross, and neither lens may count it in another currency.
    await makeForeignFund(store, { currency: "GBP", isin: "IE00B3F81409" });

    const result = await loadPatrimonio({
      store,
      workspace,
      selectedScope: householdScope(workspace),
      today: TODAY,
      selectedGroup: "direction",
    });
    const { exposureFull, portfolioCost } = deriveExposureAndReturns(
      result.exposureContext,
      [terProfile("IE00SP500002", "0.002"), terProfile("IE00B3F81409", "0.001")],
    );

    const gross = result.exposureContext.projection?.totalGrossAssets.amountMinor;
    expect(result.exposureContext.projection?.fxExcluded.map((h) => h.holdingId)).toEqual(
      ["asset_foreign_gbp"],
    );
    const { declared, notApplicable, undeclared } = portfolioCost.coverage;
    const { classified, notApplicable: na, unknown } = exposureFull.assetClass.coverage;
    expect(
      declared.amountMinor + notApplicable.amountMinor + undeclared.amountMinor,
    ).toBe(gross);
    expect(classified.amountMinor + na.amountMinor + unknown.amountMinor).toBe(gross);
    expect(portfolioCost.annualCost).toEqual({ amountMinor: 220, currency: "EUR" });

    store.close();
  });

  test("a «solo saldo» managed portfolio's aggregate reads as a TER gap, its cash box as not applicable (#1810)", async () => {
    const store = await createInMemoryStore();
    const workspace = await makeWorkspace(store);
    await makeCashAsset(store);
    const scope = householdScope(workspace);
    await store.managedPortfolios.createManagedPortfolio({
      containerOwnership: [{ memberId: "member_jose", shareBps: 10_000 }],
      name: "Cartera MyInvestor",
      scopeId: "household",
      undetailedValueMinor: 20_000_00,
    });

    const result = await loadPatrimonio({
      store,
      workspace,
      selectedScope: scope,
      today: TODAY,
      selectedGroup: "direction",
    });
    const { portfolioCost } = deriveExposureAndReturns(result.exposureContext, []);

    // The 20.000 € are funds nobody enumerated: the gap. The 100.000 € of cash
    // (and the portfolio's own empty box) charge no TER.
    expect(portfolioCost.coverage).toEqual({
      declared: { amountMinor: 0, currency: "EUR" },
      notApplicable: { amountMinor: 100_000_00, currency: "EUR" },
      undeclared: { amountMinor: 20_000_00, currency: "EUR" },
    });

    store.close();
  });
});

function terProfile(key: string, ter: string): ExposureProfile {
  return {
    breakdowns: { assetClass: { equity: "1" } },
    declaredAt: null,
    hedged: false,
    key,
    source: "user",
    ter,
  };
}

/** A foreign-currency fund: 10 units priced at 110 in its own currency. */
async function makeForeignFund(
  store: WorthlineStore,
  input: { currency: "USD" | "GBP"; isin: string },
): Promise<void> {
  const id = `asset_foreign_${input.currency.toLowerCase()}`;
  await store.assets.createInvestmentAsset({
    currency: input.currency,
    id,
    instrument: "etf",
    name: `${input.currency} ETF`,
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    providerSymbol: `${input.currency}.ETF`,
    securityId: { kind: "isin", value: input.isin },
  });
  await store.operations.recordOperation({
    assetId: id,
    currency: input.currency,
    executedAt: "2026-06-01T10:00:00.000Z",
    id: `op_${id}`,
    kind: "buy",
    pricePerUnit: "100",
    units: "10",
  });
  await store.operations.upsertPrice({
    assetId: id,
    currency: input.currency,
    fetchedAt: "2026-06-09T09:00:00.000Z",
    freshnessState: "fresh",
    price: "110",
    source: "stooq",
  });
}
