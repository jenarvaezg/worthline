import { afterEach, describe, expect, test } from "vitest";

import { createFileBackedStore, cleanupTempDirs } from "./helpers";

afterEach(cleanupTempDirs);

function setupStore() {
  const store = createFileBackedStore("worthline-trash-");
  store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Yo" }],
    mode: "individual",
  });

  return store;
}

describe("trash (soft-deleted records)", () => {
  test("a soft-deleted asset appears in the trash and leaves it on restore", () => {
    const store = setupStore();
    store.assets.createManualAsset({
      id: "a1",
      name: "Cuenta",
      type: "cash",
      liquidityTier: "cash",
      currency: "EUR",
      currentValueMinor: 100,
      isPrimaryResidence: false,
      ownership: [{ memberId: "m", shareBps: 10_000 }],
    });

    expect(store.readTrash().assets).toEqual([]);

    store.assets.softDeleteAsset("a1", "2026-06-09T00:00:00.000Z");
    expect(store.readTrash().assets).toEqual([{ id: "a1", name: "Cuenta" }]);
    expect(store.assets.readAssets().some((asset) => asset.id === "a1")).toBe(false);

    store.assets.restoreAsset("a1");
    expect(store.readTrash().assets).toEqual([]);
    expect(store.assets.readAssets().some((asset) => asset.id === "a1")).toBe(true);
    store.close();
  });
});
