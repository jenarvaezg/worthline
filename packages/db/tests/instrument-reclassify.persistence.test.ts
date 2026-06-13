/**
 * Editing an asset's type / primary-residence flag must keep its `instrument`
 * column in sync (#149). Housing-ness is now sourced from `instrument` (which the
 * stored column drives), so an edit that does not re-derive the instrument would
 * silently diverge from the old type-based rule — the S2-class byte-identity trap.
 */
import { isHousingAsset } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "../src/index";

const own = [{ memberId: "m1", shareBps: 10000 }];

function freshStore() {
  const store = createInMemoryStore();
  store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Alice" }],
    mode: "individual",
  });
  return store;
}

describe("editing an asset keeps instrument + housing-ness in sync (#149)", () => {
  test("toggling primary residence on a manual asset reclassifies it as housing", () => {
    const store = freshStore();
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 250000,
      id: "a1",
      liquidityTier: "illiquid",
      name: "Casa de campo",
      ownership: own,
      type: "manual",
    });

    const before = store.assets.readAssets().find((a) => a.id === "a1")!;
    expect(before.instrument).toBe("other");
    expect(isHousingAsset(before)).toBe(false);

    // Only isPrimaryResidence changes — the instrument must re-derive from the
    // EFFECTIVE (current type "manual" + new primary-residence true) → property.
    store.assets.updateAsset("a1", { isPrimaryResidence: true });

    const after = store.assets.readAssets().find((a) => a.id === "a1")!;
    expect(after.instrument).toBe("property");
    expect(isHousingAsset(after)).toBe(true);
    store.close();
  });

  test("demoting a real_estate asset to a plain manual asset drops it from housing", () => {
    const store = freshStore();
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 300000,
      id: "a2",
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: own,
      type: "real_estate",
    });

    const before = store.assets.readAssets().find((a) => a.id === "a2")!;
    expect(before.instrument).toBe("property");
    expect(isHousingAsset(before)).toBe(true);

    store.assets.updateAsset("a2", { isPrimaryResidence: false, type: "manual" });

    const after = store.assets.readAssets().find((a) => a.id === "a2")!;
    expect(after.instrument).toBe("other");
    expect(isHousingAsset(after)).toBe(false);
    store.close();
  });
});
