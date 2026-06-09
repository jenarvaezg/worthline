import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createWorthlineStore } from "@worthline/db";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function setupStore() {
  const dir = mkdtempSync(join(tmpdir(), "worthline-trash-"));
  tempDirs.push(dir);
  const store = createWorthlineStore({ databasePath: join(dir, "worthline.sqlite") });
  store.initializeWorkspace({
    members: [{ id: "m", name: "Yo" }],
    mode: "individual",
  });

  return store;
}

describe("trash (soft-deleted records)", () => {
  test("a soft-deleted asset appears in the trash and leaves it on restore", () => {
    const store = setupStore();
    store.createManualAsset({
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

    store.softDeleteAsset("a1", "2026-06-09T00:00:00.000Z");
    expect(store.readTrash().assets).toEqual([{ id: "a1", name: "Cuenta" }]);
    expect(store.readAssets().some((asset) => asset.id === "a1")).toBe(false);

    store.restoreAsset("a1");
    expect(store.readTrash().assets).toEqual([]);
    expect(store.readAssets().some((asset) => asset.id === "a1")).toBe(true);
    store.close();
  });
});
