/**
 * Housing valuation commands (#967): exercise the command interface directly
 * against an in-memory store — no server actions.
 */

import { createInMemoryStore } from "@db/testing";
import { describe, expect, test } from "vitest";
import {
  executeAddValuationAnchorCommand,
  executeDeleteValuationAnchorCommand,
  executePreviewAcquisitionAnchorEditCommand,
  executeSetAnnualAppreciationRateCommand,
  executeSetHousingAcquisitionCostCommand,
  executeUpdateValuationAnchorCommand,
  runCommand,
} from "./index";

const TODAY = "2026-06-15";

async function seedHousing() {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 130_000_00,
    id: "piso",
    liquidityTier: "illiquid",
    name: "Piso",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "real_estate",
  });
  return store;
}

async function grossAt(
  store: Awaited<ReturnType<typeof seedHousing>>,
  dateKey: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots()).find((snap) => snap.dateKey === dateKey)
    ?.grossAssets.amountMinor;
}

describe("acquisition anchor (#1437)", () => {
  test("an anchor added with kind 'acquisition' reads back marked", async () => {
    const store = await seedHousing();

    await executeAddValuationAnchorCommand(store, {
      today: TODAY,
      input: {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "a1_acquisition",
        kind: "acquisition",
        valuationDate: "2004-05-19",
        valueMinor: 150_253_03,
      },
    });

    expect((await store.assets.readValuationAnchors("piso"))[0]!.kind).toBe(
      "acquisition",
    );
    expect((await store.assets.readValuationAnchorById("a1_acquisition"))!.kind).toBe(
      "acquisition",
    );
    store.close();
  });

  test("anchors added without a kind read back unmarked", async () => {
    const store = await seedHousing();

    await executeAddValuationAnchorCommand(store, {
      today: TODAY,
      input: {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "a1",
        valuationDate: "2024-06-01",
        valueMinor: 120_000_00,
      },
    });

    expect((await store.assets.readValuationAnchors("piso"))[0]!.kind).toBeNull();
    store.close();
  });

  test("delete rejects the acquisition anchor and leaves it in place", async () => {
    const store = await seedHousing();
    await executeAddValuationAnchorCommand(store, {
      today: TODAY,
      input: {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "a1_acquisition",
        kind: "acquisition",
        valuationDate: "2004-05-19",
        valueMinor: 150_253_03,
      },
    });

    const result = await executeDeleteValuationAnchorCommand(store, {
      anchorId: "a1_acquisition",
      today: TODAY,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("adquisición");
    expect(await store.assets.readValuationAnchors("piso")).toHaveLength(1);
    store.close();
  });
});

describe("acquisition edit preview (#1562)", () => {
  /** The Plasencia shape: a 2004 acquisition and a much later appraisal. */
  async function seedAcquisition() {
    const store = await seedHousing();
    await executeAddValuationAnchorCommand(store, {
      today: TODAY,
      input: {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "a_acq",
        kind: "acquisition",
        valuationDate: "2024-01-01",
        valueMinor: 100_000_00,
      },
    });
    await executeAddValuationAnchorCommand(store, {
      today: TODAY,
      input: {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "a_appraisal",
        valuationDate: "2026-01-01",
        valueMinor: 130_000_00,
      },
    });
    return store;
  }

  test("counts the snapshots the rewrite would touch and writes nothing", async () => {
    const store = await seedAcquisition();
    const before = await store.snapshots.readSnapshots();
    const grossBefore = await grossAt(store, "2024-01-01");

    const result = await executePreviewAcquisitionAnchorEditCommand(store, {
      anchorId: "a_acq",
      input: { valuationDate: "2022-06-01", valueMinor: 90_000_00 },
      today: TODAY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("preview failed");
    expect(result.value.fromDateKey).toBe("2022-06-01");
    expect(result.value.dateChanged).toBe(true);
    expect(result.value.valueChanged).toBe(true);
    // The two existing snapshots (acquisition + appraisal dates) get re-derived,
    // and the new from-date mints one more.
    expect(result.value.snapshotsRecalculated).toBe(before.length);
    expect(result.value.snapshotsGenerated).toBe(1);

    // Nothing moved: no new snapshot, no rewritten figure, no patched anchor.
    expect(await store.snapshots.readSnapshots()).toHaveLength(before.length);
    expect(await grossAt(store, "2024-01-01")).toBe(grossBefore);
    expect((await store.assets.readValuationAnchorById("a_acq"))!.valuationDate).toBe(
      "2024-01-01",
    );
    store.close();
  });

  test("compares the curve before and after on the dates that matter", async () => {
    const store = await seedAcquisition();

    const result = await executePreviewAcquisitionAnchorEditCommand(store, {
      anchorId: "a_acq",
      input: { valuationDate: "2024-01-01", valueMinor: 90_000_00 },
      today: TODAY,
    });

    if (!result.ok) throw new Error("preview failed");
    const acquisition = result.value.points.find((p) => p.dateKey === "2024-01-01")!;
    expect(acquisition.beforeMinor).toBe(100_000_00);
    expect(acquisition.afterMinor).toBe(90_000_00);
    const appraisal = result.value.points.find((p) => p.dateKey === "2026-01-01")!;
    expect(appraisal.deltaMinor).toBe(0);
    store.close();
  });

  test("refuses an anchor that is not the acquisition", async () => {
    const store = await seedAcquisition();

    const result = await executePreviewAcquisitionAnchorEditCommand(store, {
      anchorId: "a_appraisal",
      input: { valuationDate: "2026-01-01", valueMinor: 140_000_00 },
      today: TODAY,
    });

    expect(result.ok).toBe(false);
    store.close();
  });

  test("refuses an anchor that no longer exists", async () => {
    const store = await seedAcquisition();

    const result = await executePreviewAcquisitionAnchorEditCommand(store, {
      anchorId: "ghost",
      input: { valuationDate: "2024-01-01", valueMinor: 1_000_00 },
      today: TODAY,
    });

    expect(result.ok).toBe(false);
    store.close();
  });

  test("editing the acquisition keeps it a market appraisal, whatever the form says", async () => {
    const store = await seedAcquisition();

    await executeUpdateValuationAnchorCommand(store, {
      anchorId: "a_acq",
      input: {
        // What the named acquisition editor posts: it has no "es una tasación de
        // mercado" checkbox, so a naive patch would demote the acquisition to an
        // improvement and add 100.000 € on top of the curve instead of anchoring it.
        adjustsPriorCurve: false,
        valuationDate: "2024-01-01",
        valueMinor: 110_000_00,
      },
      today: TODAY,
    });

    const anchor = (await store.assets.readValuationAnchorById("a_acq"))!;
    expect(anchor.adjustsPriorCurve).toBe(true);
    expect(anchor.valueMinor).toBe(110_000_00);
    store.close();
  });
});

describe("housing valuation commands", () => {
  test("add anchor via command generates a historical snapshot at the anchor date", async () => {
    const store = await seedHousing();

    const result = await executeAddValuationAnchorCommand(store, {
      today: TODAY,
      input: {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "a1",
        valuationDate: "2024-06-01",
        valueMinor: 120_000_00,
      },
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(await grossAt(store, "2024-06-01")).toBe(120_000_00);
    store.close();
  });

  test("update anchor with a past date ripples from the earlier of old and new", async () => {
    const store = await seedHousing();
    await executeAddValuationAnchorCommand(store, {
      today: TODAY,
      input: {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "a1",
        valuationDate: "2025-01-01",
        valueMinor: 125_000_00,
      },
    });
    expect(await grossAt(store, "2025-01-01")).toBe(125_000_00);

    const result = await executeUpdateValuationAnchorCommand(store, {
      anchorId: "a1",
      today: TODAY,
      input: {
        valuationDate: "2024-01-01",
        valueMinor: 110_000_00,
      },
    });

    expect(result).toEqual({ ok: true, value: { changes: 1 } });
    expect(await grossAt(store, "2024-01-01")).toBe(110_000_00);
    store.close();
  });

  test("delete anchor via command ripples from the removed date", async () => {
    const store = await seedHousing();
    await executeAddValuationAnchorCommand(store, {
      today: TODAY,
      input: {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "a1",
        valuationDate: "2024-06-01",
        valueMinor: 120_000_00,
      },
    });

    const result = await executeDeleteValuationAnchorCommand(store, {
      anchorId: "a1",
      today: TODAY,
    });

    expect(result).toEqual({ ok: true, value: { changes: 1 } });
    expect(await store.assets.readValuationAnchors("piso")).toHaveLength(0);
    store.close();
  });

  test("set appreciation rate via command ripples pre-appraisal snapshots (#184)", async () => {
    const store = await seedHousing();
    await store.assets.setAnnualAppreciationRate("piso", "0.03");
    await executeAddValuationAnchorCommand(store, {
      today: TODAY,
      input: {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "a0",
        valuationDate: "2024-01-01",
        valueMinor: 100_000_00,
      },
    });
    await executeAddValuationAnchorCommand(store, {
      today: TODAY,
      input: {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "a1",
        valuationDate: "2025-01-01",
        valueMinor: 125_000_00,
      },
    });
    await executeDeleteValuationAnchorCommand(store, {
      anchorId: "a0",
      today: TODAY,
    });

    const before = await grossAt(store, "2024-01-01");
    expect(before).toBeDefined();

    await executeSetAnnualAppreciationRateCommand(store, {
      assetId: "piso",
      rate: "0.10",
      today: TODAY,
    });

    const after = await grossAt(store, "2024-01-01");
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    store.close();
  });

  test("runCommand harness accepts an injected store", async () => {
    const store = await seedHousing();
    const result = await runCommand(
      executeAddValuationAnchorCommand,
      {
        today: TODAY,
        input: {
          adjustsPriorCurve: true,
          assetId: "piso",
          id: "a1",
          valuationDate: "2024-01-01",
          valueMinor: 100_000_00,
        },
      },
      store,
    );

    expect(result).toEqual({ ok: true, value: undefined });
    expect(await grossAt(store, "2024-01-01")).toBe(100_000_00);
    store.close();
  });
});

describe("acquisition cost (#1441)", () => {
  test("persists what was disbursed, separately from the value anchor", async () => {
    const store = await seedHousing();

    // Yeles: appraised at 48.000 € the day it was bought for 53.354,55 €.
    await executeAddValuationAnchorCommand(store, {
      today: TODAY,
      input: {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "a_acq",
        kind: "acquisition",
        valuationDate: "2024-01-01",
        valueMinor: 48_000_00,
      },
    });

    const result = await executeSetHousingAcquisitionCostCommand(store, {
      assetId: "piso",
      costMinor: 53_354_55,
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(await store.assets.readAcquisitionCostMinor("piso")).toBe(53_354_55);
    // The anchor keeps saying VALUE — the cost did not overwrite it.
    expect((await store.assets.readValuationAnchors("piso"))[0]!.valueMinor).toBe(
      48_000_00,
    );
    store.close();
  });

  test("a cost edit ripples NOTHING — an earlier snapshot stays identical", async () => {
    const store = await seedHousing();
    await executeAddValuationAnchorCommand(store, {
      today: TODAY,
      input: {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "a_acq",
        kind: "acquisition",
        valuationDate: "2024-01-01",
        valueMinor: 48_000_00,
      },
    });

    const before = await grossAt(store, "2024-01-01");
    expect(before).toBe(48_000_00);

    await executeSetHousingAcquisitionCostCommand(store, {
      assetId: "piso",
      costMinor: 53_354_55,
    });

    // The contrast with the rate test above is the point: a rate change recuts the
    // curve, a cost change is not on the curve at all (#1441).
    expect(await grossAt(store, "2024-01-01")).toBe(before);
    store.close();
  });

  test("a blank clears it back to «nobody has typed it yet»", async () => {
    const store = await seedHousing();

    await executeSetHousingAcquisitionCostCommand(store, {
      assetId: "piso",
      costMinor: 53_354_55,
    });
    await executeSetHousingAcquisitionCostCommand(store, {
      assetId: "piso",
      costMinor: null,
    });

    expect(await store.assets.readAcquisitionCostMinor("piso")).toBeNull();
    store.close();
  });

  test("only a property can carry one", async () => {
    const store = await seedHousing();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 5_000_00,
      id: "cuadro",
      liquidityTier: "illiquid",
      name: "Cuadro",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "manual",
    });

    await expect(
      executeSetHousingAcquisitionCostCommand(store, {
        assetId: "cuadro",
        costMinor: 1_000_00,
      }),
    ).rejects.toThrow(/real-estate/i);
    store.close();
  });

  test("refuses a negative or fractional amount of minor units", async () => {
    const store = await seedHousing();

    await expect(
      executeSetHousingAcquisitionCostCommand(store, {
        assetId: "piso",
        costMinor: -1,
      }),
    ).rejects.toThrow(/non-negative integer/i);
    await expect(
      executeSetHousingAcquisitionCostCommand(store, {
        assetId: "piso",
        costMinor: 1_000.5,
      }),
    ).rejects.toThrow(/non-negative integer/i);
    expect(await store.assets.readAcquisitionCostMinor("piso")).toBeNull();
    store.close();
  });
});
