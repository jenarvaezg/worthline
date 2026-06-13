import { afterEach, describe, expect, test } from "vitest";

import {
  captureNetWorthSnapshot,
  planSnapshotCapture,
  deriveMonthlyCloses,
} from "@worthline/domain";
import { createFileBackedStore, cleanupTempDirs } from "./helpers";

afterEach(cleanupTempDirs);

describe("snapshot-policy persistence", () => {
  test("capture on fresh day: upsert with no replacesId inserts a new snapshot", () => {
    const store = createFileBackedStore("worthline-policy-");

    store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 100_000,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });

    const workspace = store.workspace.readWorkspace()!;
    const assets = store.assets.readAssets();
    const liabilities = store.liabilities.readLiabilities();
    const existingSnapshots = store.snapshots.readSnapshots("household");

    const plan = planSnapshotCapture(existingSnapshots, "household", "2026-06-09");
    expect(plan.shouldCapture).toBe(true);
    expect(plan.replacesId).toBeUndefined();

    const snapshot = captureNetWorthSnapshot({
      assets,
      capturedAt: "2026-06-09T10:00:00.000Z",
      id: "snapshot_day1",
      liabilities,
      scopeId: "household",
      scopeLabel: "Hogar",
      workspace,
    });

    store.snapshots.saveSnapshot({ snapshot });

    const snapshots = store.snapshots.readSnapshots("household");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.id).toBe("snapshot_day1");
    expect(snapshots[0]!.totalNetWorth.amountMinor).toBe(100_000);
  });

  test("same-day recapture: upsert with replacesId replaces the earlier snapshot", () => {
    const store = createFileBackedStore("worthline-policy-");

    store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 100_000,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });

    const workspace = store.workspace.readWorkspace()!;
    const snapshot1 = captureNetWorthSnapshot({
      assets: store.assets.readAssets(),
      capturedAt: "2026-06-09T10:00:00.000Z",
      id: "snapshot_morning",
      liabilities: store.liabilities.readLiabilities(),
      scopeId: "household",
      scopeLabel: "Hogar",
      workspace,
    });
    store.snapshots.saveSnapshot({ snapshot: snapshot1 });

    // Update asset value and recapture same day.
    store.assets.updateAssetValuation("asset_cash", 110_000);
    const existingSnapshots = store.snapshots.readSnapshots("household");
    const plan = planSnapshotCapture(existingSnapshots, "household", "2026-06-09");

    expect(plan.shouldCapture).toBe(true);
    expect(plan.replacesId).toBe("snapshot_morning");

    const snapshot2 = captureNetWorthSnapshot({
      assets: store.assets.readAssets(),
      capturedAt: "2026-06-09T18:00:00.000Z",
      id: "snapshot_evening",
      liabilities: store.liabilities.readLiabilities(),
      scopeId: "household",
      scopeLabel: "Hogar",
      workspace,
    });
    store.snapshots.saveSnapshot({ snapshot: snapshot2, replace: true });

    const snapshots = store.snapshots.readSnapshots("household");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.id).toBe("snapshot_evening");
    expect(snapshots[0]!.totalNetWorth.amountMinor).toBe(110_000);
  });

  test("deriveMonthlyCloses identifies the last snapshot of each calendar month", () => {
    const store = createFileBackedStore("worthline-policy-");

    store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 100_000,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });

    const workspace = store.workspace.readWorkspace()!;

    const makeSnapshot = (id: string, date: string, valueMinor: number) => {
      store.assets.updateAssetValuation("asset_cash", valueMinor);
      return captureNetWorthSnapshot({
        assets: store.assets.readAssets(),
        capturedAt: `${date}T12:00:00.000Z`,
        id,
        liabilities: store.liabilities.readLiabilities(),
        scopeId: "household",
        scopeLabel: "Hogar",
        workspace,
      });
    };

    store.snapshots.saveSnapshot({
      snapshot: makeSnapshot("snap_may_a", "2026-05-15", 90_000),
    });
    store.snapshots.saveSnapshot({
      snapshot: makeSnapshot("snap_may_b", "2026-05-31", 95_000),
    });
    store.snapshots.saveSnapshot({
      snapshot: makeSnapshot("snap_jun_a", "2026-06-01", 100_000),
    });
    store.snapshots.saveSnapshot({
      snapshot: makeSnapshot("snap_jun_b", "2026-06-09", 105_000),
    });

    const snapshots = store.snapshots.readSnapshots("household");
    const closes = deriveMonthlyCloses(snapshots);

    expect(closes.get("2026-05")).toBe("snap_may_b");
    expect(closes.get("2026-06")).toBe("snap_jun_b");
    expect(closes.size).toBe(2);
  });
});
