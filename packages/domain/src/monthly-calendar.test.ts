/**
 * The shared monthly grid (#1444) — the arithmetic both backfills ride.
 */

import { describe, expect, it } from "vitest";
import { monthlyDateKeys, monthStart, nextMonthStart } from "./monthly-calendar";

describe("monthStart", () => {
  it("snaps any day of a month to its 1st", () => {
    expect(monthStart("2026-03-19")).toBe("2026-03-01");
    expect(monthStart("2026-03-01")).toBe("2026-03-01");
  });
});

describe("nextMonthStart", () => {
  it("advances one month, rolling the year over December", () => {
    expect(nextMonthStart("2026-03-01")).toBe("2026-04-01");
    expect(nextMonthStart("2026-09-01")).toBe("2026-10-01");
    expect(nextMonthStart("2026-12-01")).toBe("2027-01-01");
  });
});

describe("monthlyDateKeys", () => {
  it("runs from the month containing `fromDate` THROUGH the bound, inclusive", () => {
    expect(monthlyDateKeys("2026-01-10", "2026-03-01")).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ]);
  });

  it("stops before a bound that falls mid-month", () => {
    expect(monthlyDateKeys("2026-01-10", "2026-02-28")).toEqual([
      "2026-01-01",
      "2026-02-01",
    ]);
  });

  it("crosses a year boundary", () => {
    expect(monthlyDateKeys("2026-11-30", "2027-01-15")).toEqual([
      "2026-11-01",
      "2026-12-01",
      "2027-01-01",
    ]);
  });

  it("is empty when the bound precedes the starting month", () => {
    expect(monthlyDateKeys("2026-05-10", "2026-04-30")).toEqual([]);
  });
});
