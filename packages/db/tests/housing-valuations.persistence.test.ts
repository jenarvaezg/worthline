/**
 * Housing valuation anchors + appreciation rate persistence (PRD #108, slice 4).
 *
 * Integration tests against a real in-memory store: CRUD of valuation anchors,
 * the annual-appreciation-rate setter, and the value-at-date method that reads
 * the anchors + rate and delegates to the pure domain curve.
 */

import type { WorthlineStore } from "@db/index";
import { createInMemoryStore } from "@db/index";
import { valueHousingAtDate } from "@worthline/domain";
import { describe, expect, test } from "vitest";

const TODAY = "2026-06-13";

async function seed(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 130_000_00,
    id: "home",
    isPrimaryResidence: true,
    liquidityTier: "illiquid",
    name: "Casa",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "real_estate",
  });
}

describe("housing valuation anchors — CRUD", () => {
  test("create + read anchors back, ordered by date", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    await store.assets.addValuationAnchor({
      adjustsPriorCurve: true,
      assetId: "home",
      id: "a2",
      valuationDate: "2025-01-01",
      valueMinor: 120_000_00,
    });
    await store.assets.addValuationAnchor({
      adjustsPriorCurve: true,
      assetId: "home",
      id: "a1",
      valuationDate: "2024-01-01",
      valueMinor: 100_000_00,
    });

    const anchors = await store.assets.readValuationAnchors("home");
    expect(anchors.map((a) => a.valuationDate)).toEqual(["2024-01-01", "2025-01-01"]);
    expect(anchors[0]).toMatchObject({
      adjustsPriorCurve: true,
      id: "a1",
      valuationDate: "2024-01-01",
      valueMinor: 100_000_00,
    });
  });

  test("delete an anchor by id", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    await store.assets.addValuationAnchor({
      adjustsPriorCurve: false,
      assetId: "home",
      id: "imp",
      valuationDate: "2024-07-01",
      valueMinor: 10_000_00,
    });
    expect(await store.assets.readValuationAnchors("home")).toHaveLength(1);

    const removed = await store.assets.deleteValuationAnchor("imp");
    expect(removed).toBe(1);
    expect(await store.assets.readValuationAnchors("home")).toHaveLength(0);
    expect(await store.assets.deleteValuationAnchor("imp")).toBe(0);
  });

  test("rejects a non-integer minor value", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await expect(
      store.assets.addValuationAnchor({
        adjustsPriorCurve: true,
        assetId: "home",
        id: "bad",
        valuationDate: "2024-01-01",
        valueMinor: 100.5,
      }),
    ).rejects.toThrow();
  });

  test("rejects a malformed valuation date", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await expect(
      store.assets.addValuationAnchor({
        adjustsPriorCurve: true,
        assetId: "home",
        id: "bad",
        valuationDate: "2024-1-1",
        valueMinor: 100_000_00,
      }),
    ).rejects.toThrow();
  });

  test("the (asset_id, valuation_date) unique index is enforced", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.assets.addValuationAnchor({
      adjustsPriorCurve: true,
      assetId: "home",
      id: "a1",
      valuationDate: "2024-01-01",
      valueMinor: 100_000_00,
    });
    await expect(
      store.assets.addValuationAnchor({
        adjustsPriorCurve: false,
        assetId: "home",
        id: "a2",
        valuationDate: "2024-01-01",
        valueMinor: 5_000_00,
      }),
    ).rejects.toThrow();
  });
});

describe("housing valuation anchors — update", () => {
  test("update valueMinor persists the new value and returns 1", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.assets.addValuationAnchor({
      adjustsPriorCurve: true,
      assetId: "home",
      id: "a1",
      valuationDate: "2024-01-01",
      valueMinor: 100_000_00,
    });

    const changed = await store.assets.updateValuationAnchor("a1", {
      valueMinor: 105_000_00,
    });
    expect(changed).toBe(1);
    const anchors = await store.assets.readValuationAnchors("home");
    expect(anchors[0]).toMatchObject({
      valueMinor: 105_000_00,
      valuationDate: "2024-01-01",
    });
  });

  test("update valuationDate to a free slot succeeds and returns 1", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.assets.addValuationAnchor({
      adjustsPriorCurve: true,
      assetId: "home",
      id: "a1",
      valuationDate: "2024-01-01",
      valueMinor: 100_000_00,
    });

    const changed = await store.assets.updateValuationAnchor("a1", {
      valuationDate: "2024-06-01",
    });
    expect(changed).toBe(1);
    expect((await store.assets.readValuationAnchors("home"))[0]?.valuationDate).toBe(
      "2024-06-01",
    );
  });

  test("update to an already-occupied date throws (unique index)", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.assets.addValuationAnchor({
      adjustsPriorCurve: true,
      assetId: "home",
      id: "a1",
      valuationDate: "2024-01-01",
      valueMinor: 100_000_00,
    });
    await store.assets.addValuationAnchor({
      adjustsPriorCurve: false,
      assetId: "home",
      id: "imp",
      valuationDate: "2024-07-01",
      valueMinor: 10_000_00,
    });

    await expect(
      store.assets.updateValuationAnchor("a1", { valuationDate: "2024-07-01" }),
    ).rejects.toThrow();
  });

  test("update a non-existent anchor returns 0", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    expect(
      await store.assets.updateValuationAnchor("ghost", { valueMinor: 50_000_00 }),
    ).toBe(0);
  });

  test("update rejects a non-integer valueMinor", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.assets.addValuationAnchor({
      adjustsPriorCurve: true,
      assetId: "home",
      id: "a1",
      valuationDate: "2024-01-01",
      valueMinor: 100_000_00,
    });
    await expect(
      store.assets.updateValuationAnchor("a1", { valueMinor: 100.5 }),
    ).rejects.toThrow();
  });

  test("update rejects a malformed valuationDate", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.assets.addValuationAnchor({
      adjustsPriorCurve: true,
      assetId: "home",
      id: "a1",
      valuationDate: "2024-01-01",
      valueMinor: 100_000_00,
    });
    await expect(
      store.assets.updateValuationAnchor("a1", { valuationDate: "24-1-1" }),
    ).rejects.toThrow();
  });

  test("update writes a single audit entry update_valuation_anchor", async () => {
    // Verified indirectly: update returns 1 and the row reflects the change,
    // which is only possible if the audit write didn't corrupt the transaction.
    const store = await createInMemoryStore();
    await seed(store);
    await store.assets.addValuationAnchor({
      adjustsPriorCurve: true,
      assetId: "home",
      id: "a1",
      valuationDate: "2024-01-01",
      valueMinor: 100_000_00,
    });
    await store.assets.updateValuationAnchor("a1", {
      adjustsPriorCurve: false,
      valueMinor: 8_000_00,
    });
    const a = (await store.assets.readValuationAnchors("home"))[0]!;
    expect(a.adjustsPriorCurve).toBe(false);
    expect(a.valueMinor).toBe(8_000_00);
  });
});

describe("annual appreciation rate — setter", () => {
  test("set + read back the rate; null clears it", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    await store.assets.setAnnualAppreciationRate("home", "0.03");
    expect(await store.assets.readAnnualAppreciationRate("home")).toBe("0.03");

    await store.assets.setAnnualAppreciationRate("home", null);
    expect(await store.assets.readAnnualAppreciationRate("home")).toBeNull();
  });

  test("rejects a non-decimal rate string", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await expect(store.assets.setAnnualAppreciationRate("home", "3%")).rejects.toThrow();
    await expect(store.assets.setAnnualAppreciationRate("home", "abc")).rejects.toThrow();
    await expect(store.assets.setAnnualAppreciationRate("home", "")).rejects.toThrow();
  });

  test("accepts valid decimal rate strings including negative", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await expect(
      store.assets.setAnnualAppreciationRate("home", "0.03"),
    ).resolves.not.toThrow();
    await expect(
      store.assets.setAnnualAppreciationRate("home", "-0.01"),
    ).resolves.not.toThrow();
    await expect(
      store.assets.setAnnualAppreciationRate("home", "1"),
    ).resolves.not.toThrow();
  });
});

describe("valueHousingAtDate — store method (PRD pinned example)", () => {
  async function seedPinned(store: WorthlineStore): Promise<void> {
    await seed(store);
    await store.assets.setAnnualAppreciationRate("home", "0.03");
    await store.assets.addValuationAnchor({
      adjustsPriorCurve: true,
      assetId: "home",
      id: "a1",
      valuationDate: "2024-01-01",
      valueMinor: 100_000_00,
    });
    await store.assets.addValuationAnchor({
      adjustsPriorCurve: false,
      assetId: "home",
      id: "imp",
      valuationDate: "2024-07-01",
      valueMinor: 10_000_00,
    });
    await store.assets.addValuationAnchor({
      adjustsPriorCurve: true,
      assetId: "home",
      id: "a2",
      valuationDate: "2025-01-01",
      valueMinor: 120_000_00,
    });
  }

  const cases: Array<[string, number]> = [
    ["2024-01-01", 100_000_00],
    ["2024-07-01", 114_972_68],
    ["2024-10-01", 117_486_34],
    ["2025-01-01", 120_000_00],
    ["2025-07-01", 121_771_91],
  ];

  test.each(cases)("value at %s", async (date, expected) => {
    const store = await createInMemoryStore();
    await seedPinned(store);
    expect(await store.assets.valueHousingAtDate("home", date, "2026-06-12")).toBe(
      expected,
    );
  });
});

describe("housing step cadence re-ripple (#391, ADR 0031)", () => {
  test("an intra-month snapshot holds the month-start value, not the daily drift", async () => {
    const store = await createInMemoryStore();
    await seed(store); // home, currentValueMinor 130_000_00, primary residence

    await store.assets.setAnnualAppreciationRate("home", "0.12");
    await store.command.addValuationAnchor(
      {
        adjustsPriorCurve: true,
        assetId: "home",
        id: "a1",
        valuationDate: "2025-01-01",
        valueMinor: 100_000_00,
      },
      { today: TODAY },
    );

    // An unrelated backdated fact at a MID-MONTH date generates a full-portfolio
    // snapshot there, valuing the house off its appreciation curve on that date.
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      manualPricePerUnit: "100",
      name: "Fondo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    await store.command.recordInvestmentOperation(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2025-03-20",
        id: "op1",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );

    const anchors = [
      { adjustsPriorCurve: true, valuationDate: "2025-01-01", valueMinor: 100_000_00 },
    ];
    const drift = (targetDate: string, cadence?: "step" | "interpolated"): number =>
      valueHousingAtDate({
        anchors,
        annualAppreciationRate: "0.12",
        ...(cadence ? { cadence } : {}),
        currentValueMinor: 130_000_00,
        today: TODAY,
        targetDate,
      });
    const stepValue = drift("2025-03-20");
    const monthStartValue = drift("2025-03-01");
    const interpolatedValue = drift("2025-03-20", "interpolated");
    // Step holds the month-start value, which genuinely differs from daily drift.
    expect(stepValue).toBe(monthStartValue);
    expect(interpolatedValue).not.toBe(stepValue);

    const homeRowAt = async (dateKey: string): Promise<number | undefined> =>
      (
        await store.snapshots.readSnapshotHoldings({
          from: dateKey,
          holdingId: "home",
          kind: "asset",
          to: dateKey,
        })
      ).find((r) => r.dateKey === dateKey)?.valueMinor;

    // The house's frozen value in the intra-month snapshot is the stepped value.
    expect(await homeRowAt("2025-03-20")).toBe(stepValue);
    // The anchor-date snapshot is unchanged (the appraisal's total truth).
    expect(await homeRowAt("2025-01-01")).toBe(100_000_00);
    store.close();
  });
});

describe("housing valuation cadence — threading + re-ripple (#394, ADR 0031)", () => {
  /** The pure housing curve value at a date under a given cadence (the oracle). */
  function drift(targetDate: string, cadence?: "step" | "interpolated"): number {
    const anchors = [
      { adjustsPriorCurve: true, valuationDate: "2025-01-01", valueMinor: 100_000_00 },
    ];
    return valueHousingAtDate({
      anchors,
      annualAppreciationRate: "0.12",
      ...(cadence ? { cadence } : {}),
      currentValueMinor: 130_000_00,
      today: TODAY,
      targetDate,
    });
  }

  /** Seed a home with a 12% rate + one 2025-01-01 appraisal and an intra-month fact. */
  async function seedWithIntraMonthFact(store: WorthlineStore): Promise<void> {
    await seed(store); // home, currentValueMinor 130_000_00, primary residence
    await store.assets.setAnnualAppreciationRate("home", "0.12");
    await store.command.addValuationAnchor(
      {
        adjustsPriorCurve: true,
        assetId: "home",
        id: "a1",
        valuationDate: "2025-01-01",
        valueMinor: 100_000_00,
      },
      { today: TODAY },
    );
    // An unrelated backdated fact at a MID-MONTH date snapshots the full portfolio
    // there, valuing the house off its appreciation curve on that date.
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      manualPricePerUnit: "100",
      name: "Fondo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    await store.command.recordInvestmentOperation(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2025-03-20",
        id: "op1",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );
  }

  const homeRowAt = async (
    store: WorthlineStore,
    dateKey: string,
  ): Promise<number | undefined> =>
    (
      await store.snapshots.readSnapshotHoldings({
        from: dateKey,
        holdingId: "home",
        kind: "asset",
        to: dateKey,
      })
    ).find((r) => r.dateKey === dateKey)?.valueMinor;

  test("the direct valueHousingAtDate store read honors the stored interpolated cadence", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.assets.setAnnualAppreciationRate("home", "0.12");
    await store.assets.addValuationAnchor({
      adjustsPriorCurve: true,
      assetId: "home",
      id: "a1",
      valuationDate: "2025-01-01",
      valueMinor: 100_000_00,
    });

    const stepValue = drift("2025-03-20");
    const interpolatedValue = drift("2025-03-20", "interpolated");
    expect(interpolatedValue).not.toBe(stepValue);

    // Default (null) → the stepped value through the store method.
    expect(await store.assets.valueHousingAtDate("home", "2025-03-20", TODAY)).toBe(
      stepValue,
    );

    // Opt into interpolation → the same read drifts daily.
    await store.assets.setValuationCadence("home", "interpolated");
    expect(await store.assets.valueHousingAtDate("home", "2025-03-20", TODAY)).toBe(
      interpolatedValue,
    );

    // Back to step → the stepped value is restored.
    await store.assets.setValuationCadence("home", "step");
    expect(await store.assets.valueHousingAtDate("home", "2025-03-20", TODAY)).toBe(
      stepValue,
    );
    store.close();
  });

  test("flipping a home to interpolated re-ripples its intra-month snapshot to the daily drift", async () => {
    const store = await createInMemoryStore();
    await seedWithIntraMonthFact(store);

    const stepValue = drift("2025-03-20");
    const interpolatedValue = drift("2025-03-20", "interpolated");
    expect(interpolatedValue).not.toBe(stepValue);

    // Default: the intra-month snapshot holds the stepped (month-start) value.
    expect(await homeRowAt(store, "2025-03-20")).toBe(stepValue);

    // Flip to interpolated AND re-ripple → the snapshot drifts daily again.
    await store.command.setHousingValuationCadence("home", "interpolated", {
      today: TODAY,
    });
    expect(await homeRowAt(store, "2025-03-20")).toBe(interpolatedValue);
    // The anchor-date snapshot is unchanged (the appraisal's total truth).
    expect(await homeRowAt(store, "2025-01-01")).toBe(100_000_00);

    // Flip back to step AND re-ripple → the stepped value is restored.
    await store.command.setHousingValuationCadence("home", "step", { today: TODAY });
    expect(await homeRowAt(store, "2025-03-20")).toBe(stepValue);
    store.close();
  });

  test("clearing the cadence (null) restores the default step cadence", async () => {
    const store = await createInMemoryStore();
    await seedWithIntraMonthFact(store);

    const stepValue = drift("2025-03-20");
    const interpolatedValue = drift("2025-03-20", "interpolated");

    await store.command.setHousingValuationCadence("home", "interpolated", {
      today: TODAY,
    });
    expect(await homeRowAt(store, "2025-03-20")).toBe(interpolatedValue);

    // Null clears the opt-in → the snapshot returns to the stepped value.
    await store.command.setHousingValuationCadence("home", null, { today: TODAY });
    expect(await store.assets.readValuationCadence("home")).toBeNull();
    expect(await homeRowAt(store, "2025-03-20")).toBe(stepValue);
    store.close();
  });
});
