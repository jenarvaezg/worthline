/**
 * Housing-creation dated-fact seam (ADR 0020, #239).
 *
 * Creating a real_estate holding persists the asset, its acquisition anchor, its
 * appreciation rate, an optional initial valuation, AND ripples historical
 * snapshots from the acquisition date — all in ONE atomic store seam method, with
 * the from-date (acquisition date) and `today` derived behind the seam. These
 * tests exercise `createHousingHoldingAndRipple` directly at the store.
 */
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "@db/index";
import type { WorthlineStore } from "@db/index";

const TODAY = "2026-06-12";

async function seedWorkspace(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
}

async function grossAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots()).find((snap) => snap.dateKey === dateKey)
    ?.grossAssets.amountMinor;
}

describe("createHousingHoldingAndRipple (housing creation seam, ADR 0020)", () => {
  test("one call creates the home, seeds the acquisition anchor + rate, AND ripples from the acquisition date", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);

    await store.createHousingHoldingAndRipple(
      {
        asset: {
          currency: "EUR",
          currentValueMinor: 100_000_00,
          id: "piso",
          liquidityTier: "illiquid",
          name: "Piso",
          ownership: [{ memberId: "mJ", shareBps: 10_000 }],
          type: "real_estate",
        },
        acquisitionAnchor: {
          adjustsPriorCurve: true,
          assetId: "piso",
          id: "anchor_acq",
          valuationDate: "2024-01-01",
          valueMinor: 100_000_00,
        },
        annualAppreciationRate: null,
      },
      { today: TODAY },
    );

    // The persist happened: the asset exists.
    expect((await store.assets.readAssets()).find((a) => a.id === "piso")).toBeDefined();
    // The acquisition anchor was seeded.
    expect(await store.assets.readValuationAnchors("piso")).toHaveLength(1);
    // The ripple happened: a snapshot was generated at the acquisition date.
    expect(await grossAt(store, "2024-01-01")).toBe(100_000_00);
    store.close();
  });

  test("seeds an optional initial valuation anchor too", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);

    await store.createHousingHoldingAndRipple(
      {
        asset: {
          currency: "EUR",
          currentValueMinor: 130_000_00,
          id: "piso",
          liquidityTier: "illiquid",
          name: "Piso",
          ownership: [{ memberId: "mJ", shareBps: 10_000 }],
          type: "real_estate",
        },
        acquisitionAnchor: {
          adjustsPriorCurve: true,
          assetId: "piso",
          id: "anchor_acq",
          valuationDate: "2024-01-01",
          valueMinor: 100_000_00,
        },
        annualAppreciationRate: "0.03",
        initialValuation: {
          adjustsPriorCurve: true,
          assetId: "piso",
          id: "anchor_init",
          valuationDate: "2025-01-01",
          valueMinor: 130_000_00,
        },
      },
      { today: TODAY },
    );

    expect(await store.assets.readValuationAnchors("piso")).toHaveLength(2);
    // The single ripple from the acquisition date generates history along the
    // curve (mirroring persistManualAssetCreation, which ripples once from
    // acquisition). The acquisition-date snapshot is present and on-curve; the
    // later anchor refines the curve.
    expect(await grossAt(store, "2024-01-01")).toBeDefined();
    store.close();
  });
});
