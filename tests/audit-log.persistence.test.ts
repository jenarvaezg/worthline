import { afterEach, describe, expect, test } from "vitest";

import { cleanupTempDirs, createFileBackedStore } from "./helpers";

afterEach(cleanupTempDirs);

async function setupStore() {
  const store = await createFileBackedStore("worthline-audit-");

  await store.workspace.initializeWorkspace({
    members: [{ id: "member_a", name: "Ana" }],
    mode: "individual",
  });

  return store;
}

describe("soft delete - assets", () => {
  test("softDeleteAsset hides asset from readAssets()", async () => {
    const store = await setupStore();

    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000,
      id: "asset_1",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_a", shareBps: 10_000 }],
      type: "cash",
    });

    expect(await store.assets.readAssets()).toHaveLength(1);

    await store.assets.softDeleteAsset("asset_1", new Date().toISOString());

    expect(await store.assets.readAssets()).toHaveLength(0);
  });

  test("restoreAsset makes it reappear", async () => {
    const store = await setupStore();

    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000,
      id: "asset_1",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_a", shareBps: 10_000 }],
      type: "cash",
    });

    await store.assets.softDeleteAsset("asset_1", new Date().toISOString());
    expect(await store.assets.readAssets()).toHaveLength(0);

    await store.assets.restoreAsset("asset_1");
    expect(await store.assets.readAssets()).toHaveLength(1);
  });
});

describe("soft delete - liabilities", () => {
  test("softDeleteLiability hides liability from readLiabilities()", async () => {
    const store = await setupStore();

    await store.liabilities.createLiability({
      balanceMinor: 5_000,
      currency: "EUR",
      id: "liab_1",
      name: "Deuda",
      ownership: [{ memberId: "member_a", shareBps: 10_000 }],
      type: "debt",
    });

    expect(await store.liabilities.readLiabilities()).toHaveLength(1);

    await store.liabilities.softDeleteLiability("liab_1", new Date().toISOString());

    expect(await store.liabilities.readLiabilities()).toHaveLength(0);
  });
});

describe("audit log", () => {
  test("creating an asset records an audit entry with action 'create_asset'", async () => {
    const store = await setupStore();

    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000,
      id: "asset_1",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_a", shareBps: 10_000 }],
      type: "cash",
    });

    const log = await store.readAuditLog();
    expect(log.some((e) => e.action === "create_asset" && e.entityId === "asset_1")).toBe(
      true,
    );
  });

  test("updateAssetValuation records an audit entry with action 'update_valuation'", async () => {
    const store = await setupStore();

    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000,
      id: "asset_1",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_a", shareBps: 10_000 }],
      type: "cash",
    });
    await store.assets.updateAssetValuation("asset_1", 20_000);

    const log = await store.readAuditLog();
    expect(
      log.some((e) => e.action === "update_valuation" && e.entityId === "asset_1"),
    ).toBe(true);
  });

  test("softDeleteAsset records audit entry with action 'delete_asset'", async () => {
    const store = await setupStore();

    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000,
      id: "asset_1",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_a", shareBps: 10_000 }],
      type: "cash",
    });
    await store.assets.softDeleteAsset("asset_1", new Date().toISOString());

    const log = await store.readAuditLog();
    expect(log.some((e) => e.action === "delete_asset" && e.entityId === "asset_1")).toBe(
      true,
    );
  });

  test("readAuditLog filtered by entityId returns only that entity's entries", async () => {
    const store = await setupStore();

    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000,
      id: "asset_1",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_a", shareBps: 10_000 }],
      type: "cash",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 5_000,
      id: "asset_2",
      liquidityTier: "market",
      name: "Fondo",
      ownership: [{ memberId: "member_a", shareBps: 10_000 }],
      type: "manual",
    });

    const log = await store.readAuditLog({ entityId: "asset_1" });
    expect(log.every((e) => e.entityId === "asset_1")).toBe(true);
    expect(log.length).toBeGreaterThan(0);
  });
});
