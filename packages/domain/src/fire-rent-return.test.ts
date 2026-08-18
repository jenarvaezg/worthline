/**
 * The rent-derived FIRE return (#1448). Jorge's case is the spine of this suite:
 * four flats worth 370.000 € with ~23.500 €/año of declared rent, priced by the
 * housing rung at a flat 3 % — the cheapest default landing on 68 % of his pool.
 */
import { describe, expect, it } from "vitest";

import {
  annualizedMinor,
  deriveRentRealReturns,
  isScheduleLiveOn,
} from "./fire-rent-return";
import type { PayoutCadence, PayoutSchedule } from "./payouts";
import type { ManualAsset } from "./workspace-types";

const TODAY = "2026-08-18";
const EUR = "EUR" as const;

function flat(
  id: string,
  valueMinor: number,
  over: Partial<ManualAsset> = {},
): ManualAsset {
  return {
    currency: "EUR",
    currentValue: { amountMinor: valueMinor, currency: "EUR" },
    id,
    instrument: "property",
    isPrimaryResidence: false,
    liquidityTier: "illiquid",
    name: id,
    ownership: [{ memberId: "jorge", shareBps: 10_000 }],
    type: "real_estate",
    ...over,
  };
}

function schedule(
  id: string,
  holdingId: string,
  over: Partial<PayoutSchedule> = {},
): PayoutSchedule {
  return {
    amountMinor: 100_000,
    cadence: "monthly" as PayoutCadence,
    endISO: null,
    exclusions: [],
    holdingId,
    id,
    label: "Alquiler",
    startISO: "2024-01-01",
    ...over,
  };
}

describe("annualizedMinor", () => {
  it("scales each cadence to a year", () => {
    expect(annualizedMinor(100, "monthly")).toBe(1_200);
    expect(annualizedMinor(100, "quarterly")).toBe(400);
    expect(annualizedMinor(100, "annual")).toBe(100);
    // 52 weeks, not 52,18 — an approximation, and the only one in the module.
    expect(annualizedMinor(100, "weekly")).toBe(5_200);
  });
});

describe("isScheduleLiveOn", () => {
  it("a rent that ends next month still pays today", () => {
    expect(
      isScheduleLiveOn({ endISO: "2026-09-01", startISO: "2020-01-01" }, TODAY),
    ).toBe(true);
  });

  it("an ended rent is not income any more", () => {
    expect(
      isScheduleLiveOn({ endISO: "2026-07-31", startISO: "2020-01-01" }, TODAY),
    ).toBe(false);
  });

  it("its last day is inclusive", () => {
    expect(isScheduleLiveOn({ endISO: TODAY, startISO: "2020-01-01" }, TODAY)).toBe(true);
  });

  it("a rent that has not started is not income yet", () => {
    expect(isScheduleLiveOn({ endISO: null, startISO: "2026-12-01" }, TODAY)).toBe(false);
  });
});

describe("deriveRentRealReturns", () => {
  it("net rent over value replaces the tier default", () => {
    // 1.000 €/mes rent, 250 €/mes of costs, on a 200.000 € flat → 9.000 €/año → 4,5 %.
    const result = deriveRentRealReturns({
      assets: [flat("piso", 20_000_000)],
      baseCurrency: EUR,
      schedules: [
        schedule("s1", "piso", { amountMinor: 100_000, expensesMinor: 25_000 }),
      ],
      todayISO: TODAY,
    });

    const derived = result.byAssetId.get("piso");
    expect(derived?.rate).toBeCloseTo(0.045, 10);
    expect(derived?.annualGrossRentMinor).toBe(1_200_000);
    expect(derived?.annualExpensesMinor).toBe(300_000);
    expect(derived?.annualNetRentMinor).toBe(900_000);
    expect(derived?.isNetNegative).toBe(false);
    expect(derived?.scheduleIds).toEqual(["s1"]);
    expect(result.notices).toEqual([]);
  });

  it("declared expenses of 0 derive: 'this costs me nothing' is a statement", () => {
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [schedule("s1", "piso", { amountMinor: 50_000, expensesMinor: 0 })],
      todayISO: TODAY,
    });

    expect(result.byAssetId.get("piso")?.rate).toBeCloseTo(0.06, 10);
    expect(result.notices).toEqual([]);
  });

  it("several live schedules on one property sum, each at its own cadence", () => {
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [
        schedule("s1", "piso", { amountMinor: 50_000, expensesMinor: 10_000 }),
        schedule("s2", "piso", {
          amountMinor: 60_000,
          cadence: "quarterly",
          expensesMinor: 10_000,
        }),
      ],
      todayISO: TODAY,
    });

    // (500−100)×12 + (600−100)×4 = 4.800 + 2.000 = 6.800 €/año over 100.000 €.
    expect(result.byAssetId.get("piso")?.annualNetRentMinor).toBe(680_000);
    expect(result.byAssetId.get("piso")?.rate).toBeCloseTo(0.068, 10);
  });

  it("exclusions do not lower the rate: a schedule declares the recurrence, not the past", () => {
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [
        schedule("s1", "piso", {
          amountMinor: 50_000,
          exclusions: ["2026-03-01", "2026-04-01"],
          expensesMinor: 10_000,
        }),
      ],
      todayISO: TODAY,
    });

    expect(result.byAssetId.get("piso")?.annualNetRentMinor).toBe(480_000);
  });

  // ── the guards ────────────────────────────────────────────────────────────────

  it("no declared expenses → no rate and a notice carrying the gross it withheld", () => {
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [schedule("s1", "piso", { amountMinor: 50_000 })],
      todayISO: TODAY,
    });

    expect(result.byAssetId.size).toBe(0);
    expect(result.notices).toEqual([
      { assetId: "piso", assetName: "piso", grossRate: 0.06, reason: "missing_expenses" },
    ]);
  });

  it("expenses declared on one of two live schedules is still 'no rate'", () => {
    // Netting only the half that declares costs understates them — the flattering
    // direction, which is exactly what this issue closes.
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [
        schedule("s1", "piso", { amountMinor: 50_000, expensesMinor: 10_000 }),
        schedule("s2", "piso", { amountMinor: 20_000 }),
      ],
      todayISO: TODAY,
    });

    expect(result.byAssetId.size).toBe(0);
    expect(result.notices[0]?.reason).toBe("missing_expenses");
  });

  it("an ended rent does not feed the rate, and says so", () => {
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [
        schedule("s1", "piso", {
          amountMinor: 50_000,
          endISO: "2026-07-31",
          expensesMinor: 10_000,
        }),
      ],
      todayISO: TODAY,
    });

    expect(result.byAssetId.size).toBe(0);
    expect(result.notices).toEqual([
      { assetId: "piso", assetName: "piso", grossRate: null, reason: "no_live_schedule" },
    ]);
  });

  it("a rent that ends next month still counts today", () => {
    const result = deriveRentRealReturns({
      assets: [flat("navalcarnero", 10_000_000)],
      baseCurrency: EUR,
      schedules: [
        schedule("s1", "navalcarnero", {
          amountMinor: 50_000,
          endISO: "2026-09-01",
          expensesMinor: 10_000,
        }),
      ],
      todayISO: TODAY,
    });

    expect(result.byAssetId.get("navalcarnero")?.rate).toBeCloseTo(0.048, 10);
  });

  it("costs above the rent apply as a negative yield, flagged not hidden", () => {
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [schedule("s1", "piso", { amountMinor: 50_000, expensesMinor: 60_000 })],
      todayISO: TODAY,
    });

    const derived = result.byAssetId.get("piso");
    expect(derived?.rate).toBeCloseTo(-0.012, 10);
    expect(derived?.isNetNegative).toBe(true);
  });

  it("a property valued in another currency is left alone (payouts carry none)", () => {
    const result = deriveRentRealReturns({
      assets: [
        flat("miami", 10_000_000, {
          currency: "USD",
          currentValue: { amountMinor: 10_000_000, currency: "USD" },
        }),
      ],
      baseCurrency: EUR,
      schedules: [
        schedule("s1", "miami", { amountMinor: 50_000, expensesMinor: 10_000 }),
      ],
      todayISO: TODAY,
    });

    expect(result.byAssetId.size).toBe(0);
    expect(result.notices[0]?.reason).toBe("foreign_currency");
  });

  it("a fund's declared dividend never replaces the market rate — silently", () => {
    // A dividend is a fraction of a fund's total return, not the whole of it, and a
    // deposit's interest is nominal. Nothing is withheld from the user here: the
    // tier rate is the right answer, so there is nothing to warn about.
    const fund: ManualAsset = {
      currency: "EUR",
      currentValue: { amountMinor: 10_000_000, currency: "EUR" },
      id: "fondo",
      instrument: "fund",
      isPrimaryResidence: false,
      liquidityTier: "market",
      name: "Fondo",
      ownership: [{ memberId: "jorge", shareBps: 10_000 }],
      type: "investment",
    };

    const result = deriveRentRealReturns({
      assets: [fund],
      baseCurrency: EUR,
      schedules: [schedule("s1", "fondo", { amountMinor: 20_000, expensesMinor: 0 })],
      todayISO: TODAY,
    });

    expect(result.byAssetId.size).toBe(0);
    expect(result.notices).toEqual([]);
  });

  it("a property with no value carries no weight, so it is skipped silently", () => {
    const result = deriveRentRealReturns({
      assets: [flat("sinvalor", 0)],
      baseCurrency: EUR,
      schedules: [
        schedule("s1", "sinvalor", { amountMinor: 50_000, expensesMinor: 10_000 }),
      ],
      todayISO: TODAY,
    });

    expect(result.byAssetId.size).toBe(0);
    expect(result.notices).toEqual([]);
  });

  it("a property with no declared schedule is not a candidate at all", () => {
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [],
      todayISO: TODAY,
    });

    expect(result.byAssetId.size).toBe(0);
    expect(result.notices).toEqual([]);
  });

  it("the rate is share-invariant: rent and value are both declared at 100 %", () => {
    const rented = [
      schedule("s1", "piso", { amountMinor: 50_000, expensesMinor: 10_000 }),
    ];
    const half = deriveRentRealReturns({
      assets: [
        flat("piso", 10_000_000, { ownership: [{ memberId: "jorge", shareBps: 5_000 }] }),
      ],
      baseCurrency: EUR,
      schedules: rented,
      todayISO: TODAY,
    });
    const whole = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: rented,
      todayISO: TODAY,
    });

    expect(half.byAssetId.get("piso")?.rate).toBe(whole.byAssetId.get("piso")?.rate);
  });
});
