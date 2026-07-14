/**
 * Tests for the dashboard load module (issue #69).
 *
 * loadDashboard: scope → dashboard state (cache-only GET, #895)
 * - Reads the price cache directly — NO refresh, NO network (`pricingErrors` is
 *   always empty; freshness is surfaced by the data-health engine).
 * - Performs ZERO writes: today's live chart point is synthesized in memory
 *   (histórico = persisted snapshots ∪ today's live point); the twice-daily cron
 *   is the sole snapshot writer.
 * - Compute dashboard state via prepareDashboardState.
 */

import type { SourcePositionInput, WorthlineStore } from "@worthline/db";

import { captureDailySnapshotForWorkspace, createInMemoryStore } from "@worthline/db";
import { describe, expect, test, vi } from "vitest";

import { loadDashboard } from "./load-dashboard";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeWorkspace(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
}

async function makeAsset(store: WorthlineStore): Promise<void> {
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

function makePersistence() {
  return {
    status: "ok" as const,
    checkKey: "bootstrap.last_healthcheck_at",
    checkedAt: "2026-06-10T10:00:00.000Z",
    checkValue: "2026-06-10T10:00:00.000Z",
    databasePath: "/tmp/worthline.sqlite",
    displayPath: ".local/worthline/worthline.sqlite",
  };
}

// ---------------------------------------------------------------------------
// Snapshot capture policy — cache-only GET (#895): the render NEVER writes.
// Today's live chart point is synthesized in memory (histórico = persisted
// snapshots ∪ today's live point); the twice-daily cron is the sole writer.

describe("loadDashboard — snapshot capture policy (cache-only, #895)", () => {
  test("live figures reflect today's synthesized point when curves drift from stored values", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 650_000_00,
      id: "asset_home",
      isPrimaryResidence: true,
      liquidityTier: "illiquid",
      name: "Casa",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "real_estate",
    });
    await store.assets.addValuationAnchor({
      adjustsPriorCurve: true,
      assetId: "asset_home",
      id: "anchor_home",
      valuationDate: "2026-06-21",
      valueMinor: 650_000_00,
    });
    await store.assets.setAnnualAppreciationRate("asset_home", "0.1");
    await store.liabilities.createLiability({
      balanceMinor: 100_000_00,
      currency: "EUR",
      id: "liability_mortgage",
      name: "Hipoteca",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "mortgage",
    });
    await store.liabilities.setDebtModel("liability_mortgage", "amortizable");
    await store.createAmortizationPlanAndRipple(
      {
        annualInterestRate: "0.03",
        disbursementDate: "2026-01-15",
        firstPaymentDate: "2026-02-15",
        id: "plan_mortgage",
        initialCapitalMinor: 150_000_00,
        liabilityId: "liability_mortgage",
        termMonths: 240,
      },
      { today: "2026-07-02" },
    );

    const [valuedHome, valuedMortgage] = await Promise.all([
      store.assets.valueHousingAtDate("asset_home", "2026-07-02", "2026-07-02"),
      store.liabilities.debtBalanceAtDate("liability_mortgage", "2026-07-02"),
    ]);
    expect(valuedHome).not.toBe(650_000_00);
    expect(valuedMortgage).not.toBe(100_000_00);

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-07-02",
      now: "2026-07-02T10:00:00.000Z",
    });

    // Today's point is synthesized IN MEMORY and carried in the result — the live
    // headline figure agrees with it (the drifted curve values, not the stored
    // ones).
    const todaySynthesized = result.snapshots.find(
      (snapshot) => snapshot.dateKey === "2026-07-02",
    );
    expect(todaySynthesized).toBeDefined();
    expect(result.summary!.grossAssets.amountMinor).toBe(
      todaySynthesized!.grossAssets.amountMinor,
    );
    expect(result.summary!.debts.amountMinor).toBe(todaySynthesized!.debts.amountMinor);
    expect(result.presentation!.headline.amountMinor).toBe(
      todaySynthesized!.totalNetWorth.amountMinor,
    );

    // …but the store persisted NOTHING for today (cache-only GET, zero writes).
    const persisted = await store.snapshots.readSnapshots(result.selectedScope!.id);
    expect(persisted.some((snapshot) => snapshot.dateKey === "2026-07-02")).toBe(false);

    store.close();
  });

  test("synthesizes today's point in the result without persisting it (first load of the day)", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    const scopeId = result.selectedScope?.id ?? "household";
    // Today appears in the result's snapshots + holding rows (synthesized live)…
    expect(result.snapshots.some((s) => s.dateKey === "2026-06-10")).toBe(true);
    expect(result.snapshotHoldingRows.some((r) => r.dateKey === "2026-06-10")).toBe(true);
    // …and the store persisted nothing — the cron is the sole snapshot writer.
    const persisted = await store.snapshots.readSnapshots(scopeId);
    expect(persisted.some((s) => s.dateKey === "2026-06-10")).toBe(false);
    expect(await store.snapshots.readSnapshotHoldings({ scopeId })).toHaveLength(0);

    store.close();
  });

  test("the GET performs zero writes", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    const upsertPrices = vi.spyOn(store.operations, "upsertPrices");
    const saveSnapshot = vi.spyOn(store.snapshots, "saveSnapshot");
    const revaluePositions = vi.spyOn(store.connectedSources, "revaluePositions");
    const syncConnectedSource = vi.spyOn(store, "syncConnectedSource");

    await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    expect(upsertPrices).not.toHaveBeenCalled();
    expect(saveSnapshot).not.toHaveBeenCalled();
    expect(revaluePositions).not.toHaveBeenCalled();
    expect(syncConnectedSource).not.toHaveBeenCalled();

    store.close();
  });

  test("reuses a persisted today snapshot without duplicating or writing", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    // The cron already persisted today's snapshot before this GET runs.
    await captureDailySnapshotForWorkspace(store, "2026-06-10T09:00:00.000Z");
    const before = await store.snapshots.readSnapshots("household");
    expect(before.filter((s) => s.dateKey === "2026-06-10")).toHaveLength(1);

    const saveSnapshot = vi.spyOn(store.snapshots, "saveSnapshot");
    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T18:00:00.000Z",
    });

    // The load never wrote, and the store still holds exactly one today snapshot.
    expect(saveSnapshot).not.toHaveBeenCalled();
    const after = await store.snapshots.readSnapshots("household");
    expect(after.filter((s) => s.dateKey === "2026-06-10")).toHaveLength(1);
    // The result carries that one persisted point — not a synthesized duplicate.
    expect(result.snapshots.filter((s) => s.dateKey === "2026-06-10")).toHaveLength(1);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Snapshot holding rows (ADR 0008, issue #72)
// ---------------------------------------------------------------------------

describe("loadDashboard — snapshot holding rows", () => {
  test("returns the selected scope holding rows from the single dashboard read (#571)", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    const originalRead = store.snapshots.readSnapshotHoldings.bind(store.snapshots);
    const reads: Parameters<typeof store.snapshots.readSnapshotHoldings>[0][] = [];
    store.snapshots.readSnapshotHoldings = (async (input) => {
      reads.push(input);
      return originalRead(input);
    }) as typeof store.snapshots.readSnapshotHoldings;

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    // buildTodaySnapshotForScope does NOT read snapshot holdings, so the single
    // #571 read still fires exactly once. `snapshotHoldingRows` is persisted-rows
    // ∪ today's synthesized rows — for a cold store that is just the one live row.
    expect(reads).toEqual([{ scopeId: result.selectedScope!.id }]);
    expect(result.snapshotHoldingRows).toHaveLength(1);
    expect(result.snapshotHoldingRows[0]).toMatchObject({
      holdingId: "asset_cash",
      valueMinor: 100_000_00,
    });

    store.close();
  });

  test("carries today's synthesized investment units and unit price in the result", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_fund",
      name: "Fondo",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    });
    await store.operations.recordOperation({
      assetId: "asset_fund",
      currency: "EUR",
      executedAt: "2026-06-01T10:00:00.000Z",
      id: "op_1",
      kind: "buy",
      pricePerUnit: "100",
      units: "10.5",
    });
    await store.operations.upsertPrice({
      assetId: "asset_fund",
      currency: "EUR",
      fetchedAt: "2026-06-10T09:00:00.000Z",
      freshnessState: "fresh",
      price: "110.40",
      source: "stooq",
    });

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    // The synthesized today point (never persisted) carries the same investment
    // detail the cron would freeze — units, unit price, and derived value.
    const fundRow = result.snapshotHoldingRows.find(
      (row) => row.holdingId === "asset_fund",
    );
    expect(fundRow?.units).toBe("10.5");
    expect(fundRow?.unitPrice).toBe("110.40");
    expect(fundRow?.valueMinor).toBe(115_920);
    // The store persisted nothing.
    expect(
      await store.snapshots.readSnapshotHoldings({ scopeId: "household" }),
    ).toHaveLength(0);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Drilldown resolution (#76)
// ---------------------------------------------------------------------------

describe("loadDashboard — liquid drilldown", () => {
  test("no drill param → drilldown is null", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    expect(result.drilldown).toBeNull();

    store.close();
  });

  test("drill=liquid with single-day rows → placeholder state (null stack, no holdings)", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      drill: "liquid",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    expect(result.drilldown).toEqual({ holdings: [], key: "liquid", stack: null });

    store.close();
  });

  test("drill=liquid over two days → stack and per-holding entries from the scope's rows", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    // Day 1 capture
    await captureDailySnapshotForWorkspace(store, "2026-06-09T10:00:00.000Z");

    // Day 2: value changed, drill requested
    await store.assets.updateAssetValuation("asset_cash", 120_000_00);
    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      drill: "liquid",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    expect(result.drilldown).not.toBeNull();
    expect(result.drilldown!.key).toBe("liquid");
    expect(result.drilldown!.stack).not.toBeNull();
    expect(result.drilldown!.stack!.bands.map((b) => b.band)).toEqual(["cash", "market"]);
    expect(result.drilldown!.holdings).toHaveLength(1);
    expect(result.drilldown!.holdings[0]).toMatchObject({
      currentValueMinor: 120_000_00,
      holdingId: "asset_cash",
      label: "Caja",
      tier: "cash",
    });

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Rest and housing drilldowns (#77)
// ---------------------------------------------------------------------------

describe("loadDashboard — rest and housing drilldowns", () => {
  test("drill=housing over two days → housing key, no stack, per-property entries", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 300_000_00,
      id: "asset_piso",
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "real_estate",
    });

    // Day 1 capture
    await captureDailySnapshotForWorkspace(store, "2026-06-09T10:00:00.000Z");

    // Day 2: revaluation, drill requested
    await store.assets.updateAssetValuation("asset_piso", 320_000_00);
    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      drill: "housing",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    expect(result.drilldown).not.toBeNull();
    expect(result.drilldown!.key).toBe("housing");
    // Housing is a single tier — no stacked chart, ever.
    expect(result.drilldown!.stack).toBeNull();
    expect(result.drilldown!.holdings).toHaveLength(1);
    expect(result.drilldown!.holdings[0]).toMatchObject({
      currentValueMinor: 320_000_00,
      holdingId: "asset_piso",
      label: "Piso",
      tier: "housing",
    });

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Deltas vs previous snapshot and vs monthly close
// ---------------------------------------------------------------------------

describe("loadDashboard — deltas", () => {
  test("returns deltas vs previous snapshot after two days", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    // Day 1: 100 000 €
    await captureDailySnapshotForWorkspace(store, "2026-05-01T10:00:00.000Z");

    // Day 2: 110 000 €
    await store.assets.updateAssetValuation("asset_cash", 110_000_00);
    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-05-02",
      now: "2026-05-02T10:00:00.000Z",
    });

    expect(result.deltas).toBeDefined();
    expect(result.deltas!.changeSincePrevious).toBeDefined();
    expect(result.deltas!.changeSincePrevious!.amountMinor).toBe(10_000_00);

    store.close();
  });

  test("returns deltas vs monthly close when prior month has snapshots", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    // End of May: 100 000 €
    await captureDailySnapshotForWorkspace(store, "2026-05-31T10:00:00.000Z");

    // June: 115 000 €
    await store.assets.updateAssetValuation("asset_cash", 115_000_00);
    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    expect(result.deltas).toBeDefined();
    expect(result.deltas!.changeSinceMonthlyClose).toBeDefined();
    expect(result.deltas!.changeSinceMonthlyClose!.amountMinor).toBe(15_000_00);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Framed headline deltas (#244) — the figures that reach the hero chips
// ---------------------------------------------------------------------------

describe("loadDashboard — framed headline deltas", () => {
  test("computes vs-previous and vs-monthly-close in the total framing", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    // End of May: total 100 000 €
    await captureDailySnapshotForWorkspace(store, "2026-05-31T10:00:00.000Z");

    // June: total 120 000 €
    await store.assets.updateAssetValuation("asset_cash", 120_000_00);
    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    // vs previous and vs monthly close are the same here (single prior snapshot,
    // which is also May's close), framed to the total figure.
    expect(result.headlineDeltas.sincePrevious).toEqual({
      change: { amountMinor: 20_000_00, currency: "EUR" },
      pct: 20,
    });
    expect(result.headlineDeltas.sinceMonthlyClose).toEqual({
      change: { amountMinor: 20_000_00, currency: "EUR" },
      pct: 20,
    });

    store.close();
  });

  test("framed to the liquid figure when the liquid view is selected", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    // A cash asset (liquid) plus a property (illiquid, not liquid) so total and
    // liquid diverge and the framing changes the delta.
    await makeAsset(store);
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 200_000_00,
      id: "asset_piso",
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "real_estate",
    });

    // Day 1: liquid 100 000 €, total 300 000 €
    await captureDailySnapshotForWorkspace(store, "2026-06-09T10:00:00.000Z");

    // Day 2: cash grows to 150 000 €, property unchanged → liquid +50 000 €,
    // total +50 000 € too, but the liquid base (100 000 €) makes pct +50%.
    await store.assets.updateAssetValuation("asset_cash", 150_000_00);
    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "liquid",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    expect(result.headlineDeltas.sincePrevious).toEqual({
      change: { amountMinor: 50_000_00, currency: "EUR" },
      pct: 50,
    });

    store.close();
  });

  test("null chips when there is no prior snapshot to compare against", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    expect(result.headlineDeltas.sincePrevious).toBeNull();
    expect(result.headlineDeltas.sinceMonthlyClose).toBeNull();

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Cache-only GET (#895) — the render never refreshes prices nor syncs sources.
// `pricingErrors` is retained for result-shape stability but is always empty;
// figures read from the last-known price cache already in the store.
// ---------------------------------------------------------------------------

describe("loadDashboard — cache-only GET (#895)", () => {
  test("pricingErrors is always an empty array — the GET never refreshes", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    expect(Array.isArray(result.pricingErrors)).toBe(true);
    expect(result.pricingErrors).toEqual([]);

    store.close();
  });

  test("figures use the last-known values already in the store", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    // Dashboard state is always present; figures are the last-known manual value.
    expect(result.dashboard).toBeDefined();
    expect(result.presentation).toBeDefined();
    expect(result.presentation!.headline.amountMinor).toBe(100_000_00);

    store.close();
  });

  test("prices an investment from the persisted price cache without any refresh", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_fund",
      name: "Fondo",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
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
    // The last-known cached price — the GET reads this directly, no network.
    await store.operations.upsertPrice({
      assetId: "asset_fund",
      currency: "EUR",
      fetchedAt: "2026-06-09T09:00:00.000Z",
      freshnessState: "fresh",
      price: "110.40",
      source: "stooq",
    });

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    // 10 units × 110.40 cached = 1 104.00 € — the cache priced it, unrefreshed.
    expect(result.pricingErrors).toEqual([]);
    expect(result.presentation!.headline.amountMinor).toBe(110_400);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// No workspace → redirect signal
// ---------------------------------------------------------------------------

describe("loadDashboard — no workspace", () => {
  test("returns needsOnboarding=true when no workspace exists", async () => {
    const store = await createInMemoryStore();
    // No workspace initialized

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    expect(result.needsOnboarding).toBe(true);

    store.close();
  });

  test("returns needsOnboarding=false when workspace exists", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    expect(result.needsOnboarding).toBe(false);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Debts drilldown (#145)
// ---------------------------------------------------------------------------

describe("loadDashboard — debts drilldown", () => {
  test("drill=debts over two days → debts key, aggregate stack, per-debt entry", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);
    await store.liabilities.createLiability({
      balanceMinor: 200_000_00,
      currency: "EUR",
      id: "debt_mortgage",
      name: "Hipoteca",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "mortgage",
    });

    // Day 1 capture
    await captureDailySnapshotForWorkspace(store, "2026-06-09T10:00:00.000Z");

    // Day 2: balance reduced, debts drill requested
    await store.liabilities.updateLiabilityBalance("debt_mortgage", 190_000_00);
    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      drill: "debts",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    expect(result.drilldown).not.toBeNull();
    expect(result.drilldown!.key).toBe("debts");
    // One aggregated debt series (not split per-liability).
    expect(result.drilldown!.stack).not.toBeNull();
    expect(result.drilldown!.stack!.bands.map((b) => b.band)).toEqual(["debts"]);
    // The mortgage appears as a per-debt multiple with its frozen latest value.
    const debt = result.drilldown!.holdings.find((h) => h.holdingId === "debt_mortgage");
    expect(debt).toBeDefined();
    expect(debt!.kind).toBe("liability");
    expect(debt!.currentValueMinor).toBe(190_000_00);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Composition range and density (#144)
// ---------------------------------------------------------------------------

describe("loadDashboard — composition range and density", () => {
  test("offers the ranges the history spans and windows the series to the selection", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    // Build 14 monthly snapshots: 2025-05 .. 2026-06 (a ~13-month span).
    for (let i = 0; i < 14; i++) {
      const total = 2025 * 12 + 4 + i;
      const y = Math.floor(total / 12);
      const m = (total % 12) + 1;
      const today = `${y}-${String(m).padStart(2, "0")}-15`;
      await store.assets.updateAssetValuation("asset_cash", 100_000_00 + i * 1_000_00);
      await captureDailySnapshotForWorkspace(store, `${today}T10:00:00.000Z`);
    }

    // Explicit all deep-link: the ~13-month span unlocks 1A (and Todo), monthly density.
    const all = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      range: "all",
      today: "2026-06-15",
      now: "2026-06-15T12:00:00.000Z",
    });
    expect(all.activeCompositionRange).toBe("all");
    expect(all.compositionRanges).toEqual(["1y", "all"]);
    expect(all.compositionSeries.length).toBe(14);

    const originalRead = store.snapshots.readSnapshotHoldings.bind(store.snapshots);
    const reads: Parameters<typeof store.snapshots.readSnapshotHoldings>[0][] = [];
    store.snapshots.readSnapshotHoldings = (async (input) => {
      reads.push(input);
      return originalRead(input);
    }) as typeof store.snapshots.readSnapshotHoldings;

    // The default load uses the bounded eager range and does not ship all-time data.
    const y1 = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-15",
      now: "2026-06-15T12:00:00.000Z",
    });
    expect(y1.activeCompositionRange).toBe("1y");
    expect(y1.compositionSeries.length).toBe(12);
    expect(y1.compositionSeries.length).toBeLessThan(all.compositionSeries.length);
    expect(y1.compositionSeriesByRange.all).toBeUndefined();
    expect(y1.matrixCells["chart:all"]).toBeUndefined();
    expect(y1.matrixCells["chart:1y"]?.kind).toBe("chart");
    expect(reads).toEqual([{ from: "2025-07-01", scopeId: y1.selectedScope!.id }]);

    store.close();
  });

  test("the active range windows the drilldown and the composition through one window", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    // Build 14 monthly snapshots: 2025-05 .. 2026-06 (a ~13-month span), each a
    // distinct cash valuation so a windowed sparkline differs from the full one.
    for (let i = 0; i < 14; i++) {
      const total = 2025 * 12 + 4 + i;
      const y = Math.floor(total / 12);
      const m = (total % 12) + 1;
      const today = `${y}-${String(m).padStart(2, "0")}-15`;
      await store.assets.updateAssetValuation("asset_cash", 100_000_00 + i * 1_000_00);
      await captureDailySnapshotForWorkspace(store, `${today}T10:00:00.000Z`);
    }

    // Drill the liquid group both unbounded and through the 1y window. Both the
    // composition series and the drill must read the SAME windowed rows — the
    // bounded drill sees only the twelve in-window dates, exactly as the chart.
    const all = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      drill: "liquid",
      range: "all",
      today: "2026-06-15",
      now: "2026-06-15T12:00:00.000Z",
    });
    const windowed = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      drill: "liquid",
      range: "1y",
      today: "2026-06-15",
      now: "2026-06-15T12:00:00.000Z",
    });

    // The composition windows to twelve closes; the drill sparkline windows to
    // the same twelve dates — one window feeds both, so they agree.
    expect(windowed.compositionSeries.length).toBe(12);
    const allCash = all.drilldown!.holdings.find((h) => h.holdingId === "asset_cash")!;
    const windowedCash = windowed.drilldown!.holdings.find(
      (h) => h.holdingId === "asset_cash",
    )!;
    // The sparkline is now bars (one per capture, this design pass), so the
    // capture count is the number of bars.
    const captureCount = (geometry: { bars: unknown[] }) => geometry.bars.length;
    // The bounded drill plots only the in-window captures (twelve), fewer than
    // the full fourteen — the same window the composition series uses.
    expect(captureCount(windowedCash.sparkline)).toBe(12);
    expect(captureCount(windowedCash.sparkline)).toBeLessThan(
      captureCount(allCash.sparkline),
    );
    // The windowed drill's latest value is still the current (open-period) value.
    expect(windowedCash.currentValueMinor).toBe(113_000_00);

    store.close();
  });

  test("returns the CPI comparison for the active composition window", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    const cpi: { dateKey: string; value: string }[] = [];
    // Build 14 monthly snapshots: 2025-05 .. 2026-06, enough to default to 1A.
    for (let i = 0; i < 14; i++) {
      const total = 2025 * 12 + 4 + i;
      const y = Math.floor(total / 12);
      const m = (total % 12) + 1;
      const month = `${y}-${String(m).padStart(2, "0")}`;
      const today = `${month}-15`;
      await store.assets.updateAssetValuation("asset_cash", 100_000_00 + i * 1_000_00);
      cpi.push({ dateKey: `${month}-01`, value: String(100 + i) });
      await captureDailySnapshotForWorkspace(store, `${today}T10:00:00.000Z`);
    }

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-15",
      now: "2026-06-15T12:00:00.000Z",
      readBenchmarkPrices: async (seriesId) => {
        expect(seriesId).toBe("ipc-es");
        return cpi;
      },
    });

    const comparison = result.benchmarkComparison.comparison;
    expect(comparison?.sinceDate).toBe(result.compositionSeries[0]!.dateKey);
    expect(comparison?.untilDate).toBe(result.compositionSeries.at(-1)!.dateKey);

    const startMonth = comparison!.sinceDate.slice(0, 7);
    const endMonth = comparison!.untilDate.slice(0, 7);
    const startCpi = Number(
      cpi.find((point) => point.dateKey.startsWith(startMonth))!.value,
    );
    const endCpi = Number(cpi.find((point) => point.dateKey.startsWith(endMonth))!.value);
    expect(comparison?.benchmarkGrowth).toBeCloseTo(endCpi / startCpi - 1);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Connected-source per-position breakdown capture (ADR 0035, PRD #459 S2)
// ---------------------------------------------------------------------------

describe("loadDashboard — Binance per-token breakdown capture (ADR 0035, #462)", () => {
  async function connectBinance(store: WorthlineStore): Promise<string> {
    const { sourceId } = await store.connectedSources.connect({
      adapter: "binance",
      label: "Binance",
      credentialsJson: JSON.stringify({ apiKey: "KEY", apiSecret: "SECRET" }),
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    });
    return sourceId;
  }

  function token(overrides: Partial<Extract<SourcePositionInput, { kind: "token" }>>) {
    return {
      kind: "token" as const,
      externalId: "BTC:spot",
      name: "BTC",
      symbol: "BTC",
      balance: "0.5",
      wallet: "spot",
      liquidityTier: "market" as const,
      unitPrice: "50000",
      imageUrl: null as string | null,
      currency: "EUR" as const,
      ...overrides,
    };
  }

  async function loadOnce(store: WorthlineStore) {
    return loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-11",
      now: "2026-06-11T10:00:00.000Z",
    });
  }

  test("freezes one row per SYMBOL, folding a token's wallets together (#247)", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    const sourceId = await connectBinance(store);
    await store.connectedSources.syncPositions(
      sourceId,
      [
        token({
          externalId: "BTC:spot",
          symbol: "BTC",
          balance: "0.5",
          unitPrice: "50000",
        }), // 25 000 € spot
        token({
          externalId: "BTC:funding",
          symbol: "BTC",
          wallet: "funding",
          balance: "0.1",
          unitPrice: "50000",
        }), // 5 000 € funding — SAME symbol, must fold into the BTC row
        token({ externalId: "ETH:spot", symbol: "ETH", balance: "2", unitPrice: "2000" }), // 4 000 €
      ],
      "2026-06-11T09:00:00.000Z",
    );

    // Cache-only GET (#895): the per-token breakdown rides today's synthesized
    // point in the result — the same capture path the cron persists — never a
    // store write.
    const { snapshotHoldingRows: rows } = await loadOnce(store);
    const binance = rows.find((row) => row.label === "Binance");
    expect(binance?.valueMinor).toBe(3_400_000);
    // Keyed by symbol (NOT symbol:wallet): BTC's two wallets collapse to one row,
    // so a wallet move never re-keys the drilldown into a phantom sell+buy (#247).
    expect(binance?.positions).toEqual([
      {
        positionKey: "BTC",
        label: "BTC",
        valueMinor: 3_000_000,
        metal: null,
        imageUrl: null,
      },
      {
        positionKey: "ETH",
        label: "ETH",
        valueMinor: 400_000,
        metal: null,
        imageUrl: null,
      },
    ]);
    // ADR 0035 invariant: the token rows sum EXACTLY to the holding's value.
    const sum = binance!.positions!.reduce((acc, p) => acc + p.valueMinor, 0);
    expect(sum).toBe(binance!.valueMinor);

    store.close();
  });

  test("an unpriceable token stays a row valued 0 beneath the holding (value-at-0)", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    const sourceId = await connectBinance(store);
    await store.connectedSources.syncPositions(
      sourceId,
      [
        token({
          externalId: "BTC:spot",
          symbol: "BTC",
          balance: "0.5",
          unitPrice: "50000",
        }),
        token({
          externalId: "WAGMI:spot",
          symbol: "WAGMI",
          balance: "100",
          unitPrice: null,
        }),
      ],
      "2026-06-11T09:00:00.000Z",
    );

    // Cache-only GET (#895): the per-token breakdown rides today's synthesized
    // point in the result — the same capture path the cron persists — never a
    // store write.
    const { snapshotHoldingRows: rows } = await loadOnce(store);
    const binance = rows.find((row) => row.label === "Binance");
    const wagmi = binance?.positions?.find((p) => p.positionKey === "WAGMI");
    expect(wagmi).toMatchObject({ label: "WAGMI", valueMinor: 0 });
    // It is present, not dropped, and the rows still reconcile to the holding.
    const sum = binance!.positions!.reduce((acc, p) => acc + p.valueMinor, 0);
    expect(sum).toBe(binance!.valueMinor);

    store.close();
  });

  test("market + term-locked rungs each freeze their own token breakdown (#248)", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    const sourceId = await connectBinance(store);
    await store.connectedSources.syncPositions(
      sourceId,
      [
        token({
          externalId: "BTC:spot",
          symbol: "BTC",
          balance: "0.5",
          unitPrice: "50000",
        }), // 25 000 € market
        token({
          externalId: "ETH:locked-earn",
          symbol: "ETH",
          balance: "3",
          unitPrice: "2000",
          wallet: "locked-earn",
          liquidityTier: "term-locked",
        }), // 6 000 € term-locked
      ],
      "2026-06-11T09:00:00.000Z",
    );

    // Cache-only GET (#895): the per-token breakdown rides today's synthesized
    // point in the result — the same capture path the cron persists — never a
    // store write.
    const { snapshotHoldingRows: rows } = await loadOnce(store);
    const binanceRows = rows.filter((row) => row.positions !== undefined);
    // Two rung assets, each with exactly its own rung's token frozen — the
    // breakdown is attributed to the right materialized holding.
    const market = binanceRows.find((row) => row.liquidityTier === "market");
    const locked = binanceRows.find((row) => row.liquidityTier === "term-locked");
    expect(market?.positions?.map((p) => p.positionKey)).toEqual(["BTC"]);
    expect(market?.valueMinor).toBe(2_500_000);
    expect(locked?.positions?.map((p) => p.positionKey)).toEqual(["ETH"]);
    expect(locked?.valueMinor).toBe(600_000);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Composition series per range (S3 #519) — the data the client range island
// switches between. The server precomputes one series per OFFERED range (the
// #518 pattern: ship the alternatives, let the client toggle), so a range pill
// click re-windows the chart with zero round-trip.
// ---------------------------------------------------------------------------

describe("loadDashboard — composition series per range", () => {
  test("ships one series per offered range, with the active range's entry equal to compositionSeries", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    // Exactly the offered ranges are keyed — no extra windows shipped.
    expect(Object.keys(result.compositionSeriesByRange).sort()).toEqual(
      [...result.compositionRanges].sort(),
    );
    // The active range (defaulting to `all`) deep-equals the standalone series,
    // so the island's initial render is byte-identical to today's server render.
    expect(result.compositionSeriesByRange.all).toEqual(result.compositionSeries);
  });

  test("keys the ACTIVE range even when it is narrower than the offered history (deep-link safety)", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    // Only one day of history → the offered ranges are just ["all"], yet a
    // deep-link asked for range=1y. The active range must still be keyed (equal
    // to the windowed series) so the island has data to render, not an empty map.
    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      range: "1y",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    expect(result.compositionRanges).toEqual(["all"]);
    expect(result.compositionSeriesByRange["1y"]).toEqual(result.compositionSeries);
    // The offered range is still keyed alongside the active one.
    expect(result.compositionSeriesByRange.all).toBeDefined();

    store.close();
  });

  test("no-workspace result carries an empty per-range map", async () => {
    const store = await createInMemoryStore();

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    expect(result.needsOnboarding).toBe(true);
    expect(result.compositionSeriesByRange).toEqual({});

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Initial matrix cross (S4 #520) — the cells the client island seeds its cache
// with: the current column (every mode at the active range) + the chart row.
// ---------------------------------------------------------------------------

describe("loadDashboard — initial matrix cross", () => {
  test("ships the current column (chart + every drill at the active range) keyed by cellKey", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    // The active cell (chart, all) and the whole column of drills at `all`.
    expect(result.matrixCells["chart:all"]?.kind).toBe("chart");
    expect(result.matrixCells["liquid:all"]?.kind).toBe("drill");
    expect(result.matrixCells["rest:all"]?.kind).toBe("drill");
    expect(result.matrixCells["housing:all"]?.kind).toBe("drill");
    expect(result.matrixCells["debts:all"]?.kind).toBe("drill");
    // The active chart cell equals the standalone series (byte-identical render).
    const chart = result.matrixCells["chart:all"];
    if (chart?.kind === "chart") {
      expect(chart.series).toEqual(result.compositionSeries);
    }

    store.close();
  });

  test("no-workspace result carries an empty matrix", async () => {
    const store = await createInMemoryStore();

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });

    expect(result.needsOnboarding).toBe(true);
    expect(result.matrixCells).toEqual({});

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Contribution plan → FIRE projection (ADR 0041, #555)
// ---------------------------------------------------------------------------

describe("loadDashboard — contribution plan for FIRE", () => {
  test("uses the persisted plan's derived monthly savings instead of the manual scalar", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    await store.saveFireConfig("household", {
      monthlySpendingMinor: 2_000_000,
      safeWithdrawalRate: 0.04,
      monthlySavingsCapacityMinor: 100_000,
      expectedRealReturn: 0.05,
    });

    const manualOnly = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });
    const manualBase = manualOnly.fireProjection!.scenarios.find(
      (s) => s.label === "base",
    )!;

    await store.contributionPlan.createPlannedContribution({
      scopeId: "household",
      destinationHoldingId: "asset_cash",
      amount: { mode: "money", value: 500_000 },
      cadence: { kind: "monthly", dayOfMonth: 1 },
      startDate: "2026-01-01",
    });

    const withPlan = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
    });
    const planBase = withPlan.fireProjection!.scenarios.find((s) => s.label === "base")!;

    expect(planBase.totalContributedMinor).toBeGreaterThan(
      manualBase.totalContributedMinor,
    );

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Home hero data-health alert (#665, PRD #654 S3)
// ---------------------------------------------------------------------------

describe("loadDashboard — hero data-health alert", () => {
  const loadInput = (store: WorthlineStore) => ({
    store,
    persistence: makePersistence(),
    scopeId: undefined,
    selectedView: "total" as const,
    today: "2026-07-02",
    now: "2026-07-02T10:00:00.000Z",
  });

  test("is clean when the data is healthy", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    const result = await loadDashboard(loadInput(store));

    expect(result.heroHealth.impact).toBe("clean");
    expect(result.heroHealth.alerts).toHaveLength(0);

    store.close();
  });

  test("surfaces a zero-value holding as a warning linking to its fix surface", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 0,
      id: "asset_zero",
      liquidityTier: "cash",
      name: "Cuenta vacía",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });

    const result = await loadDashboard(loadInput(store));

    expect(result.heroHealth.impact).toBe("warning");
    expect(result.heroHealth.alerts).toHaveLength(1);
    expect(result.heroHealth.alerts[0]?.href).toBe("/patrimonio/asset_zero/editar");

    store.close();
  });

  test("a valid override silences the signal — the alert goes clean", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 0,
      id: "asset_zero",
      liquidityTier: "cash",
      name: "Cuenta vacía",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });
    await store.acknowledgeWarning("ZERO_VALUE_ASSET", "asset_zero");

    const result = await loadDashboard(loadInput(store));

    expect(result.heroHealth.impact).toBe("clean");
    expect(result.heroHealth.alerts).toHaveLength(0);

    store.close();
  });
});
