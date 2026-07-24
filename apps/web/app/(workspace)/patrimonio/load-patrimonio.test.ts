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
import { listScopeOptions } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { loadPatrimonio } from "./load-patrimonio";

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
    isin: "IE00SP500",
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
    expect(result.returnsByClass).toBeNull();
    expect(result.operatedAssetIds.size).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.trash).toEqual({ assets: [], liabilities: [] });
    // The look-through still resolves — it simply classifies nothing.
    expect(result.exposureFull.assetClass.coverage.classified.amountMinor).toBe(0);
    expect(result.exposureEquity.assetClass.coverage.classified.amountMinor).toBe(0);

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
    expect(result.returnsByClass).not.toBeNull();

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
        key: "IE00SP500",
        source: "user",
      },
    ];

    const result = await loadPatrimonio({
      store,
      workspace,
      selectedScope: householdScope(workspace),
      today: TODAY,
      selectedGroup: "direction",
      readExposureProfiles: async () => profiles,
    });

    // The ETF is now classified as equity — coverage is non-zero, and the
    // equity-restricted lens keeps the whole classified value.
    expect(
      result.exposureFull.assetClass.coverage.classified.amountMinor,
    ).toBeGreaterThan(0);
    expect(
      result.exposureEquity.assetClass.coverage.classified.amountMinor,
    ).toBeGreaterThan(0);

    store.close();
  });
});
