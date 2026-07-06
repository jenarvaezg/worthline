/**
 * Unit tests for the pure "Cobros" grid derivation + display maths (PRD #652 S1,
 * #656). Folds the winning S0 prototype (variant C2) onto the real domain: merges
 * one-off payouts with a schedule's derived occurrences (via the domain's
 * `deriveScheduleOccurrences`), groups by month, spans the year range, and computes
 * the non-saturating heatmap tint. No React.
 */

import type { Payout, PayoutSchedule } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  availableYears,
  buildCobroRows,
  heatAlpha,
  rowsByMonth,
  sumMinor,
} from "./cobros-view";

const TODAY = "2026-07-06";

const RENT: PayoutSchedule = {
  id: "sch-rent",
  holdingId: "h1",
  label: "Alquiler piso",
  amountMinor: 100000,
  cadence: "monthly",
  startISO: "2026-01-01",
  endISO: null,
  exclusions: ["2026-03-01"],
};

const DIVIDEND: Payout = {
  id: "o1",
  holdingId: "h1",
  dateISO: "2026-05-20",
  amountMinor: 34000,
  note: "Dividendo extraordinario",
};

describe("buildCobroRows", () => {
  test("merges one-offs with derived occurrences, newest first", () => {
    const rows = buildCobroRows([DIVIDEND], [RENT], TODAY);
    // Jan..Jul minus the March exclusion = 6 derived + 1 one-off = 7 rows.
    expect(rows).toHaveLength(7);
    expect(rows[0]?.dateISO).toBe("2026-07-01"); // newest first
    expect(rows.some((r) => r.dateISO === "2026-03-01")).toBe(false); // excluded
    const oneoff = rows.find((r) => r.kind === "oneoff");
    expect(oneoff).toMatchObject({ scheduleId: null, label: "Dividendo extraordinario" });
    const derived = rows.find((r) => r.kind === "derived");
    expect(derived).toMatchObject({ scheduleId: "sch-rent", label: "Alquiler piso" });
  });

  test("a one-off without a note carries an empty label", () => {
    const rows = buildCobroRows(
      [{ id: "o2", holdingId: "h1", dateISO: "2026-04-01", amountMinor: 500 }],
      [],
      TODAY,
    );
    expect(rows[0]?.label).toBe("");
  });
});

describe("rowsByMonth", () => {
  test("groups rows by their YYYY-MM key", () => {
    const map = rowsByMonth(buildCobroRows([DIVIDEND], [RENT], TODAY));
    expect(map.get("2026-05")).toHaveLength(2); // rent + dividend
    expect(map.get("2026-03")).toBeUndefined(); // excluded month
    expect(sumMinor(map.get("2026-05") ?? [])).toBe(134000);
  });
});

describe("availableYears", () => {
  test("spans from the earliest row year through the current year", () => {
    const rows = buildCobroRows(
      [{ id: "o", holdingId: "h1", dateISO: "2024-02-01", amountMinor: 100 }],
      [],
      TODAY,
    );
    expect(availableYears(rows, TODAY)).toEqual([2024, 2025, 2026]);
  });

  test("always includes the current year even with no rows", () => {
    expect(availableYears([], TODAY)).toEqual([2026]);
  });
});

describe("heatAlpha (non-saturating)", () => {
  test("zero value gets no tint", () => {
    expect(heatAlpha(0, 0, 100)).toBe(0);
  });

  test("a flat series (min==max) reads as a calm uniform light", () => {
    expect(heatAlpha(100, 100, 100)).toBe(0.16);
  });

  test("the norm stays light and the peak darkens within the range", () => {
    expect(heatAlpha(100, 100, 300)).toBeCloseTo(0.1, 6); // the min
    expect(heatAlpha(300, 100, 300)).toBeCloseTo(0.6, 6); // the peak
  });
});
