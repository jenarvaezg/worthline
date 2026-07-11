import { describe, expect, test } from "vitest";
import {
  allocationBarWidthPct,
  allocationMonthKeys,
  allocationMonthUrl,
  formatAllocationMonthLabel,
  groupAllocationByType,
  parseAllocationMonthParam,
} from "./contribution-allocation-view";

describe("allocationMonthKeys", () => {
  test("offers previous, current and two forward months", () => {
    expect(allocationMonthKeys("2026-07-11")).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
  });

  test("crosses year boundaries in both directions", () => {
    expect(allocationMonthKeys("2026-01-15")).toEqual([
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
    expect(allocationMonthKeys("2026-11-30")).toEqual([
      "2026-10",
      "2026-11",
      "2026-12",
      "2027-01",
    ]);
  });
});

describe("parseAllocationMonthParam", () => {
  const keys = ["2026-06", "2026-07", "2026-08", "2026-09"];

  test("accepts a month inside the window", () => {
    expect(parseAllocationMonthParam("2026-08", keys, "2026-07")).toBe("2026-08");
  });

  test("falls back to the default for absent, repeated or out-of-window values", () => {
    expect(parseAllocationMonthParam(undefined, keys, "2026-07")).toBe("2026-07");
    expect(parseAllocationMonthParam(["2026-08"], keys, "2026-07")).toBe("2026-07");
    expect(parseAllocationMonthParam("2027-01", keys, "2026-07")).toBe("2026-07");
    expect(parseAllocationMonthParam("nonsense", keys, "2026-07")).toBe("2026-07");
  });
});

describe("allocationMonthUrl", () => {
  test("mirrors a non-default month to ?mes= preserving other params", () => {
    expect(
      allocationMonthUrl("/objetivos?reconcile=c-1:2026-07-01", "2026-08", "2026-07"),
    ).toBe("/objetivos?reconcile=c-1%3A2026-07-01&mes=2026-08");
  });

  test("drops the param when returning to the default month", () => {
    expect(allocationMonthUrl("/objetivos?mes=2026-08", "2026-07", "2026-07")).toBe(
      "/objetivos",
    );
  });
});

describe("formatAllocationMonthLabel", () => {
  test("renders the Spanish month name and year", () => {
    expect(formatAllocationMonthLabel("2026-07")).toBe("julio 2026");
    expect(formatAllocationMonthLabel("2025-12")).toBe("diciembre 2025");
  });
});

describe("allocationBarWidthPct", () => {
  test("is the destination's share of the priced total, clamped to [0,100]", () => {
    expect(allocationBarWidthPct(25_000, 100_000)).toBe(25);
    expect(allocationBarWidthPct(100_000, 100_000)).toBe(100);
  });

  test("is zero for unpriced rows and empty totals", () => {
    expect(allocationBarWidthPct(null, 100_000)).toBe(0);
    expect(allocationBarWidthPct(25_000, 0)).toBe(0);
  });
});

describe("groupAllocationByType", () => {
  test("sums priced planned money per asset class with Spanish labels", () => {
    const groups = groupAllocationByType(
      [
        { holdingId: "a_fund", plannedMinor: 60_000 },
        { holdingId: "a_cash", plannedMinor: 30_000 },
        { holdingId: "a_fund2", plannedMinor: 10_000 },
        { holdingId: "a_unpriced", plannedMinor: null },
      ],
      {
        a_fund: "investment",
        a_cash: "cash",
        a_fund2: "investment",
        a_unpriced: "investment",
      },
    );

    expect(groups).toEqual([
      { type: "investment", label: "Inversión", plannedMinor: 70_000 },
      { type: "cash", label: "Efectivo", plannedMinor: 30_000 },
    ]);
  });

  test("returns no groups when nothing is priced", () => {
    expect(
      groupAllocationByType([{ holdingId: "x", plannedMinor: null }], { x: "cash" }),
    ).toEqual([]);
  });
});
