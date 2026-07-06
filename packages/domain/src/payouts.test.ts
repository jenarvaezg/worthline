import { describe, expect, test } from "vitest";

import {
  collectHoldingPayouts,
  deriveScheduleOccurrences,
  passiveIncomeTrailing,
  type Payout,
  type PayoutSchedule,
} from "./payouts";

/**
 * Payout schedules derive their past occurrences as truth (ADR 0054), following
 * the amortization-plan precedent: end date inclusive, nothing derived beyond
 * today, exclusions drop single dates, a retroactive end kills the tail. Amounts
 * are integer minor units. These assertions pin those rules.
 */

function schedule(overrides: Partial<PayoutSchedule> = {}): PayoutSchedule {
  return {
    id: "s1",
    holdingId: "h1",
    label: "Alquiler",
    amountMinor: 100000,
    cadence: "monthly",
    startISO: "2025-01-15",
    endISO: null,
    exclusions: [],
    ...overrides,
  };
}

describe("deriveScheduleOccurrences", () => {
  test("monthly: from start up to and including today", () => {
    const occ = deriveScheduleOccurrences(schedule(), "2025-04-20");
    expect(occ.map((o) => o.dateISO)).toEqual([
      "2025-01-15",
      "2025-02-15",
      "2025-03-15",
      "2025-04-15",
    ]);
    expect(occ.every((o) => o.amountMinor === 100000)).toBe(true);
    expect(occ[0]).toMatchObject({
      scheduleId: "s1",
      holdingId: "h1",
      label: "Alquiler",
    });
  });

  test("start date itself is included (inclusive)", () => {
    const occ = deriveScheduleOccurrences(schedule(), "2025-01-15");
    expect(occ.map((o) => o.dateISO)).toEqual(["2025-01-15"]);
  });

  test("nothing is derived beyond today, even with no end", () => {
    const occ = deriveScheduleOccurrences(schedule(), "2025-03-20");
    expect(occ.map((o) => o.dateISO)).toEqual(["2025-01-15", "2025-02-15", "2025-03-15"]);
  });

  test("end date is inclusive and stops the series", () => {
    const occ = deriveScheduleOccurrences(
      schedule({ endISO: "2025-03-15" }),
      "2025-12-31",
    );
    expect(occ.map((o) => o.dateISO)).toEqual(["2025-01-15", "2025-02-15", "2025-03-15"]);
  });

  test("retroactive end kills the tail in one edit", () => {
    const withTail = deriveScheduleOccurrences(schedule(), "2025-06-20");
    expect(withTail).toHaveLength(6);
    const ended = deriveScheduleOccurrences(
      schedule({ endISO: "2025-03-15" }),
      "2025-06-20",
    );
    expect(ended.map((o) => o.dateISO)).toEqual([
      "2025-01-15",
      "2025-02-15",
      "2025-03-15",
    ]);
  });

  test("exclusions drop single occurrences without splitting the series", () => {
    const occ = deriveScheduleOccurrences(
      schedule({ exclusions: ["2025-02-15"] }),
      "2025-04-20",
    );
    expect(occ.map((o) => o.dateISO)).toEqual(["2025-01-15", "2025-03-15", "2025-04-15"]);
  });

  test("monthly clamps to the last day of shorter months", () => {
    const occ = deriveScheduleOccurrences(
      schedule({ startISO: "2025-01-31" }),
      "2025-05-01",
    );
    expect(occ.map((o) => o.dateISO)).toEqual([
      "2025-01-31",
      "2025-02-28",
      "2025-03-31",
      "2025-04-30",
    ]);
  });

  test("monthly clamp lands on leap-February then recovers to the 31st (no drift)", () => {
    const occ = deriveScheduleOccurrences(
      schedule({ startISO: "2024-01-31" }),
      "2024-04-15",
    );
    expect(occ.map((o) => o.dateISO)).toEqual(["2024-01-31", "2024-02-29", "2024-03-31"]);
  });

  test("quarterly steps by three months", () => {
    const occ = deriveScheduleOccurrences(
      schedule({ cadence: "quarterly", startISO: "2024-06-01" }),
      "2025-07-01",
    );
    expect(occ.map((o) => o.dateISO)).toEqual([
      "2024-06-01",
      "2024-09-01",
      "2024-12-01",
      "2025-03-01",
      "2025-06-01",
    ]);
  });

  test("annual steps by twelve months", () => {
    const occ = deriveScheduleOccurrences(
      schedule({ cadence: "annual", startISO: "2020-03-01" }),
      "2023-01-01",
    );
    expect(occ.map((o) => o.dateISO)).toEqual(["2020-03-01", "2021-03-01", "2022-03-01"]);
  });

  test("weekly steps by seven days", () => {
    const occ = deriveScheduleOccurrences(
      schedule({ cadence: "weekly", startISO: "2025-01-01" }),
      "2025-01-20",
    );
    expect(occ.map((o) => o.dateISO)).toEqual(["2025-01-01", "2025-01-08", "2025-01-15"]);
  });

  test("a start in the future yields nothing", () => {
    const occ = deriveScheduleOccurrences(
      schedule({ startISO: "2026-01-01" }),
      "2025-06-01",
    );
    expect(occ).toEqual([]);
  });
});

describe("passiveIncomeTrailing", () => {
  const rows = [
    { dateISO: "2024-12-31", amountMinor: 5000 }, // just before window
    { dateISO: "2025-01-01", amountMinor: 10000 }, // on the boundary (excluded)
    { dateISO: "2025-06-15", amountMinor: 20000 }, // in window
    { dateISO: "2026-01-01", amountMinor: 30000 }, // on today (included)
  ];

  test("sums payouts in the trailing window ending today (exclusive lower, inclusive upper)", () => {
    const result = passiveIncomeTrailing(rows, "2026-01-01", 12);
    expect(result.windowStartISO).toBe("2025-01-01");
    expect(result.windowEndISO).toBe("2026-01-01");
    expect(result.totalMinor).toBe(20000 + 30000);
    expect(result.count).toBe(2);
  });

  test("defaults to a 12-month window", () => {
    const result = passiveIncomeTrailing(rows, "2026-01-01");
    expect(result.windowStartISO).toBe("2025-01-01");
  });

  test("empty input yields a zero total", () => {
    const result = passiveIncomeTrailing([], "2026-01-01");
    expect(result).toMatchObject({ totalMinor: 0, count: 0 });
  });
});

describe("collectHoldingPayouts", () => {
  const oneOff = (overrides: Partial<Payout> = {}): Payout => ({
    id: "p1",
    holdingId: "h1",
    dateISO: "2025-03-01",
    amountMinor: 50000,
    ...overrides,
  });

  test("groups one-offs and derived schedule occurrences by holding, up to today", () => {
    const byHolding = collectHoldingPayouts(
      [oneOff(), oneOff({ id: "p2", holdingId: "h2", dateISO: "2025-02-01" })],
      [schedule({ startISO: "2025-01-15" })], // h1 monthly
      "2025-03-20",
    );

    // h1: one-off + three derived occurrences (Jan 15, Feb 15, Mar 15).
    expect(byHolding.get("h1")).toEqual(
      expect.arrayContaining([
        { dateISO: "2025-03-01", amountMinor: 50000 },
        { dateISO: "2025-01-15", amountMinor: 100000 },
        { dateISO: "2025-02-15", amountMinor: 100000 },
        { dateISO: "2025-03-15", amountMinor: 100000 },
      ]),
    );
    expect(byHolding.get("h1")).toHaveLength(4);
    expect(byHolding.get("h2")).toEqual([{ dateISO: "2025-02-01", amountMinor: 50000 }]);
  });

  test("excludes one-offs dated after today (nothing beyond the terminal date)", () => {
    const byHolding = collectHoldingPayouts(
      [oneOff({ dateISO: "2025-12-31" })],
      [],
      "2025-03-20",
    );
    expect(byHolding.has("h1")).toBe(false);
  });
});
