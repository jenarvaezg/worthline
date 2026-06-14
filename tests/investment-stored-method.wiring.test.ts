/**
 * Wiring suite: investment with a `stored` instrument dispatches to the
 * `stored` surface (#152 adversarial review, fix 2).
 *
 * An investment holding may carry a non-derived instrument (precious_metal,
 * vehicle, other) via workspace import. Before fix 2, `AssetEditForm` gated
 * the manual-value field on `asset.type === "investment"` being false — so
 * such an asset showed NEITHER the value form (suppressed by type) NOR the
 * operations editor (method !== "derived"), leaving value uneditable. After
 * the fix, the gate is on `method === "stored"`, so the value form renders.
 *
 * This suite confirms the dispatch seam: `valuationMethodOfAsset` returns
 * `"stored"` for a `{type:"investment", instrument:"precious_metal"}` holding,
 * which is what drives the `method` prop into `AssetEditForm`. The domain
 * already covers this in holding-method.test.ts; this wiring test confirms it
 * with a real store-backed asset read.
 */

import { vi, describe, test, expect, afterEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { valuationMethodOfAsset } from "@worthline/domain";

const MEMBER_ID = "member_yo";
const ASSET_ID = "asset_precious_metal";

let store: WorthlineStore;

afterEach(() => {
  store?.close();
});

function setupStore() {
  store = createInMemoryStore();
  store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Yo" }],
    mode: "individual",
  });
  // An investment holding with a stored instrument — reachable via workspace
  // import (ADR 0014, the import boundary; the add flow is out of scope).
  store.assets.createManualAsset({
    id: ASSET_ID,
    name: "Oro físico",
    type: "investment",
    instrument: "precious_metal",
    currency: "EUR",
    currentValueMinor: 5_000_00,
    liquidityTier: "illiquid",
    isPrimaryResidence: false,
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
}

describe("investment with stored instrument — method dispatch (#152 fix 2)", () => {
  test("investment+precious_metal read off readAssets dispatches to stored", () => {
    setupStore();
    const asset = store.assets.readAssets().find((a) => a.id === ASSET_ID)!;

    expect(asset).toBeDefined();
    expect(asset.type).toBe("investment");
    expect(asset.instrument).toBe("precious_metal");
    // The dispatch seam: page computes method = valuationMethodOfAsset(asset)
    // and passes it as prop to AssetEditForm. When method === "stored", the
    // manual-value form renders (fix 2 — was gated on !isInvestment before).
    expect(valuationMethodOfAsset(asset)).toBe("stored");
  });
});
