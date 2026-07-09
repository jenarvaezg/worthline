import {
  captureNetWorthSnapshot,
  deriveMonthlyCloses,
  findTodaySnapshotId,
} from "@worthline/domain";
import { afterEach, describe, expect, test } from "vitest";
import { cleanupTempDirs, createFileBackedStore } from "./helpers";

afterEach(cleanupTempDirs);

describe("snapshot-policy persistence", () => {
  test("capture on fresh day: upsert with no replacesId inserts a new snapshot", async () => {
    const store = await createFileBackedStore("worthline-policy-");

    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 100_000,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });

    const workspace = (await store.workspace.readWorkspace())!;
    const assets = await store.assets.readAssets();
    const liabilities = await store.liabilities.readLiabilities();
    const existingSnapshots = await store.snapshots.readSnapshots("household");

    const replacesId = findTodaySnapshotId(existingSnapshots, "household", "2026-06-09");
    expect(replacesId).toBeUndefined();

    const snapshot = captureNetWorthSnapshot({
      assets,
      capturedAt: "2026-06-09T10:00:00.000Z",
      id: "snapshot_day1",
      liabilities,
      scopeId: "household",
      scopeLabel: "Hogar",
      workspace,
    });

    await store.snapshots.saveSnapshot({ snapshot });

    const snapshots = await store.snapshots.readSnapshots("household");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.id).toBe("snapshot_day1");
    expect(snapshots[0]!.totalNetWorth.amountMinor).toBe(100_000);
  });

  test("same-day recapture: upsert with replacesId replaces the earlier snapshot", async () => {
    const store = await createFileBackedStore("worthline-policy-");

    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 100_000,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });

    const workspace = (await store.workspace.readWorkspace())!;
    const snapshot1 = captureNetWorthSnapshot({
      assets: await store.assets.readAssets(),
      capturedAt: "2026-06-09T10:00:00.000Z",
      id: "snapshot_morning",
      liabilities: await store.liabilities.readLiabilities(),
      scopeId: "household",
      scopeLabel: "Hogar",
      workspace,
    });
    await store.snapshots.saveSnapshot({ snapshot: snapshot1 });

    // Update asset value and recapture same day.
    await store.assets.updateAssetValuation("asset_cash", 110_000);
    const existingSnapshots = await store.snapshots.readSnapshots("household");
    const replacesId = findTodaySnapshotId(existingSnapshots, "household", "2026-06-09");

    expect(replacesId).toBe("snapshot_morning");

    const snapshot2 = captureNetWorthSnapshot({
      assets: await store.assets.readAssets(),
      capturedAt: "2026-06-09T18:00:00.000Z",
      id: "snapshot_evening",
      liabilities: await store.liabilities.readLiabilities(),
      scopeId: "household",
      scopeLabel: "Hogar",
      workspace,
    });
    await store.snapshots.saveSnapshot({ snapshot: snapshot2, replace: true });

    const snapshots = await store.snapshots.readSnapshots("household");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.id).toBe("snapshot_evening");
    expect(snapshots[0]!.totalNetWorth.amountMinor).toBe(110_000);
  });

  test("deriveMonthlyCloses identifies the last snapshot of each calendar month", async () => {
    const store = await createFileBackedStore("worthline-policy-");

    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 100_000,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });

    const workspace = (await store.workspace.readWorkspace())!;

    const makeSnapshot = async (id: string, date: string, valueMinor: number) => {
      await store.assets.updateAssetValuation("asset_cash", valueMinor);
      return captureNetWorthSnapshot({
        assets: await store.assets.readAssets(),
        capturedAt: `${date}T12:00:00.000Z`,
        id,
        liabilities: await store.liabilities.readLiabilities(),
        scopeId: "household",
        scopeLabel: "Hogar",
        workspace,
      });
    };

    await store.snapshots.saveSnapshot({
      snapshot: await makeSnapshot("snap_may_a", "2026-05-15", 90_000),
    });
    await store.snapshots.saveSnapshot({
      snapshot: await makeSnapshot("snap_may_b", "2026-05-31", 95_000),
    });
    await store.snapshots.saveSnapshot({
      snapshot: await makeSnapshot("snap_jun_a", "2026-06-01", 100_000),
    });
    await store.snapshots.saveSnapshot({
      snapshot: await makeSnapshot("snap_jun_b", "2026-06-09", 105_000),
    });

    const snapshots = await store.snapshots.readSnapshots("household");
    const closes = deriveMonthlyCloses(snapshots);

    expect(closes.get("2026-05")).toBe("snap_may_b");
    expect(closes.get("2026-06")).toBe("snap_jun_b");
    expect(closes.size).toBe(2);
  });
});
