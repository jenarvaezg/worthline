import type { ContributionPlan } from "@worthline/domain";
import { expandContributionPlan } from "@worthline/domain";
import { describe, expect, test } from "vitest";

function monthBounds(month: string): { from: string; to: string } {
  const [yearRaw, monthRaw] = month.split("-");
  const year = Number(yearRaw);
  const mon = Number(monthRaw);
  const from = `${month}-01`;
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const to = `${month}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

describe("contribution plan monthly allocation seam", () => {
  test("a monthly contribution yields one July occurrence in the allocation window", () => {
    const plan: ContributionPlan = {
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

    const { from, to } = monthBounds("2026-07");
    const occurrences = expandContributionPlan(plan, from, to);

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.plannedDate).toBe("2026-07-01");
    expect(occurrences[0]?.amount).toEqual({ mode: "money", value: 300_00 });
  });
});
