import { afterEach, describe, expect, test } from "vitest";

import { cleanupTempDirs, createFileBackedStore } from "./helpers";

afterEach(cleanupTempDirs);

async function setupStore() {
  const store = await createFileBackedStore("worthline-trash-");
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Yo" }],
    mode: "individual",
  });

  return store;
}

describe("trash (soft-deleted records)", () => {
  test("a soft-deleted asset appears in the trash and leaves it on restore", async () => {
    const store = await setupStore();
    await store.assets.createManualAsset({
      id: "a1",
      name: "Cuenta",
      type: "cash",
      liquidityTier: "cash",
      currency: "EUR",
      currentValueMinor: 100,
      isPrimaryResidence: false,
      ownership: [{ memberId: "m", shareBps: 10_000 }],
    });

    expect((await store.readTrash()).assets).toEqual([]);

    await store.assets.softDeleteAsset("a1", "2026-06-09T00:00:00.000Z");
    expect((await store.readTrash()).assets).toEqual([{ id: "a1", name: "Cuenta" }]);
    expect((await store.assets.readAssets()).some((asset) => asset.id === "a1")).toBe(
      false,
    );

    await store.assets.restoreAsset("a1");
    expect((await store.readTrash()).assets).toEqual([]);
    expect((await store.assets.readAssets()).some((asset) => asset.id === "a1")).toBe(
      true,
    );
    store.close();
  });
});
