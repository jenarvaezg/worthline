/**
 * Housing valuation commands (#967): exercise the command interface directly
 * against an in-memory store — no server actions.
 */

import { createInMemoryStore } from "@db/index";
import { describe, expect, test } from "vitest";
import {
  executeAddValuationAnchorCommand,
  executeDeleteValuationAnchorCommand,
  executeSetAnnualAppreciationRateCommand,
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
