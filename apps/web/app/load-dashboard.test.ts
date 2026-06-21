/**
 * Tests for the dashboard load module (issue #69).
 *
 * loadDashboard: scope → dashboard state
 * - Refresh stale prices (via refreshAndPersistStalePrices)
 * - Capture at most one snapshot per scope per day, day's latest winning (ADR 0005)
 * - Compute dashboard state via prepareDashboardState
 * - Pricing failures degrade to last-known values with an explicit signal
 */
import { describe, expect, test, vi } from "vitest";

import { createInMemoryStore } from "@worthline/db";
import type { SourcePositionInput, WorthlineStore } from "@worthline/db";

import type { LoadDashboardInput } from "./load-dashboard";
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
      refreshPrices: noOpRefresh,
    });

    // A snapshot should have been captured for the household scope (which is
    // the default scope for an individual workspace)
    const scopeId = result.selectedScope?.id ?? "household";
    const snapshots = await store.snapshots.readSnapshots(scopeId);
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    expect(snapshots.some((s) => s.dateKey === "2026-06-10")).toBe(true);

    store.close();
  });

  test("replaces existing snapshot on same-day reload (latest wins)", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

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
    const snapshotsAfterFirst = await store.snapshots.readSnapshots(scopeId);
    expect(snapshotsAfterFirst.filter((s) => s.dateKey === "2026-06-10")).toHaveLength(1);
    const firstId = snapshotsAfterFirst[0]!.id;

    // Update value then reload at 18:00
    await store.assets.updateAssetValuation("asset_cash", 120_000_00);
    await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T18:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    const snapshotsAfterSecond = await store.snapshots.readSnapshots(scopeId);
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
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

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
    const snapshots = await store.snapshots.readSnapshots(scopeId);
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
    const store = await createInMemoryStore();
    // A household (not individual) so there is genuinely more than one scope:
    // individual mode collapses to the lone household scope (#269), which would
    // make "every scope" vacuous. member_jose owns the asset outright, so both
    // the (viewed) household scope and the (non-viewed) member scope capture it.
    await store.workspace.initializeWorkspace({
      members: [
        { id: "member_jose", name: "Jose" },
        { id: "member_ana", name: "Ana" },
      ],
      mode: "household",
    });
    await makeAsset(store);

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
      const snapshots = await store.snapshots.readSnapshots(scopeId);
      expect(snapshots).toHaveLength(1);

      const rows = await store.snapshots.readSnapshotHoldings({ scopeId });
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
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T08:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    await store.assets.updateAssetValuation("asset_cash", 120_000_00);
    await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T18:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    const rows = await store.snapshots.readSnapshotHoldings({ scopeId: "household" });
    // At most one set of rows per scope per day.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valueMinor).toBe(120_000_00);

    store.close();
  });

  test("captures investment units and unit price on dashboard load", async () => {
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

    await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    const rows = await store.snapshots.readSnapshotHoldings({ scopeId: "household" });
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
      refreshPrices: noOpRefresh,
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
      refreshPrices: noOpRefresh,
    });

    expect(result.drilldown).toEqual({ holdings: [], key: "liquid", stack: null });

    store.close();
  });

  test("drill=liquid over two days → stack and per-holding entries from the scope's rows", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

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
    await store.assets.updateAssetValuation("asset_cash", 120_000_00);
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
    await store.assets.updateAssetValuation("asset_piso", 320_000_00);
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
    await store.assets.updateAssetValuation("asset_cash", 110_000_00);
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
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

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
    await store.assets.updateAssetValuation("asset_cash", 115_000_00);
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
// Framed headline deltas (#244) — the figures that reach the hero chips
// ---------------------------------------------------------------------------

describe("loadDashboard — framed headline deltas", () => {
  test("computes vs-previous and vs-monthly-close in the total framing", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    // End of May: total 100 000 €
    await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-05-31",
      now: "2026-05-31T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    // June: total 120 000 €
    await store.assets.updateAssetValuation("asset_cash", 120_000_00);
    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
      refreshPrices: noOpRefresh,
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
    await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "liquid",
      today: "2026-06-09",
      now: "2026-06-09T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

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
      refreshPrices: noOpRefresh,
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
      refreshPrices: noOpRefresh,
    });

    expect(result.headlineDeltas.sincePrevious).toBeNull();
    expect(result.headlineDeltas.sinceMonthlyClose).toBeNull();

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Pricing failure degradation
// ---------------------------------------------------------------------------

describe("loadDashboard — pricing failure degradation", () => {
  test("returns pricingErrors array when refresh fails — result carries explicit signal", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

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
      refreshPrices: noOpRefresh,
    });

    expect(result.pricingErrors).toEqual([]);

    store.close();
  });

  test("still returns dashboard state (with last-known prices) when pricing fails", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

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
      refreshPrices: noOpRefresh,
    });

    expect(Array.isArray(result.pricingErrors)).toBe(true);
    expect(result.pricingErrors).toHaveLength(0);

    store.close();
  });

  test("awaits refreshBinanceSources when provided and merges its errors (PRD #245 S4)", async () => {
    const store = await createInMemoryStore();
    await makeWorkspace(store);
    await makeAsset(store);

    const refreshBinanceSources = vi.fn(async () => ({
      errors: ["Binance: revisa la conexión."],
    }));

    const result = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
      refreshPrices: noOpRefresh,
      refreshBinanceSources,
    });

    expect(refreshBinanceSources).toHaveBeenCalledTimes(1);
    expect(result.pricingErrors).toContain("Binance: revisa la conexión.");

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
      refreshPrices: noOpRefresh,
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
      refreshPrices: noOpRefresh,
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
    await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-09",
      now: "2026-06-09T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

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
      refreshPrices: noOpRefresh,
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
      await loadDashboard({
        store,
        persistence: makePersistence(),
        scopeId: undefined,
        selectedView: "total",
        today,
        now: `${today}T10:00:00.000Z`,
        refreshPrices: noOpRefresh,
      });
    }

    // Default (all): the ~13-month span unlocks 1A (and Todo), monthly density.
    const all = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      today: "2026-06-15",
      now: "2026-06-15T12:00:00.000Z",
      refreshPrices: noOpRefresh,
    });
    expect(all.compositionRanges).toEqual(["1y", "all"]);
    expect(all.compositionSeries.length).toBe(14);

    // The 1y window keeps only the last twelve monthly closes.
    const y1 = await loadDashboard({
      store,
      persistence: makePersistence(),
      scopeId: undefined,
      selectedView: "total",
      range: "1y",
      today: "2026-06-15",
      now: "2026-06-15T12:00:00.000Z",
      refreshPrices: noOpRefresh,
    });
    expect(y1.compositionSeries.length).toBe(12);
    expect(y1.compositionSeries.length).toBeLessThan(all.compositionSeries.length);

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
      await loadDashboard({
        store,
        persistence: makePersistence(),
        scopeId: undefined,
        selectedView: "total",
        today,
        now: `${today}T10:00:00.000Z`,
        refreshPrices: noOpRefresh,
      });
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
      today: "2026-06-15",
      now: "2026-06-15T12:00:00.000Z",
      refreshPrices: noOpRefresh,
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
      refreshPrices: noOpRefresh,
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
      refreshPrices: noOpRefresh,
    });
  }

  test("freezes one row per token beneath the Binance market holding, summing to it", async () => {
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
        }), // 25 000 €
        token({ externalId: "ETH:spot", symbol: "ETH", balance: "2", unitPrice: "2000" }), // 4 000 €
      ],
      "2026-06-11T09:00:00.000Z",
    );

    await loadOnce(store);

    const rows = await store.snapshots.readSnapshotHoldings({ scopeId: "household" });
    const binance = rows.find((row) => row.label === "Binance");
    expect(binance?.valueMinor).toBe(2_900_000);
    // Keyed by the stable symbol:wallet externalId, symbol label, no metal/image.
    expect(binance?.positions).toEqual([
      {
        positionKey: "BTC:spot",
        label: "BTC",
        valueMinor: 2_500_000,
        metal: null,
        imageUrl: null,
      },
      {
        positionKey: "ETH:spot",
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

    await loadOnce(store);

    const rows = await store.snapshots.readSnapshotHoldings({ scopeId: "household" });
    const binance = rows.find((row) => row.label === "Binance");
    const wagmi = binance?.positions?.find((p) => p.positionKey === "WAGMI:spot");
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

    await loadOnce(store);

    const rows = await store.snapshots.readSnapshotHoldings({ scopeId: "household" });
    const binanceRows = rows.filter((row) => row.positions !== undefined);
    // Two rung assets, each with exactly its own rung's token frozen — the
    // breakdown is attributed to the right materialized holding.
    const market = binanceRows.find((row) => row.liquidityTier === "market");
    const locked = binanceRows.find((row) => row.liquidityTier === "term-locked");
    expect(market?.positions?.map((p) => p.positionKey)).toEqual(["BTC:spot"]);
    expect(market?.valueMinor).toBe(2_500_000);
    expect(locked?.positions?.map((p) => p.positionKey)).toEqual(["ETH:locked-earn"]);
    expect(locked?.valueMinor).toBe(600_000);

    store.close();
  });
});
