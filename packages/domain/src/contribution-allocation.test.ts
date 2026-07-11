import { describe, expect, test } from "vitest";
import { computeMonthlyContributionAllocation } from "./contribution-allocation";
import type { ContributionPlan } from "./contribution-plan";
import type { InvestmentOperation } from "./investment-types";

const plan = (contributions: ContributionPlan["contributions"]): ContributionPlan => ({
  scopeId: "household",
  contributions,
});

const monthlyMoney = (
  id: string,
  holdingId: string,
  valueMinor: number,
  dayOfMonth = 1,
): ContributionPlan["contributions"][number] => ({
  id,
  destinationHoldingId: holdingId,
  amount: { mode: "money", value: valueMinor },
  cadence: { kind: "monthly", dayOfMonth },
  startDate: "2026-01-01",
});

describe("computeMonthlyContributionAllocation", () => {
  test("splits a month's incoming capital across destinations in money terms", () => {
    const allocation = computeMonthlyContributionAllocation({
      plan: plan([
        monthlyMoney("c-fund", "asset_fund", 60_000),
        monthlyMoney("c-cash", "asset_cash", 40_000, 5),
      ]),
      monthKey: "2026-07",
      today: "2026-07-11",
    });

    expect(allocation.monthKey).toBe("2026-07");
    expect(allocation.totalPlannedMinor).toBe(100_000);
    expect(allocation.destinations).toEqual([
      expect.objectContaining({
        holdingId: "asset_fund",
        plannedMinor: 60_000,
        occurrenceCount: 1,
        executedMinor: 0,
      }),
      expect.objectContaining({
        holdingId: "asset_cash",
        plannedMinor: 40_000,
        occurrenceCount: 1,
      }),
    ]);
  });

  test("counts every occurrence that falls inside the month (weekly cadence)", () => {
    const allocation = computeMonthlyContributionAllocation({
      plan: plan([
        {
          id: "c-weekly",
          destinationHoldingId: "asset_crypto",
          amount: { mode: "money", value: 5_000 },
          cadence: { kind: "weekly", weekday: 1 },
          startDate: "2026-01-01",
        },
      ]),
      monthKey: "2026-06",
      today: "2026-07-11",
    });

    // June 2026 has 5 Mondays (1, 8, 15, 22, 29).
    const row = allocation.destinations.find((d) => d.holdingId === "asset_crypto");
    expect(row?.occurrenceCount).toBe(5);
    expect(row?.plannedMinor).toBe(25_000);
    expect(allocation.totalPlannedMinor).toBe(25_000);
  });

  test("excludes contributions not active in the month", () => {
    const allocation = computeMonthlyContributionAllocation({
      plan: plan([
        { ...monthlyMoney("c-old", "asset_a", 10_000), endDate: "2026-05-31" },
        { ...monthlyMoney("c-new", "asset_b", 20_000), startDate: "2026-08-01" },
      ]),
      monthKey: "2026-07",
      today: "2026-07-11",
    });

    expect(allocation.destinations).toEqual([]);
    expect(allocation.totalPlannedMinor).toBe(0);
    expect(allocation.occurrenceCount).toBe(0);
  });

  test("values units contributions at the current price", () => {
    const allocation = computeMonthlyContributionAllocation({
      plan: plan([
        {
          id: "c-units",
          destinationHoldingId: "asset_fund",
          amount: { mode: "units", value: "2.5" },
          cadence: { kind: "monthly", dayOfMonth: 1 },
          startDate: "2026-01-01",
        },
      ]),
      monthKey: "2026-07",
      today: "2026-07-11",
      unitPriceMajorByHoldingId: { asset_fund: "100" },
    });

    const row = allocation.destinations[0];
    expect(row?.plannedMinor).toBe(25_000);
    expect(row?.plannedUnits).toBe("2.5");
    expect(allocation.unpricedHoldingIds).toEqual([]);
  });

  test("reports unpriced units destinations honestly instead of guessing", () => {
    const allocation = computeMonthlyContributionAllocation({
      plan: plan([
        monthlyMoney("c-cash", "asset_cash", 40_000),
        {
          id: "c-units",
          destinationHoldingId: "asset_pension",
          amount: { mode: "units", value: "1.25" },
          cadence: { kind: "monthly", dayOfMonth: 1 },
          startDate: "2026-01-01",
        },
      ]),
      monthKey: "2026-07",
      today: "2026-07-11",
    });

    const unpriced = allocation.destinations.find((d) => d.holdingId === "asset_pension");
    expect(unpriced?.plannedMinor).toBeNull();
    expect(unpriced?.plannedUnits).toBe("1.25");
    expect(allocation.unpricedHoldingIds).toEqual(["asset_pension"]);
    // Total only sums what can be priced — never invents a price.
    expect(allocation.totalPlannedMinor).toBe(40_000);
  });

  test("contrasts planned vs confirmed when reconciliation truth exists", () => {
    const operations: InvestmentOperation[] = [
      {
        id: "op-1",
        assetId: "asset_fund",
        kind: "buy",
        units: "3",
        pricePerUnit: "210",
        currency: "EUR",
        feesMinor: 150,
        executedAt: "2026-07-03T00:00:00Z",
      },
    ];
    const allocation = computeMonthlyContributionAllocation({
      plan: plan([monthlyMoney("c-fund", "asset_fund", 60_000)]),
      monthKey: "2026-07",
      today: "2026-07-11",
      reconciliations: [
        {
          occurrenceId: "c-fund:2026-07-01",
          state: "fulfilled",
          operationIds: ["op-1"],
        },
      ],
      operations,
    });

    const row = allocation.destinations[0];
    // 3 × 210 € = 630 € + 1,50 € fees
    expect(row?.executedMinor).toBe(63_150);
    expect(row?.closedCount).toBe(1);
    expect(allocation.totalExecutedMinor).toBe(63_150);
  });

  test("keeps skipped occurrences in the plan split with zero executed", () => {
    const allocation = computeMonthlyContributionAllocation({
      plan: plan([monthlyMoney("c-fund", "asset_fund", 60_000)]),
      monthKey: "2026-07",
      today: "2026-07-11",
      reconciliations: [
        { occurrenceId: "c-fund:2026-07-01", state: "skipped", operationIds: [] },
      ],
    });

    const row = allocation.destinations[0];
    expect(row?.plannedMinor).toBe(60_000);
    expect(row?.executedMinor).toBe(0);
    expect(row?.closedCount).toBe(1);
  });

  test("sorts destinations by planned money descending, unpriced last", () => {
    const allocation = computeMonthlyContributionAllocation({
      plan: plan([
        monthlyMoney("c-small", "asset_small", 10_000),
        monthlyMoney("c-big", "asset_big", 90_000),
        {
          id: "c-units",
          destinationHoldingId: "asset_unpriced",
          amount: { mode: "units", value: "1" },
          cadence: { kind: "monthly", dayOfMonth: 1 },
          startDate: "2026-01-01",
        },
      ]),
      monthKey: "2026-07",
      today: "2026-07-11",
    });

    expect(allocation.destinations.map((d) => d.holdingId)).toEqual([
      "asset_big",
      "asset_small",
      "asset_unpriced",
    ]);
  });

  test("rejects a malformed month key", () => {
    expect(() =>
      computeMonthlyContributionAllocation({
        plan: plan([]),
        monthKey: "2026-7",
        today: "2026-07-11",
      }),
    ).toThrow(/YYYY-MM/);
  });
});
