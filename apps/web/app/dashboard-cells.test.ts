import type { WorthlineStore } from "@worthline/db";

import { captureDailySnapshotForWorkspace, createInMemoryStore } from "@worthline/db";
import { listScopeOptions } from "@worthline/domain";
import { describe, expect, test, vi } from "vitest";

import { readMatrixCells } from "./dashboard-cells";
import { parseCellsParam } from "./dashboard-matrix";
import { loadDashboard } from "./load-dashboard";

/**
 * The side-effect-free matrix reader (S4 #520, ADR 0038): builds chart-series
 * and drilldown cells from the frozen snapshots, byte-identical to the page's
 * render, with no price refresh or capture.
 */

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
  // Persist today's snapshot via the cron capture path (the GET is cache-only
  // now, #895), so the reader has frozen rows to build cells from.
  await captureDailySnapshotForWorkspace(store, "2026-06-10T10:00:00.000Z");
  return { scopeId: "household" };
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

  test("unions today's live point on the route path when the cron has not persisted it — without writing (#895)", async () => {
    const store = await createInMemoryStore();
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
    // Deliberately DO NOT capture today's snapshot: the cache-only GET (#895)
    // never persists it, mirroring the pre-cron window.
    const workspace = (await store.workspace.readWorkspace())!;
    const scope = listScopeOptions(workspace)[0]!;
    const saveSnapshot = vi.spyOn(store.snapshots, "saveSnapshot");

    // Without synthesis the route would return an EMPTY chart (the regression the
    // #895 fix closes) — nothing is persisted for today.
    const bare = await readMatrixCells(
      store,
      scope.id,
      [{ mode: "chart", range: "all" }],
      "2026-06-10",
    );
    const bareChart = bare["chart:all"];
    expect(bareChart?.kind).toBe("chart");
    if (bareChart?.kind === "chart") {
      expect(bareChart.series).toHaveLength(0);
    }

    // With the today-point synthesis, today's live point appears — and nothing
    // is written to the store.
    const withToday = await readMatrixCells(
      store,
      scope.id,
      [{ mode: "chart", range: "all" }],
      "2026-06-10",
      undefined,
      { now: "2026-06-10T10:00:00.000Z", scope },
    );
    const chart = withToday["chart:all"];
    expect(chart?.kind).toBe("chart");
    if (chart?.kind === "chart") {
      expect(chart.series.length).toBeGreaterThanOrEqual(1);
      expect(chart.series.at(-1)!.dateKey).toBe("2026-06-10");
    }
    expect(saveSnapshot).not.toHaveBeenCalled();

    store.close();
  });
});
