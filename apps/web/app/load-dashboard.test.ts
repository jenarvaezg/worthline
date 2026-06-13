/**
 * Tests for the dashboard load module (issue #69).
 *
 * loadDashboard: scope → dashboard state
 * - Refresh stale prices (via refreshAndPersistStalePrices)
 * - Capture at most one snapshot per scope per day, day's latest winning (ADR 0005)
 * - Compute dashboard state via prepareDashboardState
 * - Pricing failures degrade to last-known values with an explicit signal
 */
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "@worthline/db";
import type { WorthlineStore } from "@worthline/db";

import type { LoadDashboardInput } from "./load-dashboard";
import { loadDashboard } from "./load-dashboard";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkspace(store: WorthlineStore): void {
  store.workspace.initializeWorkspace({
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
}

function makeAsset(store: WorthlineStore): void {
  store.assets.createManualAsset({
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

/** A no-op pricing refresher — nothing to refresh, no errors. */
const noOpRefresh: LoadDashboardInput["refreshPrices"] = async () => ({
  priceCache: [],
  errors: [],
});

// ---------------------------------------------------------------------------
// Snapshot capture policy
// ---------------------------------------------------------------------------

describe("loadDashboard — snapshot capture policy", () => {
  test("captures a snapshot on first load of the day", async () => {
    const store = createInMemoryStore();
    makeWorkspace(store);
    makeAsset(store);

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    // A snapshot should have been captured for the household scope (which is
    // the default scope for an individual workspace)
    const scopeId = result.selectedScope?.id ?? "household";
    const snapshots = store.snapshots.readSnapshots(scopeId);
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    expect(snapshots.some((s) => s.dateKey === "2026-06-10")).toBe(true);

    store.close();
  });

  test("replaces existing snapshot on same-day reload (latest wins)", async () => {
    const store = createInMemoryStore();
    makeWorkspace(store);
    makeAsset(store);

    // First load at 08:00
    const firstResult = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T08:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    const scopeId = firstResult.selectedScope!.id;
    const snapshotsAfterFirst = store.snapshots.readSnapshots(scopeId);
    expect(snapshotsAfterFirst.filter((s) => s.dateKey === "2026-06-10")).toHaveLength(1);
    const firstId = snapshotsAfterFirst[0]!.id;

    // Update value then reload at 18:00
    store.assets.updateAssetValuation("asset_cash", 120_000_00);
    await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T18:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    const snapshotsAfterSecond = store.snapshots.readSnapshots(scopeId);
    // Still exactly one snapshot for today per scope
    const todaySnapshots = snapshotsAfterSecond.filter((s) => s.dateKey === "2026-06-10");
    expect(todaySnapshots).toHaveLength(1);
    // The id changed (the old one was replaced)
    expect(todaySnapshots[0]!.id).not.toBe(firstId);
    // The new value is captured
    expect(todaySnapshots[0]!.totalNetWorth.amountMinor).toBe(120_000_00);

    store.close();
  });

  test("does not accumulate snapshots across multiple same-day loads", async () => {
    const store = createInMemoryStore();
    makeWorkspace(store);
    makeAsset(store);

    let scopeId: string | undefined;
    for (let i = 0; i < 5; i++) {
      const result = await loadDashboard({
        store,
        persistence: makePersistence(),
        scopeId: undefined,
        selectedView: "total",
        today: "2026-06-10",
        now: `2026-06-10T${String(i + 8).padStart(2, "0")}:00:00.000Z`,
        refreshPrices: noOpRefresh,
      });
      if (i === 0) {
        scopeId = result.selectedScope?.id;
      }
    }

    // Per scope: exactly one snapshot for today (latest wins)
    const snapshots = store.snapshots.readSnapshots(scopeId);
    const todaySnapshots = snapshots.filter((s) => s.dateKey === "2026-06-10");
    expect(todaySnapshots).toHaveLength(1);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Snapshot holding rows (ADR 0008, issue #72)
// ---------------------------------------------------------------------------

describe("loadDashboard — snapshot holding rows", () => {
  test("captures holding rows alongside the snapshot for every scope", async () => {
    const store = createInMemoryStore();
    makeWorkspace(store);
    makeAsset(store);

    await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    // Every scope captured its rows, not just the viewed one.
    for (const scopeId of ["household", "member_jose"]) {
      const snapshots = store.snapshots.readSnapshots(scopeId);
      expect(snapshots).toHaveLength(1);

      const rows = store.snapshots.readSnapshotHoldings({ scopeId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        holdingId: "asset_cash",
        kind: "asset",
        label: "Caja",
        liquidityTier: "cash",
        snapshotId: snapshots[0]!.id,
        valueMinor: 100_000_00,
      });
    }

    store.close();
  });

  test("same-day reload replaces the holding rows (latest wins)", async () => {
    const store = createInMemoryStore();
    makeWorkspace(store);
    makeAsset(store);

    await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T08:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    store.assets.updateAssetValuation("asset_cash", 120_000_00);
    await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T18:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    const rows = store.snapshots.readSnapshotHoldings({ scopeId: "household" });
    // At most one set of rows per scope per day.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valueMinor).toBe(120_000_00);

    store.close();
  });

  test("captures investment units and unit price on dashboard load", async () => {
    const store = createInMemoryStore();
    makeWorkspace(store);
    store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_fund",
      name: "Fondo",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    });
    store.operations.recordOperation({
      assetId: "asset_fund",
      currency: "EUR",
      executedAt: "2026-06-01T10:00:00.000Z",
      id: "op_1",
      kind: "buy",
      pricePerUnit: "100",
      units: "10.5",
    });
    store.operations.upsertPrice({
      assetId: "asset_fund",
      currency: "EUR",
      fetchedAt: "2026-06-10T09:00:00.000Z",
      freshnessState: "fresh",
      price: "110.40",
      source: "stooq",
    });

    await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    const rows = store.snapshots.readSnapshotHoldings({ scopeId: "household" });
    const fundRow = rows.find((row) => row.holdingId === "asset_fund");
    expect(fundRow?.units).toBe("10.5");
    expect(fundRow?.unitPrice).toBe("110.40");
    expect(fundRow?.valueMinor).toBe(115_920);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Drilldown resolution (#76)
// ---------------------------------------------------------------------------

describe("loadDashboard — liquid drilldown", () => {
  test("no drill param → drilldown is null", async () => {
    const store = createInMemoryStore();
    makeWorkspace(store);
    makeAsset(store);

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    expect(result.drilldown).toBeNull();

    store.close();
  });

  test("drill=liquid with single-day rows → placeholder state (null stack, no holdings)", async () => {
    const store = createInMemoryStore();
    makeWorkspace(store);
    makeAsset(store);

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      drill: "liquid",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    expect(result.drilldown).toEqual({ holdings: [], key: "liquid", stack: null });

    store.close();
  });

  test("drill=liquid over two days → stack and per-holding entries from the scope's rows", async () => {
    const store = createInMemoryStore();
    makeWorkspace(store);
    makeAsset(store);

    // Day 1 capture
    await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-09",
      now: "2026-06-09T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    // Day 2: value changed, drill requested
    store.assets.updateAssetValuation("asset_cash", 120_000_00);
    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      drill: "liquid",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
      refreshPrices: noOpRefresh,
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
    const store = createInMemoryStore();
    makeWorkspace(store);
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 300_000_00,
      id: "asset_piso",
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "real_estate",
    });

    // Day 1 capture
    await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-09",
      now: "2026-06-09T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    // Day 2: revaluation, drill requested
    store.assets.updateAssetValuation("asset_piso", 320_000_00);
    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      drill: "housing",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
      refreshPrices: noOpRefresh,
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
      tier: "illiquid",
    });

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Deltas vs previous snapshot and vs monthly close
// ---------------------------------------------------------------------------

describe("loadDashboard — deltas", () => {
  test("returns deltas vs previous snapshot after two days", async () => {
    const store = createInMemoryStore();
    makeWorkspace(store);
    makeAsset(store);

    // Day 1: 100 000 €
    await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-05-01",
      now: "2026-05-01T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    // Day 2: 110 000 €
    store.assets.updateAssetValuation("asset_cash", 110_000_00);
    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-05-02",
      now: "2026-05-02T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    expect(result.deltas).toBeDefined();
    expect(result.deltas!.changeSincePrevious).toBeDefined();
    expect(result.deltas!.changeSincePrevious!.amountMinor).toBe(10_000_00);

    store.close();
  });

  test("returns deltas vs monthly close when prior month has snapshots", async () => {
    const store = createInMemoryStore();
    makeWorkspace(store);
    makeAsset(store);

    // End of May: 100 000 €
    await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-05-31",
      now: "2026-05-31T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    // June: 115 000 €
    store.assets.updateAssetValuation("asset_cash", 115_000_00);
    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    expect(result.deltas).toBeDefined();
    expect(result.deltas!.changeSinceMonthlyClose).toBeDefined();
    expect(result.deltas!.changeSinceMonthlyClose!.amountMinor).toBe(15_000_00);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Pricing failure degradation
// ---------------------------------------------------------------------------

describe("loadDashboard — pricing failure degradation", () => {
  test("returns pricingErrors array when refresh fails — result carries explicit signal", async () => {
    const store = createInMemoryStore();
    makeWorkspace(store);
    makeAsset(store);

    const failingRefresh: LoadDashboardInput["refreshPrices"] = async () => ({
      priceCache: [],
      errors: ["AAPL: provider timeout"],
    });

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
      refreshPrices: failingRefresh,
    });

    expect(result.pricingErrors).toEqual(["AAPL: provider timeout"]);

    store.close();
  });

  test("returns empty pricingErrors when pricing succeeds", async () => {
    const store = createInMemoryStore();
    makeWorkspace(store);
    makeAsset(store);

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    expect(result.pricingErrors).toEqual([]);

    store.close();
  });

  test("still returns dashboard state (with last-known prices) when pricing fails", async () => {
    const store = createInMemoryStore();
    makeWorkspace(store);
    makeAsset(store);

    const failingRefresh: LoadDashboardInput["refreshPrices"] = async () => ({
      priceCache: [],
      errors: ["network error"],
    });

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
      refreshPrices: failingRefresh,
    });

    // dashboard state is always present even on pricing failure
    expect(result.dashboard).toBeDefined();
    expect(result.presentation).toBeDefined();
    // figures are based on last-known values (manual asset = 100 000 €)
    expect(result.presentation!.headline.amountMinor).toBe(100_000_00);

    store.close();
  });

  test("pricingErrors is an empty array (not undefined) when there are no errors", async () => {
    const store = createInMemoryStore();
    makeWorkspace(store);
    makeAsset(store);

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    expect(Array.isArray(result.pricingErrors)).toBe(true);
    expect(result.pricingErrors).toHaveLength(0);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// No workspace → redirect signal
// ---------------------------------------------------------------------------

describe("loadDashboard — no workspace", () => {
  test("returns needsOnboarding=true when no workspace exists", async () => {
    const store = createInMemoryStore();
    // No workspace initialized

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    expect(result.needsOnboarding).toBe(true);

    store.close();
  });

  test("returns needsOnboarding=false when workspace exists", async () => {
    const store = createInMemoryStore();
    makeWorkspace(store);

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    expect(result.needsOnboarding).toBe(false);

    store.close();
  });
});
