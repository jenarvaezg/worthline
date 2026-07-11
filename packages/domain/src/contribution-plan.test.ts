import { describe, expect, it } from "vitest";

import {
  type ContributionPlan,
  contributionOccurrenceId,
  contributionPendingWindow,
  derivedMonthlySavingsCapacity,
  deriveMonthlyAllocation,
  expandContributionPlan,
  type PlannedContribution,
  projectContributionReconciliation,
  resolveMonthlySavingsCapacityForFire,
} from "./contribution-plan";
import type { FireScopeConfig } from "./fire";

function contribution(overrides: Partial<PlannedContribution> = {}): PlannedContribution {
  return {
    id: "c1",
    destinationHoldingId: "h1",
    amount: { mode: "money", value: 100_000 },
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
      occurrences.every((o) => o.amount.mode === "money" && o.amount.value === 100_000),
    ).toBe(true);
  });

  it("returns to day 31 after a short February anchor", () => {
    const occurrences = expandContributionPlan(
      plan([
        contribution({
          startDate: "2025-02-01",
          cadence: { kind: "monthly", dayOfMonth: 31 },
        }),
      ]),
      "2025-02-01",
      "2025-05-31",
    );
    expect(occurrences.map((o) => o.plannedDate)).toEqual([
      "2025-02-28",
      "2025-03-31",
      "2025-04-30",
      "2025-05-31",
    ]);
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
          amount: { mode: "money", value: 50_000 },
        }),
      ]),
      "2025-01-01",
      "2025-01-31",
    );
    expect(money[0]!.amount).toEqual({ mode: "money", value: 50_000 });

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
      amount: { mode: "money", value: 100_000 },
    });
    expect(occurrence).not.toHaveProperty("operationId");
  });
});

describe("projectContributionReconciliation", () => {
  it("keeps future pending and past partial occurrences visible, with money progress including fees", () => {
    const input = plan([contribution()]);
    const projected = projectContributionReconciliation({
      plan: input,
      fromDate: "2025-01-01",
      toDate: "2025-03-31",
      today: "2025-02-15",
      reconciliations: [
        {
          occurrenceId: contributionOccurrenceId("c1", "2025-01-01"),
          state: "open",
          operationIds: ["op-1", "op-2"],
        },
        {
          occurrenceId: contributionOccurrenceId("c1", "2025-02-01"),
          state: "fulfilled",
          operationIds: ["op-3"],
        },
      ],
      operations: [
        {
          id: "op-1",
          assetId: "h1",
          kind: "buy",
          executedAt: "2025-01-03",
          units: "2",
          pricePerUnit: "200",
          currency: "EUR",
          feesMinor: 100,
        },
        {
          id: "op-2",
          assetId: "h1",
          kind: "buy",
          executedAt: "2025-01-07",
          units: "3",
          pricePerUnit: "200",
          currency: "EUR",
          feesMinor: 200,
        },
        {
          id: "op-3",
          assetId: "h1",
          kind: "buy",
          executedAt: "2025-02-04",
          units: "5",
          pricePerUnit: "200",
          currency: "EUR",
          feesMinor: 0,
        },
      ],
    });

    expect(projected.pending.map((item) => item.occurrence.plannedDate)).toEqual([
      "2025-01-01",
      "2025-03-01",
    ]);
    expect(projected.pending[0]).toMatchObject({
      state: "partial",
      backlog: true,
      summary: {
        mode: "money",
        plannedMinor: 100_000,
        executedMinor: 100_300,
        deltaMinor: 300,
      },
    });
    expect(projected.pending[1]).toMatchObject({ state: "pending", backlog: false });
  });

  it("uses units as the primary delta while retaining actual cash", () => {
    const projected = projectContributionReconciliation({
      plan: plan([contribution({ amount: { mode: "units", value: "5" } })]),
      fromDate: "2025-01-01",
      toDate: "2025-01-31",
      today: "2025-01-15",
      reconciliations: [
        {
          occurrenceId: contributionOccurrenceId("c1", "2025-01-01"),
          state: "open",
          operationIds: ["op"],
        },
      ],
      operations: [
        {
          id: "op",
          assetId: "h1",
          kind: "buy",
          executedAt: "2025-01-02",
          units: "4.5",
          pricePerUnit: "100",
          currency: "EUR",
          feesMinor: 250,
        },
      ],
    });

    expect(projected.pending[0]!.summary).toEqual({
      mode: "units",
      plannedUnits: "5",
      executedUnits: "4.5",
      deltaUnits: "-0.5",
      actualCashMinor: 45_250,
    });
  });

  it("removes skipped occurrences from pending without inventing execution", () => {
    const occurrenceId = contributionOccurrenceId("c1", "2025-01-01");
    const projected = projectContributionReconciliation({
      plan: plan([contribution()]),
      fromDate: "2025-01-01",
      toDate: "2025-01-31",
      today: "2025-01-15",
      reconciliations: [{ occurrenceId, state: "skipped", operationIds: [] }],
      operations: [],
    });
    expect(projected.pending).toEqual([]);
    expect(projected.closed[0]).toMatchObject({
      state: "skipped",
      summary: { executedMinor: 0 },
    });
  });
});

describe("derivedMonthlySavingsCapacity", () => {
  it("sums active contributions' monthly-equivalent money amounts", () => {
    const capacity = derivedMonthlySavingsCapacity(
      plan([
        contribution({
          id: "monthly",
          amount: { mode: "money", value: 300_000 },
          cadence: { kind: "monthly", dayOfMonth: 1 },
        }),
        contribution({
          id: "weekly",
          amount: { mode: "money", value: 100_000 },
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

  it("returns null when an active units contribution lacks a unit price", () => {
    const capacity = derivedMonthlySavingsCapacity(
      plan([
        contribution({
          amount: { mode: "units", value: "2" },
          cadence: { kind: "monthly", dayOfMonth: 1 },
        }),
      ]),
      "2025-06-01",
    );
    expect(capacity).toBeNull();
  });

  it("ignores contributions that ended before today", () => {
    const capacity = derivedMonthlySavingsCapacity(
      plan([
        contribution({
          endDate: "2025-01-31",
          amount: { mode: "money", value: 500_000 },
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
        plan([contribution({ amount: { mode: "money", value: 400_000 } })]),
        baseConfig,
        "2025-06-01",
      ),
    ).toEqual({ capacityMinor: 400_000, source: "plan_derived" });
  });

  it("matches the old scalar behaviour when only the manual value is set", () => {
    expect(resolveMonthlySavingsCapacityForFire(null, baseConfig, "2025-06-01")).toEqual({
      capacityMinor: 150_000,
      source: "manual_fallback",
    });
    expect(
      resolveMonthlySavingsCapacityForFire(plan([]), baseConfig, "2025-06-01"),
    ).toEqual({
      capacityMinor: 150_000,
      source: "manual_fallback",
    });
  });

  it("falls back to the manual scalar and reports missing prices for unit rows", () => {
    expect(
      resolveMonthlySavingsCapacityForFire(
        plan([
          contribution({
            amount: { mode: "units", value: "1" },
            cadence: { kind: "monthly", dayOfMonth: 1 },
          }),
        ]),
        baseConfig,
        "2025-06-01",
      ),
    ).toEqual({
      capacityMinor: 150_000,
      source: "incomplete_unit_pricing",
      missingUnitPriceHoldingIds: ["h1"],
    });
  });
});

describe("contributionPendingWindow", () => {
  it("spans from the earliest plan start to 90 days past today", () => {
    const window = contributionPendingWindow(
      plan([
        contribution({ id: "c1", startDate: "2025-03-15" }),
        contribution({ id: "c2", startDate: "2025-01-10" }),
      ]),
      "2025-06-15",
    );
    expect(window).toEqual({ from: "2025-01-10", to: "2025-09-13" });
  });

  it("falls back to today for an empty plan", () => {
    expect(contributionPendingWindow(plan([]), "2025-06-15")).toEqual({
      from: "2025-06-15",
      to: "2025-09-13",
    });
  });
});

describe("deriveMonthlyAllocation", () => {
  it("splits active contributions by destination in monthly equivalents", () => {
    const view = deriveMonthlyAllocation(
      plan([
        contribution({ id: "c1", destinationHoldingId: "h1" }),
        contribution({
          id: "c2",
          destinationHoldingId: "h2",
          amount: { mode: "money", value: 300_000 },
          cadence: { kind: "quarterly" },
        }),
        contribution({
          id: "c3",
          destinationHoldingId: "h1",
          amount: { mode: "money", value: 120_000 },
          cadence: { kind: "annual" },
        }),
      ]),
      "2025-06-15",
    );

    expect(view).toEqual({
      lines: [
        { destinationHoldingId: "h1", monthlyMinor: 110_000, incomplete: false },
        { destinationHoldingId: "h2", monthlyMinor: 100_000, incomplete: false },
      ],
      totalMinor: 210_000,
      missingUnitPriceHoldingIds: [],
    });
  });

  it("prices unit contributions at the current unit price", () => {
    const view = deriveMonthlyAllocation(
      plan([
        contribution({
          id: "c1",
          destinationHoldingId: "h1",
          amount: { mode: "units", value: "2.5" },
          cadence: { kind: "monthly", dayOfMonth: 1 },
        }),
      ]),
      "2025-06-15",
      { h1: "100.40" },
    );

    expect(view.lines).toEqual([
      { destinationHoldingId: "h1", monthlyMinor: 25_100, incomplete: false },
    ]);
    expect(view.totalMinor).toBe(25_100);
  });

  it("flags an unpriced units line as incomplete without inventing a figure", () => {
    const view = deriveMonthlyAllocation(
      plan([
        contribution({ id: "c1", destinationHoldingId: "h1" }),
        contribution({
          id: "c2",
          destinationHoldingId: "h1",
          amount: { mode: "units", value: "1" },
        }),
        contribution({
          id: "c3",
          destinationHoldingId: "h2",
          amount: { mode: "units", value: "3" },
        }),
      ]),
      "2025-06-15",
    );

    expect(view).toEqual({
      lines: [
        { destinationHoldingId: "h1", monthlyMinor: 100_000, incomplete: true },
        { destinationHoldingId: "h2", monthlyMinor: 0, incomplete: true },
      ],
      totalMinor: 100_000,
      missingUnitPriceHoldingIds: ["h1", "h2"],
    });
  });

  it("skips contributions that are not active today", () => {
    const view = deriveMonthlyAllocation(
      plan([
        contribution({ id: "c1", destinationHoldingId: "h1", startDate: "2026-01-01" }),
        contribution({
          id: "c2",
          destinationHoldingId: "h2",
          endDate: "2025-05-31",
        }),
        contribution({ id: "c3", destinationHoldingId: "h3" }),
      ]),
      "2025-06-15",
    );

    expect(view.lines).toEqual([
      { destinationHoldingId: "h3", monthlyMinor: 100_000, incomplete: false },
    ]);
    expect(view.totalMinor).toBe(100_000);
  });

  it("returns an empty view for an empty plan", () => {
    expect(deriveMonthlyAllocation(plan([]), "2025-06-15")).toEqual({
      lines: [],
      totalMinor: 0,
      missingUnitPriceHoldingIds: [],
    });
  });
});
