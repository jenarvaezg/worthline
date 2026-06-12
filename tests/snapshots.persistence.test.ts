import { afterEach, describe, expect, test } from "vitest";

import {
  calculateSnapshotDeltas,
  captureValuedNetWorthSnapshot,
  type DomainWarning,
} from "@worthline/domain";
import { createFileBackedStore, cleanupTempDirs } from "./helpers";

afterEach(cleanupTempDirs);

describe("snapshot persistence", () => {
  test("freezes daily snapshots, prevents accidental duplicates, and calculates deltas", () => {
    const store = createFileBackedStore("worthline-snapshots-");

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

    const may = captureValuedNetWorthSnapshot({
      assets,
      capturedAt: "2026-05-31T21:59:00.000Z",
      id: "snapshot_may",
      isMonthlyClose: true,
      liabilities,
      scopeId: "household",
      scopeLabel: "Hogar",
      workspace,
    });
    store.snapshots.saveSnapshot({ holdings: may.holdings, snapshot: may.snapshot });

    store.assets.updateAssetValuation("asset_cash", 120_000);
    const assets2 = store.assets.readAssets();
    const june1 = captureValuedNetWorthSnapshot({
      assets: assets2,
      capturedAt: "2026-06-01T21:59:00.000Z",
      id: "snapshot_june_1",
      liabilities: store.liabilities.readLiabilities(),
      scopeId: "household",
      scopeLabel: "Hogar",
      workspace,
    });
    store.snapshots.saveSnapshot({ holdings: june1.holdings, snapshot: june1.snapshot });
    // A concurrent second save for the same scope+day must not throw — upsert wins.
    const duplicate = captureValuedNetWorthSnapshot({
      assets: store.assets.readAssets(),
      capturedAt: "2026-06-01T22:05:00.000Z",
      id: "snapshot_duplicate",
      liabilities: store.liabilities.readLiabilities(),
      scopeId: "household",
      scopeLabel: "Hogar",
      workspace,
    });
    store.snapshots.saveSnapshot({ holdings: duplicate.holdings, snapshot: duplicate.snapshot });
    // After the collision the row count for that date-key is still 1.
    expect(
      store.snapshots.readSnapshots("household").filter((s) => s.dateKey === "2026-06-01"),
    ).toHaveLength(1);
    // And there is still exactly one holding row for that day's scope.
    expect(
      store
        .snapshots.readSnapshotHoldings({ scopeId: "household" })
        .filter((row) => row.dateKey === "2026-06-01"),
    ).toHaveLength(1);

    store.assets.updateAssetValuation("asset_cash", 180_000);
    const assets3 = store.assets.readAssets();
    const june2 = captureValuedNetWorthSnapshot({
      assets: assets3,
      capturedAt: "2026-06-02T21:59:00.000Z",
      id: "snapshot_june_2",
      liabilities: store.liabilities.readLiabilities(),
      scopeId: "household",
      scopeLabel: "Hogar",
      workspace,
    });
    store.snapshots.saveSnapshot({ holdings: june2.holdings, snapshot: june2.snapshot });

    const snapshots = store.snapshots.readSnapshots("household");
    const deltas = calculateSnapshotDeltas(snapshots, "snapshot_june_2");

    expect(snapshots.map((snapshot) => snapshot.totalNetWorth.amountMinor)).toEqual([
      100_000, 120_000, 180_000,
    ]);
    expect(snapshots[0]?.warnings).toEqual([]);
    expect(deltas.changeSincePrevious?.amountMinor).toBe(60_000);
    expect(deltas.changeSinceMonthlyClose?.amountMinor).toBe(80_000);

    // The frozen holding rows track each day's valuation alongside the headline.
    const rows = store.snapshots.readSnapshotHoldings({ scopeId: "household" });
    const cashByDate = new Map(
      rows
        .filter((row) => row.holdingId === "asset_cash")
        .map((row) => [row.dateKey, row.valueMinor]),
    );
    expect(cashByDate.get("2026-05-31")).toBe(100_000);
    expect(cashByDate.get("2026-06-01")).toBe(120_000);
    expect(cashByDate.get("2026-06-02")).toBe(180_000);
  });

  test("freezes domain warnings present at capture time", () => {
    const store = createFileBackedStore("worthline-snapshots-");

    store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 0,
      id: "asset_zero",
      liquidityTier: "cash",
      name: "Cuenta vacia",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });

    const workspace = store.workspace.readWorkspace()!;
    const captured = captureValuedNetWorthSnapshot({
      assets: store.assets.readAssets(),
      capturedAt: "2026-06-01T12:00:00.000Z",
      id: "snapshot_with_warnings",
      liabilities: store.liabilities.readLiabilities(),
      scopeId: "household",
      scopeLabel: "Hogar",
      workspace,
    });
    store.snapshots.saveSnapshot({ holdings: captured.holdings, snapshot: captured.snapshot });

    const snapshots = store.snapshots.readSnapshots("household");
    const warnings: DomainWarning[] = snapshots[0]!.warnings;

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe("ZERO_VALUE_ASSET");
    expect(warnings[0]!.entityId).toBe("asset_zero");
    expect(warnings[0]!.severity).toBe("overrideable");

    // The zero-value asset is also frozen as a holding row alongside its warning.
    const rows = store.snapshots.readSnapshotHoldings({ scopeId: "household" });
    const zeroRow = rows.find((row) => row.holdingId === "asset_zero");
    expect(zeroRow).toMatchObject({
      kind: "asset",
      label: "Cuenta vacia",
      valueMinor: 0,
    });
  });
});
