import type { ContributionPlan } from "@worthline/domain";
import { computeMonthlyContributionAllocation } from "@worthline/domain";
import { describe, expect, test } from "vitest";

const PLAN: ContributionPlan = {
  scopeId: "default",
  contributions: [
    {
      id: "c1",
      destinationHoldingId: "h1",
      amount: { mode: "money", value: 300_00 },
      cadence: { kind: "monthly", dayOfMonth: 1 },
      startDate: "2026-01-01",
    },
  ],
};

// The MCP allocation reads the SAME seam /objetivos renders (PRD #553 S3) —
// this pins the builder's input contract to that shared derivation.
describe("contribution plan monthly allocation seam", () => {
  test("a monthly contribution yields one July occurrence in the allocation", () => {
    const allocation = computeMonthlyContributionAllocation({
      plan: PLAN,
      monthKey: "2026-07",
      today: "2026-07-05",
    });

    expect(allocation.monthKey).toBe("2026-07");
    expect(allocation.occurrenceCount).toBe(1);
    expect(allocation.totalPlannedMinor).toBe(300_00);
    expect(allocation.destinations).toEqual([
      {
        holdingId: "h1",
        occurrenceCount: 1,
        plannedMinor: 300_00,
        plannedUnits: null,
        executedMinor: 0,
        closedCount: 0,
      },
    ]);
  });

  test("an unpriced units destination is reported, never guessed or dropped", () => {
    const allocation = computeMonthlyContributionAllocation({
      plan: {
        scopeId: "default",
        contributions: [
          ...PLAN.contributions,
          {
            id: "c2",
            destinationHoldingId: "h2",
            amount: { mode: "units", value: "1" },
            cadence: { kind: "monthly", dayOfMonth: 1 },
            startDate: "2026-01-01",
          },
        ],
      },
      monthKey: "2026-07",
      today: "2026-07-05",
    });

    expect(allocation.unpricedHoldingIds).toEqual(["h2"]);
    expect(allocation.totalPlannedMinor).toBe(300_00);
    const unpriced = allocation.destinations.find((d) => d.holdingId === "h2");
    expect(unpriced?.plannedMinor).toBeNull();
    expect(unpriced?.plannedUnits).toBe("1");
  });
});
