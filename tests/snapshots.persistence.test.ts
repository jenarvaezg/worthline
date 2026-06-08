import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createWorthlineStore } from "@worthline/db";
import { calculateSnapshotDeltas, calculateNetWorth } from "@worthline/domain";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("snapshot persistence", () => {
  test("freezes daily snapshots, prevents accidental duplicates, and calculates deltas", () => {
    const store = createTestStore();

    store.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    store.createManualAsset({
      currency: "EUR",
      currentValueMinor: 100_000,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });

    const workspace = store.readWorkspace()!;
    store.saveSnapshot({
      capturedAt: "2026-05-31T21:59:00.000Z",
      id: "snapshot_may",
      isMonthlyClose: true,
      scopeId: "household",
      scopeLabel: "Hogar",
      summary: calculateNetWorth({
        assets: store.readAssets(),
        liabilities: store.readLiabilities(),
        scopeId: "household",
        workspace,
      }),
      warnings: ["manual-price"],
    });

    store.updateAssetValuation("asset_cash", 120_000);
    store.saveSnapshot({
      capturedAt: "2026-06-01T21:59:00.000Z",
      id: "snapshot_june_1",
      scopeId: "household",
      scopeLabel: "Hogar",
      summary: calculateNetWorth({
        assets: store.readAssets(),
        liabilities: store.readLiabilities(),
        scopeId: "household",
        workspace,
      }),
    });
    expect(() =>
      store.saveSnapshot({
        capturedAt: "2026-06-01T22:05:00.000Z",
        id: "snapshot_duplicate",
        scopeId: "household",
        scopeLabel: "Hogar",
        summary: calculateNetWorth({
          assets: store.readAssets(),
          liabilities: store.readLiabilities(),
          scopeId: "household",
          workspace,
        }),
      }),
    ).toThrow("already exists");

    store.updateAssetValuation("asset_cash", 180_000);
    store.saveSnapshot({
      capturedAt: "2026-06-02T21:59:00.000Z",
      id: "snapshot_june_2",
      scopeId: "household",
      scopeLabel: "Hogar",
      summary: calculateNetWorth({
        assets: store.readAssets(),
        liabilities: store.readLiabilities(),
        scopeId: "household",
        workspace,
      }),
    });

    const snapshots = store.readSnapshots("household");
    const deltas = calculateSnapshotDeltas(snapshots, "snapshot_june_2");

    expect(snapshots.map((snapshot) => snapshot.totalNetWorth.amountMinor)).toEqual([
      100_000, 120_000, 180_000,
    ]);
    expect(snapshots[0]?.warnings).toEqual(["manual-price"]);
    expect(deltas.changeSincePrevious?.amountMinor).toBe(60_000);
    expect(deltas.changeSinceMonthlyClose?.amountMinor).toBe(80_000);
  });
});

function createTestStore() {
  const dataDir = mkdtempSync(join(tmpdir(), "worthline-snapshots-"));
  tempDirs.push(dataDir);

  return createWorthlineStore({
    databasePath: join(dataDir, "worthline.sqlite"),
  });
}
