import type { WorthlineStore } from "@worthline/db";

import { createInMemoryStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

import { readMatrixCells } from "./dashboard-cells";
import { parseCellsParam } from "./dashboard-matrix";
import type { LoadDashboardInput } from "./load-dashboard";
import { loadDashboard } from "./load-dashboard";

/**
 * The side-effect-free matrix reader (S4 #520, ADR 0038): builds chart-series
 * and drilldown cells from the frozen snapshots, byte-identical to the page's
 * render, with no price refresh or capture.
 */

const noOpRefresh: LoadDashboardInput["refreshPrices"] = async () => ({
  priceCache: [],
  errors: [],
});

async function seedScope(store: WorthlineStore): Promise<{ scopeId: string }> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 100_000_00,
    id: "asset_cash",
    liquidityTier: "cash",
    name: "Caja",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "cash",
  });
  // Capture today's snapshot via the page path, so the reader has frozen rows.
  const result = await loadDashboard({
    store,
    persistence: {
      status: "ok",
      checkKey: "k",
      checkedAt: "2026-06-10T10:00:00.000Z",
      checkValue: "v",
      databasePath: "/tmp/x.sqlite",
      displayPath: ".local/x.sqlite",
    },
    scopeId: undefined,
    selectedView: "total",
    today: "2026-06-10",
    now: "2026-06-10T10:00:00.000Z",
    refreshPrices: noOpRefresh,
  });
  return { scopeId: result.selectedScope!.id };
}

describe("readMatrixCells", () => {
  test("builds a chart cell as a series and a drill cell as a drilldown", async () => {
    const store = await createInMemoryStore();
    const { scopeId } = await seedScope(store);

    const cells = await readMatrixCells(
      store,
      scopeId,
      [
        { mode: "chart", range: "all" },
        { mode: "liquid", range: "all" },
        { mode: "debts", range: "all" },
      ],
      "2026-06-10",
    );

    const chart = cells["chart:all"];
    expect(chart?.kind).toBe("chart");
    if (chart?.kind === "chart") {
      expect(chart.series.length).toBeGreaterThanOrEqual(1);
    }

    const liquid = cells["liquid:all"];
    expect(liquid?.kind).toBe("drill");
    if (liquid?.kind === "drill") {
      expect(liquid.drilldown.key).toBe("liquid");
    }

    expect(cells["debts:all"]?.kind).toBe("drill");

    store.close();
  });

  test("the chart cell equals loadDashboard's per-range series (byte-identical)", async () => {
    const store = await createInMemoryStore();
    const { scopeId } = await seedScope(store);

    const cells = await readMatrixCells(
      store,
      scopeId,
      [{ mode: "chart", range: "all" }],
      "2026-06-10",
    );

    // Re-read the page's view of the same store to compare the chart series.
    const page = await loadDashboard({
      store,
      persistence: {
        status: "ok",
        checkKey: "k",
        checkedAt: "2026-06-10T10:00:00.000Z",
        checkValue: "v",
        databasePath: "/tmp/x.sqlite",
        displayPath: ".local/x.sqlite",
      },
      scopeId,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    const chart = cells["chart:all"];
    expect(chart?.kind).toBe("chart");
    if (chart?.kind === "chart") {
      expect(chart.series).toEqual(page.compositionSeriesByRange.all);
    }

    store.close();
  });

  test("no scope or no coords yields an empty map", async () => {
    const store = await createInMemoryStore();
    await seedScope(store);

    expect(
      await readMatrixCells(
        store,
        undefined,
        [{ mode: "chart", range: "all" }],
        "2026-06-10",
      ),
    ).toEqual({});
    expect(await readMatrixCells(store, "household", [], "2026-06-10")).toEqual({});

    store.close();
  });

  test("prefetched inputs reproduce loadDashboard matrixCells (shared seam)", async () => {
    const store = await createInMemoryStore();
    const { scopeId } = await seedScope(store);

    const page = await loadDashboard({
      store,
      persistence: {
        status: "ok",
        checkKey: "k",
        checkedAt: "2026-06-10T10:00:00.000Z",
        checkValue: "v",
        databasePath: "/tmp/x.sqlite",
        displayPath: ".local/x.sqlite",
      },
      scopeId,
      selectedView: "total",
      today: "2026-06-10",
      now: "2026-06-10T10:00:00.000Z",
      refreshPrices: noOpRefresh,
    });

    const parsed = parseCellsParam(Object.keys(page.matrixCells).join(","));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const [snapshots, assets, liabilities, trash] = await Promise.all([
      store.snapshots.readSnapshots(scopeId),
      store.assets.readAssets(),
      store.liabilities.readLiabilities(),
      store.readTrash(),
    ]);

    const cells = await readMatrixCells(store, scopeId, parsed.coords, "2026-06-10", {
      snapshots,
      holdingRows: page.snapshotHoldingRows,
      currentHoldingIds: [
        ...assets.map((asset) => asset.id),
        ...liabilities.map((liability) => liability.id),
      ],
      trashedHoldingIds: [
        ...trash.assets.map((asset) => asset.id),
        ...trash.liabilities.map((liability) => liability.id),
      ],
    });

    expect(cells).toEqual(page.matrixCells);

    store.close();
  });
});
