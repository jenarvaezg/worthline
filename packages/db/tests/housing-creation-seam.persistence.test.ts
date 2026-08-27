/**
 * Housing-creation dated-fact seam (ADR 0020, #239).
 *
 * Creating a real_estate holding persists the asset, its acquisition anchor, its
 * appreciation rate, an optional initial valuation, AND ripples historical
 * snapshots from the acquisition date — all in ONE atomic store seam method, with
 * the from-date (acquisition date) and `today` derived behind the seam. These
 * tests exercise `createHousingHoldingAndRipple` directly at the store.
 */

import type { WorthlineStore } from "@db/index";

import { createInMemoryStore } from "@db/index";
import { describe, expect, test } from "vitest";

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

    await store.command.createHousingHolding(
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

    await store.command.createHousingHolding(
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

describe("createHousingHoldingAndRipple — the acquisition cost rides along (#1441)", () => {
  test("one call persists the VALUE anchor and the DISBURSED cost, and they differ", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);

    // Yeles: 48.000 € on the escritura, 53.354,55 € actually paid that day.
    await store.command.createHousingHolding(
      {
        asset: {
          currency: "EUR",
          currentValueMinor: 48_000_00,
          id: "yeles",
          liquidityTier: "illiquid",
          name: "Yeles",
          ownership: [{ memberId: "mJ", shareBps: 10_000 }],
          type: "real_estate",
        },
        acquisitionAnchor: {
          adjustsPriorCurve: true,
          assetId: "yeles",
          id: "anchor_acq",
          kind: "acquisition",
          valuationDate: "2024-01-01",
          valueMinor: 48_000_00,
        },
        acquisitionCostMinor: 53_354_55,
        annualAppreciationRate: null,
      },
      { today: TODAY },
    );

    expect(await store.assets.readAcquisitionCostMinor("yeles")).toBe(53_354_55);
    expect((await store.assets.readValuationAnchors("yeles"))[0]!.valueMinor).toBe(
      48_000_00,
    );
    // The curve is still cut from the VALUE — the 11,2 % that vanishes at instant
    // zero must not show up in the snapshot.
    expect(await grossAt(store, "2024-01-01")).toBe(48_000_00);
    store.close();
  });

  test("without a cost the anchor is still born, and the cost reads null", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);

    await store.command.createHousingHolding(
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

    expect(await store.assets.readValuationAnchors("piso")).toHaveLength(1);
    expect(await store.assets.readAcquisitionCostMinor("piso")).toBeNull();
    store.close();
  });
});
