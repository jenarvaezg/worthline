/**
 * The rent-derived FIRE return (#1448). Jorge's case is the spine of this suite:
 * four flats worth 370.000 € with ~23.500 €/año of declared rent, priced by the
 * housing rung at a flat 3 % — the cheapest default landing on 68 % of his pool.
 */
import { describe, expect, it } from "vitest";

import type { RentRealReturns, RentScheduleWindow } from "./fire-rent-return";
import {
  annualizedMinor,
  deriveRentRealReturns,
  effectivePostMandatoryTermPolicy,
  isScheduleLiveOn,
  isScheduleProjectedOn,
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

/**
 * The window off the first notice, narrowed through the reason that owns it — the
 * union deliberately makes `scheduleWindow` unreachable on any other reason. Null
 * says "that notice was not about the calendar", which is itself a failure worth
 * seeing when a test expects dates.
 */
function firstNoticeWindow(result: RentRealReturns): RentScheduleWindow | null {
  const notice = result.notices[0];
  return notice?.reason === "no_live_schedule" ? notice.scheduleWindow : null;
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
    // Exact shape on purpose: the window belongs to `no_live_schedule` alone, so no
    // stray date field travels with a reason that is not about the calendar.
    expect(result.notices).toEqual([
      {
        assetId: "piso",
        assetName: "piso",
        grossRate: 0.06,
        reason: "missing_expenses",
      },
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
      {
        assetId: "piso",
        assetName: "piso",
        grossRate: null,
        reason: "no_live_schedule",
        scheduleWindow: { endedOnISO: "2026-07-31", startsOnISO: null },
      },
    ]);
  });

  it("a rent that has not started yet reports its start, not an ending", () => {
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [
        schedule("s1", "piso", {
          amountMinor: 50_000,
          expensesMinor: 10_000,
          startISO: "2027-01-01",
        }),
      ],
      todayISO: TODAY,
    });

    expect(firstNoticeWindow(result)).toEqual({
      endedOnISO: null,
      startsOnISO: "2027-01-01",
    });
  });

  it("an ended rent and a future one report both dates", () => {
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [
        schedule("s1", "piso", {
          amountMinor: 50_000,
          endISO: "2026-07-31",
          expensesMinor: 10_000,
        }),
        schedule("s2", "piso", {
          amountMinor: 60_000,
          expensesMinor: 10_000,
          startISO: "2026-10-01",
        }),
      ],
      todayISO: TODAY,
    });

    expect(firstNoticeWindow(result)).toEqual({
      endedOnISO: "2026-07-31",
      startsOnISO: "2026-10-01",
    });
  });

  it("keeps the most recent ending and the nearest start, not the first it sees", () => {
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [
        schedule("s1", "piso", { endISO: "2024-12-31", startISO: "2024-01-01" }),
        schedule("s2", "piso", { endISO: "2026-06-30", startISO: "2025-01-01" }),
        schedule("s3", "piso", { startISO: "2028-01-01" }),
        schedule("s4", "piso", { startISO: "2026-12-01" }),
      ],
      todayISO: TODAY,
    });

    expect(firstNoticeWindow(result)).toEqual({
      endedOnISO: "2026-06-30",
      startsOnISO: "2026-12-01",
    });
  });

  it("a future rent's own end date is never read as an ending already passed", () => {
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      // Contradictory declaration (it ends before it starts): what matters is that
      // the window never claims the rent ended, because it never ran.
      schedules: [
        schedule("s1", "piso", { endISO: "2026-01-01", startISO: "2027-01-01" }),
      ],
      todayISO: TODAY,
    });

    expect(firstNoticeWindow(result)).toEqual({
      endedOnISO: null,
      startsOnISO: "2027-01-01",
    });
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

/**
 * The projection policy (#1521). Before it, an `endISO` in the past was the whole
 * answer: the flat went back to the housing rung's 3 % for ever, which is `stop`
 * assumed in silence. These tests pin the three declarations that can change that
 * and — first of all — that declaring NOTHING changes nothing.
 */
describe("effectivePostMandatoryTermPolicy", () => {
  it("nothing declared → stop, and it is reported as undeclared", () => {
    expect(effectivePostMandatoryTermPolicy(schedule("s1", "piso"))).toEqual({
      policy: "stop",
      source: "undeclared",
    });
  });

  it("a long-term residential regime alone implies renewal", () => {
    expect(
      effectivePostMandatoryTermPolicy(
        schedule("s1", "piso", { leaseRegime: "residential_long_term" }),
      ),
    ).toEqual({ policy: "renew_same_real_rent", source: "regime" });
  });

  it("a season's let and a holiday let end when their date says so", () => {
    for (const leaseRegime of ["seasonal", "vacation", "other"] as const) {
      expect(
        effectivePostMandatoryTermPolicy(schedule("s1", "piso", { leaseRegime })),
      ).toEqual({ policy: "stop", source: "regime" });
    }
  });

  it("an explicit policy overrides what the regime would imply, both ways", () => {
    expect(
      effectivePostMandatoryTermPolicy(
        schedule("s1", "piso", {
          leaseRegime: "residential_long_term",
          postMandatoryTermPolicy: "stop",
        }),
      ),
    ).toEqual({ policy: "stop", source: "declared" });
    expect(
      effectivePostMandatoryTermPolicy(
        schedule("s1", "piso", {
          leaseRegime: "seasonal",
          postMandatoryTermPolicy: "renew_same_real_rent",
        }),
      ),
    ).toEqual({ policy: "renew_same_real_rent", source: "declared" });
  });

  it("`unknown` is an absence of decision, so the regime still answers", () => {
    expect(
      effectivePostMandatoryTermPolicy(
        schedule("s1", "piso", {
          leaseRegime: "residential_long_term",
          postMandatoryTermPolicy: "unknown",
        }),
      ),
    ).toEqual({ policy: "renew_same_real_rent", source: "regime" });
    expect(
      effectivePostMandatoryTermPolicy(
        schedule("s1", "piso", { postMandatoryTermPolicy: "unknown" }),
      ),
    ).toEqual({ policy: "stop", source: "undeclared" });
  });
});

describe("isScheduleProjectedOn", () => {
  it("an ended rent with no declaration stops, exactly as before #1521", () => {
    const ended = schedule("s1", "piso", { endISO: "2026-07-31" });
    expect(isScheduleProjectedOn(ended, TODAY)).toBe(false);
    expect(isScheduleLiveOn(ended, TODAY)).toBe(false);
  });

  it("an ended long-term residential rent keeps projecting", () => {
    const ended = schedule("s1", "piso", {
      endISO: "2026-07-31",
      leaseRegime: "residential_long_term",
    });
    expect(isScheduleProjectedOn(ended, TODAY)).toBe(true);
    // The window itself did not move: the rate reads the policy, the payout
    // derivation still reads the window (ADR 0054 point 4).
    expect(isScheduleLiveOn(ended, TODAY)).toBe(false);
  });

  it("a rent that has not started yet never projects, whatever its policy", () => {
    expect(
      isScheduleProjectedOn(
        schedule("s1", "piso", {
          startISO: "2027-01-01",
          leaseRegime: "residential_long_term",
          postMandatoryTermPolicy: "renew_same_real_rent",
        }),
        TODAY,
      ),
    ).toBe(false);
  });
});

describe("deriveRentRealReturns · projection policy (#1521)", () => {
  it("declaring nothing changes no figure: an ended rent still falls back", () => {
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
    expect(result.notices[0]?.reason).toBe("no_live_schedule");
  });

  it("an ended rent declared as renewing keeps feeding the rate", () => {
    // 600 €/mes brutos − 100 €/mes de gastos = 6.000 €/año sobre 100.000 € → 6 %.
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [
        schedule("s1", "piso", {
          amountMinor: 60_000,
          endISO: "2026-07-31",
          expensesMinor: 10_000,
          leaseRegime: "residential_long_term",
          postMandatoryTermPolicy: "renew_same_real_rent",
        }),
      ],
      todayISO: TODAY,
    });

    const derived = result.byAssetId.get("piso");
    expect(derived?.rate).toBeCloseTo(0.06, 10);
    expect(derived?.scheduleIds).toEqual(["s1"]);
    // The rate rests on a projection, and the row has to be able to say so — with
    // the provenance, because «lo has declarado» is a different sentence from «lo
    // implica el régimen».
    expect(derived?.projectedSchedules).toEqual([
      { scheduleId: "s1", policySource: "declared" },
    ]);
    expect(result.notices).toEqual([]);
  });

  it("a live rent is not a projection, so nothing is flagged as one", () => {
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [
        schedule("s1", "piso", {
          amountMinor: 50_000,
          expensesMinor: 10_000,
          leaseRegime: "residential_long_term",
        }),
      ],
      todayISO: TODAY,
    });

    expect(result.byAssetId.get("piso")?.projectedSchedules).toEqual([]);
  });

  it("a renewal implied by the regime alone is reported as the regime's, not the owner's", () => {
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [
        schedule("s1", "piso", {
          amountMinor: 60_000,
          endISO: "2026-07-31",
          expensesMinor: 10_000,
          leaseRegime: "residential_long_term",
        }),
      ],
      todayISO: TODAY,
    });

    expect(result.byAssetId.get("piso")?.projectedSchedules).toEqual([
      { scheduleId: "s1", policySource: "regime" },
    ]);
  });

  it("a seasonal let that ended stops even with the regime declared", () => {
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [
        schedule("s1", "piso", {
          amountMinor: 50_000,
          endISO: "2026-07-31",
          expensesMinor: 10_000,
          leaseRegime: "seasonal",
        }),
      ],
      todayISO: TODAY,
    });

    expect(result.byAssetId.size).toBe(0);
    expect(result.notices[0]?.reason).toBe("no_live_schedule");
  });

  it("all-or-nothing survives: a projected rent with no expenses withholds the asset", () => {
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [
        schedule("s1", "piso", { amountMinor: 50_000, expensesMinor: 10_000 }),
        schedule("s2", "piso", {
          amountMinor: 20_000,
          endISO: "2026-07-31",
          leaseRegime: "residential_long_term",
        }),
      ],
      todayISO: TODAY,
    });

    expect(result.byAssetId.size).toBe(0);
    expect(result.notices[0]?.reason).toBe("missing_expenses");
  });
});

describe("deriveRentRealReturns · rent revision (#1521)", () => {
  it("a legally revised rent is a real yield: it derives", () => {
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [
        schedule("s1", "piso", {
          amountMinor: 50_000,
          expensesMinor: 10_000,
          rentRevision: "legal_reference",
          rentRevisionReference: "IRAV",
        }),
      ],
      todayISO: TODAY,
    });

    expect(result.byAssetId.get("piso")?.rate).toBeCloseTo(0.048, 10);
    expect(result.notices).toEqual([]);
  });

  it("a contractually revised rent derives too", () => {
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [
        schedule("s1", "piso", {
          amountMinor: 50_000,
          expensesMinor: 10_000,
          rentRevision: "contractual",
        }),
      ],
      todayISO: TODAY,
    });

    expect(result.byAssetId.get("piso")?.rate).toBeCloseTo(0.048, 10);
  });

  it("a nominal rent refuses to be read as real: notice, tier default, no decay", () => {
    for (const rentRevision of ["fixed", "none"] as const) {
      const result = deriveRentRealReturns({
        assets: [flat("piso", 10_000_000)],
        baseCurrency: EUR,
        schedules: [
          schedule("s1", "piso", {
            amountMinor: 50_000,
            expensesMinor: 10_000,
            rentRevision,
          }),
        ],
        todayISO: TODAY,
      });

      expect(result.byAssetId.size).toBe(0);
      expect(result.notices).toEqual([
        {
          assetId: "piso",
          assetName: "piso",
          // 6.000 €/año brutos sobre 100.000 € → el 6 % que NO se está usando.
          grossRate: 0.06,
          reason: "nominal_rent_revision",
        },
      ]);
    }
  });

  it("one nominal rent takes the whole asset down (ADR 0076 point 3)", () => {
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [
        schedule("s1", "piso", {
          amountMinor: 50_000,
          expensesMinor: 10_000,
          rentRevision: "legal_reference",
        }),
        schedule("s2", "piso", {
          amountMinor: 10_000,
          expensesMinor: 0,
          rentRevision: "fixed",
        }),
      ],
      todayISO: TODAY,
    });

    expect(result.byAssetId.size).toBe(0);
    expect(result.notices[0]?.reason).toBe("nominal_rent_revision");
  });

  it("the nominal veto is read before the missing expenses, because it is the one that cannot be fixed by declaring them", () => {
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [schedule("s1", "piso", { amountMinor: 50_000, rentRevision: "fixed" })],
      todayISO: TODAY,
    });

    expect(result.notices[0]?.reason).toBe("nominal_rent_revision");
  });

  it("a nominal revision on a rent that is not counted at all says nothing new", () => {
    // Ended, no policy: the calendar answers first, and the revision of a rent that
    // feeds no rate is not a reason to withhold anything.
    const result = deriveRentRealReturns({
      assets: [flat("piso", 10_000_000)],
      baseCurrency: EUR,
      schedules: [
        schedule("s1", "piso", {
          amountMinor: 50_000,
          endISO: "2026-07-31",
          expensesMinor: 10_000,
          rentRevision: "fixed",
        }),
      ],
      todayISO: TODAY,
    });

    expect(result.notices[0]?.reason).toBe("no_live_schedule");
  });
});
