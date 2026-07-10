import { describe, expect, it } from "vitest";

import {
  type ContributionPlan,
  contributionOccurrenceId,
  derivedMonthlySavingsCapacity,
  expandContributionPlan,
  type PlannedContribution,
  resolveMonthlySavingsCapacityForFire,
} from "./contribution-plan";
import type { FireScopeConfig } from "./fire";

function contribution(overrides: Partial<PlannedContribution> = {}): PlannedContribution {
  return {
    id: "c1",
    destinationHoldingId: "h1",
    amount: { mode: "money", valueMinor: 100_000 },
    cadence: { kind: "monthly", dayOfMonth: 1 },
    startDate: "2025-01-01",
    ...overrides,
  };
}

function plan(
  contributions: PlannedContribution[],
  scopeId = "scope-1",
): ContributionPlan {
  return { scopeId, contributions };
}

describe("expandContributionPlan", () => {
  it("yields six monthly day-1 occurrences across a six-month window", () => {
    const occurrences = expandContributionPlan(
      plan([contribution()]),
      "2025-01-01",
      "2025-06-30",
    );
    expect(occurrences.map((o) => o.plannedDate)).toEqual([
      "2025-01-01",
      "2025-02-01",
      "2025-03-01",
      "2025-04-01",
      "2025-05-01",
      "2025-06-01",
    ]);
    expect(
      occurrences.every(
        (o) => o.amount.mode === "money" && o.amount.valueMinor === 100_000,
      ),
    ).toBe(true);
  });

  it("yields the right Mondays for a weekly-on-Monday contribution", () => {
    const occurrences = expandContributionPlan(
      plan([
        contribution({
          cadence: { kind: "weekly", weekday: 1 },
          startDate: "2025-01-01",
        }),
      ]),
      "2025-01-01",
      "2025-01-31",
    );
    expect(occurrences.map((o) => o.plannedDate)).toEqual([
      "2025-01-06",
      "2025-01-13",
      "2025-01-20",
      "2025-01-27",
    ]);
  });

  it("truncates at an inclusive end date", () => {
    const occurrences = expandContributionPlan(
      plan([contribution({ endDate: "2025-03-15" })]),
      "2025-01-01",
      "2025-12-31",
    );
    expect(occurrences.map((o) => o.plannedDate)).toEqual([
      "2025-01-01",
      "2025-02-01",
      "2025-03-01",
    ]);
  });

  it("re-expanding the same plan and window yields identical occurrence identities", () => {
    const input = plan([contribution({ id: "stable" })]);
    const first = expandContributionPlan(input, "2025-01-01", "2025-03-31");
    const second = expandContributionPlan(input, "2025-01-01", "2025-03-31");
    expect(first.map((o) => o.id)).toEqual(second.map((o) => o.id));
    expect(first.map((o) => o.id)).toEqual([
      contributionOccurrenceId("stable", "2025-01-01"),
      contributionOccurrenceId("stable", "2025-02-01"),
      contributionOccurrenceId("stable", "2025-03-01"),
    ]);
  });

  it("round-trips money and units amounts on occurrences", () => {
    const money = expandContributionPlan(
      plan([
        contribution({
          id: "money",
          amount: { mode: "money", valueMinor: 50_000 },
        }),
      ]),
      "2025-01-01",
      "2025-01-31",
    );
    expect(money[0]!.amount).toEqual({ mode: "money", valueMinor: 50_000 });

    const units = expandContributionPlan(
      plan([
        contribution({
          id: "units",
          amount: { mode: "units", value: "1.5" },
        }),
      ]),
      "2025-01-01",
      "2025-01-31",
    );
    expect(units[0]!.amount).toEqual({ mode: "units", value: "1.5" });
  });

  it("carries forecast facts only — no singular real-operation link", () => {
    const occurrence = expandContributionPlan(
      plan([contribution()]),
      "2025-01-01",
      "2025-01-31",
    )[0]!;
    expect(occurrence).toEqual({
      id: contributionOccurrenceId("c1", "2025-01-01"),
      contributionId: "c1",
      destinationHoldingId: "h1",
      plannedDate: "2025-01-01",
      amount: { mode: "money", valueMinor: 100_000 },
    });
    expect(occurrence).not.toHaveProperty("operationId");
  });
});

describe("derivedMonthlySavingsCapacity", () => {
  it("sums active contributions' monthly-equivalent money amounts", () => {
    const capacity = derivedMonthlySavingsCapacity(
      plan([
        contribution({
          id: "monthly",
          amount: { mode: "money", valueMinor: 300_000 },
          cadence: { kind: "monthly", dayOfMonth: 1 },
        }),
        contribution({
          id: "weekly",
          amount: { mode: "money", valueMinor: 100_000 },
          cadence: { kind: "weekly", weekday: 1 },
          startDate: "2025-01-06",
        }),
      ]),
      "2025-06-01",
    );
    expect(capacity).toBe(300_000 + Math.round((100_000 * 52) / 12));
  });

  it("falls back to the manual scalar when the plan is empty", () => {
    expect(derivedMonthlySavingsCapacity(plan([]), "2025-06-01", 250_000)).toBe(250_000);
    expect(derivedMonthlySavingsCapacity(plan([]), "2025-06-01")).toBe(0);
  });

  it("converts units with a supplied unit price", () => {
    const capacity = derivedMonthlySavingsCapacity(
      plan([
        contribution({
          amount: { mode: "units", value: "2" },
          cadence: { kind: "monthly", dayOfMonth: 1 },
        }),
      ]),
      "2025-06-01",
      undefined,
      { h1: "1000" },
    );
    expect(capacity).toBe(200_000);
  });

  it("ignores contributions that ended before today", () => {
    const capacity = derivedMonthlySavingsCapacity(
      plan([
        contribution({
          endDate: "2025-01-31",
          amount: { mode: "money", valueMinor: 500_000 },
        }),
      ]),
      "2025-06-01",
    );
    expect(capacity).toBe(0);
  });
});

describe("resolveMonthlySavingsCapacityForFire", () => {
  const baseConfig: FireScopeConfig = {
    monthlySpendingMinor: 2_000_000,
    safeWithdrawalRate: 0.04,
    monthlySavingsCapacityMinor: 150_000,
  };

  it("reads the derived plan total when contributions exist", () => {
    expect(
      resolveMonthlySavingsCapacityForFire(
        plan([contribution({ amount: { mode: "money", valueMinor: 400_000 } })]),
        baseConfig,
        "2025-06-01",
      ),
    ).toBe(400_000);
  });

  it("matches the old scalar behaviour when only the manual value is set", () => {
    expect(resolveMonthlySavingsCapacityForFire(null, baseConfig, "2025-06-01")).toBe(
      150_000,
    );
    expect(resolveMonthlySavingsCapacityForFire(plan([]), baseConfig, "2025-06-01")).toBe(
      150_000,
    );
  });
});
