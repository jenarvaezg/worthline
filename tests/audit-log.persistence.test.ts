import { afterEach, describe, expect, test } from "vitest";

import { createFileBackedStore, cleanupTempDirs } from "./helpers";

afterEach(cleanupTempDirs);

function setupStore() {
  const store = createFileBackedStore("worthline-audit-");

  store.workspace.initializeWorkspace({
    members: [{ id: "member_a", name: "Ana" }],
    mode: "individual",
  });

  return store;
}

describe("soft delete - assets", () => {
  test("softDeleteAsset hides asset from readAssets()", () => {
    const store = setupStore();

    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000,
      id: "asset_1",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_a", shareBps: 10_000 }],
      type: "cash",
    });

    expect(store.assets.readAssets()).toHaveLength(1);

    store.assets.softDeleteAsset("asset_1", new Date().toISOString());

    expect(store.assets.readAssets()).toHaveLength(0);
  });

  test("restoreAsset makes it reappear", () => {
    const store = setupStore();

    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000,
      id: "asset_1",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_a", shareBps: 10_000 }],
      type: "cash",
    });

    store.assets.softDeleteAsset("asset_1", new Date().toISOString());
    expect(store.assets.readAssets()).toHaveLength(0);

    store.assets.restoreAsset("asset_1");
    expect(store.assets.readAssets()).toHaveLength(1);
  });
});

describe("soft delete - liabilities", () => {
  test("softDeleteLiability hides liability from readLiabilities()", () => {
    const store = setupStore();

    store.liabilities.createLiability({
      balanceMinor: 5_000,
      currency: "EUR",
      id: "liab_1",
      name: "Deuda",
      ownership: [{ memberId: "member_a", shareBps: 10_000 }],
      type: "debt",
    });

    expect(store.liabilities.readLiabilities()).toHaveLength(1);

    store.liabilities.softDeleteLiability("liab_1", new Date().toISOString());

    expect(store.liabilities.readLiabilities()).toHaveLength(0);
  });
});

describe("audit log", () => {
  test("creating an asset records an audit entry with action 'create_asset'", () => {
    const store = setupStore();

    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000,
      id: "asset_1",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_a", shareBps: 10_000 }],
      type: "cash",
    });

    const log = store.readAuditLog();
    expect(log.some((e) => e.action === "create_asset" && e.entityId === "asset_1")).toBe(
      true,
    );
  });

  test("updateAssetValuation records an audit entry with action 'update_valuation'", () => {
    const store = setupStore();

    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000,
      id: "asset_1",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_a", shareBps: 10_000 }],
      type: "cash",
    });
    store.assets.updateAssetValuation("asset_1", 20_000);

    const log = store.readAuditLog();
    expect(
      log.some((e) => e.action === "update_valuation" && e.entityId === "asset_1"),
    ).toBe(true);
  });

  test("softDeleteAsset records audit entry with action 'delete_asset'", () => {
    const store = setupStore();

    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000,
      id: "asset_1",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_a", shareBps: 10_000 }],
      type: "cash",
    });
    store.assets.softDeleteAsset("asset_1", new Date().toISOString());

    const log = store.readAuditLog();
    expect(log.some((e) => e.action === "delete_asset" && e.entityId === "asset_1")).toBe(
      true,
    );
  });

  test("readAuditLog filtered by entityId returns only that entity's entries", () => {
    const store = setupStore();

    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000,
      id: "asset_1",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_a", shareBps: 10_000 }],
      type: "cash",
    });
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 5_000,
      id: "asset_2",
      liquidityTier: "market",
      name: "Fondo",
      ownership: [{ memberId: "member_a", shareBps: 10_000 }],
      type: "manual",
    });

    const log = store.readAuditLog({ entityId: "asset_1" });
    expect(log.every((e) => e.entityId === "asset_1")).toBe(true);
    expect(log.length).toBeGreaterThan(0);
  });
});
