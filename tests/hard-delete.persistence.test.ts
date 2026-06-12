/**
 * Hard delete + workspace reset persistence (issues #80–#84).
 *
 * The store-level contract behind irreversible deletion:
 *  - a holding hard-deletes ONLY from the trash; live holdings are refused
 *  - destroying a holding takes its ownerships, investment metadata, operations,
 *    price cache (FK cascades) and its warning overrides (cleared by hand)
 *  - frozen snapshots are NEVER touched (ADR 0008) — history stays intact
 *  - an audit entry records every destruction; prior audit entries survive
 *  - a member hard-deletes only while disabled and owning no share of anything
 *  - the reset empties every table, returning the workspace to onboarding
 */
import { afterEach, describe, expect, test } from "vitest";

import type { WorthlineStore } from "@worthline/db";
import type { NetWorthSnapshot, SnapshotHoldingRow } from "@worthline/domain";
import { createFileBackedStore, cleanupTempDirs } from "./helpers";

afterEach(cleanupTempDirs);

function setupStore(): WorthlineStore {
  const store = createFileBackedStore("worthline-hard-delete-");
  store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Yo" }],
    mode: "individual",
  });
  return store;
}

function seedAsset(store: WorthlineStore, id = "a1", name = "Cuenta"): void {
  store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 1000,
    id,
    isPrimaryResidence: false,
    liquidityTier: "cash",
    name,
    ownership: [{ memberId: "m", shareBps: 10_000 }],
    type: "cash",
  });
}

function seedInvestmentWithOps(store: WorthlineStore, id = "inv1"): void {
  store.assets.createInvestmentAsset({
    currency: "EUR",
    id,
    liquidityTier: "market",
    name: "ETF",
    ownership: [{ memberId: "m", shareBps: 10_000 }],
  });
  store.operations.recordOperation({
    assetId: id,
    currency: "EUR",
    executedAt: "2026-01-10",
    feesMinor: 0,
    id: `${id}_op_buy`,
    kind: "buy",
    pricePerUnit: "100",
    units: "10",
  });
  store.operations.recordOperation({
    assetId: id,
    currency: "EUR",
    executedAt: "2026-02-10",
    feesMinor: 0,
    id: `${id}_op_sell`,
    kind: "sell",
    pricePerUnit: "120",
    units: "4",
  });
}

/** A minimal reconciling snapshot capturing one asset holding worth `valueMinor`. */
function captureSnapshot(
  store: WorthlineStore,
  holdingId: string,
  label: string,
  valueMinor: number,
): void {
  const money = (amountMinor: number) => ({ amountMinor, currency: "EUR" });
  const snapshot: NetWorthSnapshot = {
    capturedAt: "2026-03-01T00:00:00.000Z",
    dateKey: "2026-03-01",
    debts: money(0),
    grossAssets: money(valueMinor),
    housingEquity: money(0),
    id: "snap_1",
    isMonthlyClose: false,
    liquidNetWorth: money(valueMinor),
    monthKey: "2026-03",
    scopeId: "household",
    scopeLabel: "Hogar",
    totalNetWorth: money(valueMinor),
    warnings: [],
  };
  const holdings: SnapshotHoldingRow[] = [
    {
      holdingId,
      kind: "asset",
      label,
      liquidityTier: "cash",
      valueMinor,
    },
  ];
  store.snapshots.saveSnapshot({ holdings, snapshot });
}

describe("hardDeleteAsset", () => {
  test("refuses a live asset (only trash is the doorway)", () => {
    const store = setupStore();
    seedAsset(store);

    expect(store.assets.hardDeleteAsset("a1")).toBe(0);
    expect(store.assets.readAssets().some((a) => a.id === "a1")).toBe(true);
    store.close();
  });

  test("destroys a trashed asset, its overrides, and audits it", () => {
    const store = setupStore();
    seedAsset(store);
    store.acknowledgeWarning("zero_value_asset", "a1");
    store.assets.softDeleteAsset("a1", "2026-06-09T00:00:00.000Z");

    expect(store.assets.hardDeleteAsset("a1")).toBe(1);

    expect(store.readTrash().assets).toEqual([]);
    expect(store.readWarningOverrides()).toEqual([]);
    // Idempotent: a second hard delete finds nothing.
    expect(store.assets.hardDeleteAsset("a1")).toBe(0);

    const audit = store.readAuditLog({ entityId: "a1" });
    expect(audit.some((e) => e.action === "hard_delete_asset")).toBe(true);
    // Prior trail (create + soft delete + acknowledge) is preserved.
    expect(audit.some((e) => e.action === "create_asset")).toBe(true);
    expect(audit.some((e) => e.action === "delete_asset")).toBe(true);
    store.close();
  });

  test("an investment hard delete cascades its operations away", () => {
    const store = setupStore();
    seedInvestmentWithOps(store);
    store.assets.softDeleteAsset("inv1", "2026-06-09T00:00:00.000Z");

    expect(store.assets.hardDeleteAsset("inv1")).toBe(1);
    expect(store.operations.readOperations("inv1")).toEqual([]);
    expect(store.assets.readInvestmentAssetById("inv1")).toBeNull();

    // The audit entry carries the destroyed operations for manual recovery.
    const entry = store
      .readAuditLog({ entityId: "inv1" })
      .find((e) => e.action === "hard_delete_asset");
    expect(entry).toBeTruthy();
    expect((entry!.details.operations as unknown[]).length).toBe(2);
    store.close();
  });

  test("frozen snapshots are untouched — history stays intact (ADR 0008)", () => {
    const store = setupStore();
    seedAsset(store, "a1", "Piso");
    captureSnapshot(store, "a1", "Piso", 1000);

    const before = store.snapshots.readSnapshotHoldings();
    expect(before).toHaveLength(1);

    store.assets.softDeleteAsset("a1", "2026-06-09T00:00:00.000Z");
    expect(store.assets.hardDeleteAsset("a1")).toBe(1);

    const after = store.snapshots.readSnapshotHoldings();
    expect(after).toHaveLength(1);
    expect(after[0]!.label).toBe("Piso");
    expect(after[0]!.holdingId).toBe("a1");
    store.close();
  });
});

describe("hardDeleteLiability", () => {
  test("refuses a live liability, destroys a trashed one", () => {
    const store = setupStore();
    store.liabilities.createLiability({
      balanceMinor: 5000,
      currency: "EUR",
      id: "l1",
      name: "Préstamo",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
      type: "debt",
    });

    expect(store.liabilities.hardDeleteLiability("l1")).toBe(0);

    store.liabilities.softDeleteLiability("l1", "2026-06-09T00:00:00.000Z");
    expect(store.liabilities.hardDeleteLiability("l1")).toBe(1);
    expect(store.readTrash().liabilities).toEqual([]);
    expect(
      store
        .readAuditLog({ entityId: "l1" })
        .some((e) => e.action === "hard_delete_liability"),
    ).toBe(true);
    store.close();
  });
});

describe("emptyTrash", () => {
  test("destroys every trashed holding and leaves live ones", () => {
    const store = setupStore();
    seedAsset(store, "a1", "Borrar 1");
    seedAsset(store, "a2", "Borrar 2");
    seedAsset(store, "a3", "Vivo");
    store.liabilities.createLiability({
      balanceMinor: 5000,
      currency: "EUR",
      id: "l1",
      name: "Deuda borrar",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
      type: "debt",
    });

    store.assets.softDeleteAsset("a1", "2026-06-09T00:00:00.000Z");
    store.assets.softDeleteAsset("a2", "2026-06-09T00:00:00.000Z");
    store.liabilities.softDeleteLiability("l1", "2026-06-09T00:00:00.000Z");

    expect(store.emptyTrash()).toEqual({ assets: 2, liabilities: 1 });
    expect(store.readTrash()).toEqual({ assets: [], liabilities: [] });
    expect(store.assets.readAssets().map((a) => a.id)).toEqual(["a3"]);
    store.close();
  });

  test("no-op on an empty trash", () => {
    const store = setupStore();
    seedAsset(store, "a3", "Vivo");
    expect(store.emptyTrash()).toEqual({ assets: 0, liabilities: 0 });
    expect(store.assets.readAssets()).toHaveLength(1);
    store.close();
  });
});

describe("deleteOperation", () => {
  test("removes one operation, re-derives the position, audits the full op", () => {
    const store = setupStore();
    seedInvestmentWithOps(store);

    const ops = store.operations.readOperations("inv1");
    expect(ops).toHaveLength(2);
    const buy = ops.find((o) => o.kind === "buy")!;

    expect(store.operations.deleteOperation(buy.id)).toEqual({
      assetId: "inv1",
      executedAt: buy.executedAt,
    });
    expect(store.operations.readOperations("inv1")).toHaveLength(1);

    const entry = store
      .readAuditLog({ entityId: "inv1" })
      .find((e) => e.action === "delete_operation");
    expect(entry).toBeTruthy();
    expect(entry!.details.kind).toBe("buy");
    expect(entry!.details.units).toBe("10");
    store.close();
  });

  test("deleting a buy that leaves the position oversold is allowed", () => {
    const store = setupStore();
    seedInvestmentWithOps(store); // buy 10, sell 4 → 6 units

    const buy = store.operations.readOperations("inv1").find((o) => o.kind === "buy")!;
    // Removing the buy leaves only a sell of 4 → oversold (negative units).
    expect(store.operations.deleteOperation(buy.id)).not.toBeNull();

    const position = store.snapshots.readPositions().find((p) => p.assetId === "inv1");
    expect(position).toBeTruthy();
    expect(position!.warnings.length).toBeGreaterThan(0);
    store.close();
  });

  test("unknown operation id is a no-op", () => {
    const store = setupStore();
    expect(store.operations.deleteOperation("nope")).toBeNull();
    store.close();
  });
});

describe("member hard delete", () => {
  test("readMemberOwnerships lists holdings the member shares, trashed included", () => {
    const store = setupStore();
    seedAsset(store, "a1", "Cuenta");
    store.assets.softDeleteAsset("a1", "2026-06-09T00:00:00.000Z");

    const owned = store.workspace.readMemberOwnerships("m");
    expect(owned.assets).toEqual([{ id: "a1", name: "Cuenta" }]);
    store.close();
  });

  test("refuses an active member and one with ownerships; allows a clean disabled one", () => {
    const store = setupStore();
    store.workspace.createMember({ id: "tmp", name: "Temporal" });

    // Active → refused.
    expect(store.workspace.hardDeleteMember("tmp")).toBe(0);

    // Disabled but owning a holding → refused.
    seedAsset(store, "a1", "Cuenta");
    store.assets.updateAsset("a1", { ownership: [{ memberId: "tmp", shareBps: 10_000 }] });
    store.workspace.disableMember("tmp", "2026-06-09T00:00:00.000Z");
    expect(store.workspace.hardDeleteMember("tmp")).toBe(0);

    // Reassign the holding away, then the disabled member deletes cleanly.
    store.assets.updateAsset("a1", { ownership: [{ memberId: "m", shareBps: 10_000 }] });
    expect(store.workspace.hardDeleteMember("tmp")).toBe(1);
    expect(store.workspace.readWorkspace()!.members.some((mem) => mem.id === "tmp")).toBe(false);
    expect(
      store
        .readAuditLog({ entityId: "tmp" })
        .some((e) => e.action === "hard_delete_member"),
    ).toBe(true);
    store.close();
  });
});

describe("resetWorkspace", () => {
  test("empties everything and returns the workspace to onboarding", () => {
    const store = setupStore();
    seedAsset(store, "a1", "Cuenta");
    seedInvestmentWithOps(store, "inv1");
    captureSnapshot(store, "a1", "Cuenta", 1000);
    store.acknowledgeWarning("zero_value_asset", "a1");

    store.workspace.resetWorkspace();

    expect(store.workspace.readWorkspace()).toBeNull();
    expect(store.assets.readAssets()).toEqual([]);
    expect(store.liabilities.readLiabilities()).toEqual([]);
    expect(store.snapshots.readSnapshots()).toEqual([]);
    expect(store.snapshots.readSnapshotHoldings()).toEqual([]);
    expect(store.readWarningOverrides()).toEqual([]);
    expect(store.readAuditLog()).toEqual([]);

    // A fresh workspace can be initialized on the same file afterwards.
    store.workspace.initializeWorkspace({
      members: [{ id: "m2", name: "Otro" }],
      mode: "individual",
    });
    expect(store.workspace.readWorkspace()!.members.map((mem) => mem.name)).toEqual(["Otro"]);
    store.close();
  });
});
