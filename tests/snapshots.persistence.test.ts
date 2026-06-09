import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createWorthlineStore } from "@worthline/db";
import {
  calculateSnapshotDeltas,
  captureNetWorthSnapshot,
  type DomainWarning,
} from "@worthline/domain";

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
    const assets = store.readAssets();
    const liabilities = store.readLiabilities();

    store.saveSnapshot({
      snapshot: captureNetWorthSnapshot({
        assets,
        capturedAt: "2026-05-31T21:59:00.000Z",
        id: "snapshot_may",
        isMonthlyClose: true,
        liabilities,
        scopeId: "household",
        scopeLabel: "Hogar",
        workspace,
      }),
    });

    store.updateAssetValuation("asset_cash", 120_000);
    const assets2 = store.readAssets();
    store.saveSnapshot({
      snapshot: captureNetWorthSnapshot({
        assets: assets2,
        capturedAt: "2026-06-01T21:59:00.000Z",
        id: "snapshot_june_1",
        liabilities: store.readLiabilities(),
        scopeId: "household",
        scopeLabel: "Hogar",
        workspace,
      }),
    });
    expect(() =>
      store.saveSnapshot({
        snapshot: captureNetWorthSnapshot({
          assets: store.readAssets(),
          capturedAt: "2026-06-01T22:05:00.000Z",
          id: "snapshot_duplicate",
          liabilities: store.readLiabilities(),
          scopeId: "household",
          scopeLabel: "Hogar",
          workspace,
        }),
      }),
    ).toThrow("already exists");

    store.updateAssetValuation("asset_cash", 180_000);
    const assets3 = store.readAssets();
    store.saveSnapshot({
      snapshot: captureNetWorthSnapshot({
        assets: assets3,
        capturedAt: "2026-06-02T21:59:00.000Z",
        id: "snapshot_june_2",
        liabilities: store.readLiabilities(),
        scopeId: "household",
        scopeLabel: "Hogar",
        workspace,
      }),
    });

    const snapshots = store.readSnapshots("household");
    const deltas = calculateSnapshotDeltas(snapshots, "snapshot_june_2");

    expect(snapshots.map((snapshot) => snapshot.totalNetWorth.amountMinor)).toEqual([
      100_000, 120_000, 180_000,
    ]);
    expect(snapshots[0]?.warnings).toEqual([]);
    expect(deltas.changeSincePrevious?.amountMinor).toBe(60_000);
    expect(deltas.changeSinceMonthlyClose?.amountMinor).toBe(80_000);
  });

  test("freezes domain warnings present at capture time", () => {
    const store = createTestStore();

    store.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    store.createManualAsset({
      currency: "EUR",
      currentValueMinor: 0,
      id: "asset_zero",
      liquidityTier: "cash",
      name: "Cuenta vacia",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });

    const workspace = store.readWorkspace()!;
    store.saveSnapshot({
      snapshot: captureNetWorthSnapshot({
        assets: store.readAssets(),
        capturedAt: "2026-06-01T12:00:00.000Z",
        id: "snapshot_with_warnings",
        liabilities: store.readLiabilities(),
        scopeId: "household",
        scopeLabel: "Hogar",
        workspace,
      }),
    });

    const snapshots = store.readSnapshots("household");
    const warnings: DomainWarning[] = snapshots[0]!.warnings;

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe("ZERO_VALUE_ASSET");
    expect(warnings[0]!.entityId).toBe("asset_zero");
    expect(warnings[0]!.severity).toBe("overrideable");
  });
});

function createTestStore() {
  const dataDir = mkdtempSync(join(tmpdir(), "worthline-snapshots-"));
  tempDirs.push(dataDir);

  return createWorthlineStore({
    databasePath: join(dataDir, "worthline.sqlite"),
  });
}
