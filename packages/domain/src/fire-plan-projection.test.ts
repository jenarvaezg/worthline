import { describe, expect, it } from "vitest";

import type { ContributionPlan, PlannedContribution } from "./contribution-plan";
import {
  projectFireWithContributionPlan,
  resolveHoldingAnnualReturnForProjection,
} from "./fire-plan-projection";
import { projectFire } from "./fire-projection";
import type { HoldingReturnsView } from "./returns-display";

function contribution(overrides: Partial<PlannedContribution> = {}): PlannedContribution {
  return {
    id: "c1",
    destinationHoldingId: "h1",
    amount: { mode: "money", value: 100_000 },
    cadence: { kind: "monthly", dayOfMonth: 1 },
    startDate: "2026-01-01",
    ...overrides,
  };
}

function plan(
  contributions: PlannedContribution[],
  scopeId = "scope-1",
): ContributionPlan {
  return { scopeId, contributions };
}

const BASE = {
  startingEligibleMinor: 0,
  expectedRealReturn: 0.05,
  fireNumberMinor: 12_000_000,
  todayISO: "2026-01-01",
  currentAge: 30,
} as const;

describe("resolveHoldingAnnualReturnForProjection", () => {
  it("prefers TWR annualized rate, then IRR, then CAGR, then assumed", () => {
    const twrView: HoldingReturnsView = {
      kind: "market",
      totalGain: { amountMinor: 1_000, currency: "EUR" },
      totalReturnRatio: 0.1,
      annualized: true,
      cagr: 0.04,
      irr: { rate: 0.06, reason: null },
      twr: {
        rate: 0.08,
        annualizedRate: 0.08,
        annualized: true,
        startDate: "2025-01-01",
        endDate: "2026-01-01",
        spanDays: 365,
        reason: null,
      },
      realizedPnl: null,
      unrealizedPnl: null,
      caveats: [],
    };
    expect(resolveHoldingAnnualReturnForProjection(twrView, 0.05)).toBeCloseTo(0.08);

    const irrOnly: HoldingReturnsView = {
      ...twrView,
      twr: {
        rate: null,
        annualizedRate: null,
        annualized: false,
        startDate: null,
        endDate: null,
        spanDays: 0,
        reason: "insufficient_monthly_closes",
      },
    };
    expect(resolveHoldingAnnualReturnForProjection(irrOnly, 0.05)).toBeCloseTo(0.06);

    const cagrOnly: HoldingReturnsView = {
      ...twrView,
      twr: null,
      irr: { rate: null, reason: "insufficient_cashflows" },
    };
    expect(resolveHoldingAnnualReturnForProjection(cagrOnly, 0.05)).toBeCloseTo(0.04);

    expect(resolveHoldingAnnualReturnForProjection(null, 0.05)).toBeCloseTo(0.05);
  });
});

describe("projectFireWithContributionPlan", () => {
  it("matches projectFire when the plan is a constant monthly stream with historical growth at assumed rate", () => {
    const scalar = projectFire({
      startingEligibleMinor: BASE.startingEligibleMinor,
      monthlyContributionMinor: 100_000,
      expectedRealReturn: BASE.expectedRealReturn,
      fireNumberMinor: BASE.fireNumberMinor,
      currentAge: BASE.currentAge,
    });

    const fromPlan = projectFireWithContributionPlan({
      ...BASE,
      growthAssumption: "historical",
      assumedAnnualReturn: BASE.expectedRealReturn,
      holdingAnnualReturnById: { h1: BASE.expectedRealReturn },
      plan: plan([contribution()]),
    });

    const scalarBase = scalar.scenarios.find((s) => s.label === "base")!;
    const planBase = fromPlan.scenarios.find((s) => s.label === "base")!;
    expect(planBase.yearsToFire).toBe(scalarBase.yearsToFire);
    expect(planBase.totalContributedMinor).toBe(scalarBase.totalContributedMinor);
    expect(planBase.trajectory).toEqual(scalarBase.trajectory);
  });

  it("projects differently when a contribution ends before retirement", () => {
    const forever = projectFireWithContributionPlan({
      ...BASE,
      growthAssumption: "flat",
      assumedAnnualReturn: 0,
      plan: plan([contribution()]),
    });
    const ending = projectFireWithContributionPlan({
      ...BASE,
      growthAssumption: "flat",
      assumedAnnualReturn: 0,
      plan: plan([contribution({ endDate: "2028-12-31" })]),
    });

    const foreverBase = forever.scenarios.find((s) => s.label === "base")!;
    const endingBase = ending.scenarios.find((s) => s.label === "base")!;

    expect(endingBase.totalContributedMinor).toBeLessThan(
      foreverBase.totalContributedMinor,
    );
    expect(endingBase.finalEligibleMinor).toBeLessThan(foreverBase.finalEligibleMinor);
  });

  it("changes the trajectory between flat and historical growth assumptions", () => {
    const flat = projectFireWithContributionPlan({
      ...BASE,
      startingEligibleMinor: 1_000_000,
      growthAssumption: "flat",
      assumedAnnualReturn: BASE.expectedRealReturn,
      holdingAnnualReturnById: { h1: 0.1 },
      plan: plan([contribution()]),
    });
    const historical = projectFireWithContributionPlan({
      ...BASE,
      startingEligibleMinor: 1_000_000,
      growthAssumption: "historical",
      assumedAnnualReturn: BASE.expectedRealReturn,
      holdingAnnualReturnById: { h1: 0.1 },
      plan: plan([contribution()]),
    });

    const flatBase = flat.scenarios.find((s) => s.label === "base")!;
    const historicalBase = historical.scenarios.find((s) => s.label === "base")!;

    expect(flatBase.yearsToFire).toBeGreaterThan(historicalBase.yearsToFire!);
    expect(historicalBase.yearsToFire).not.toBeNull();
  });

  it("falls back to assumed rate when a holding has no historical return", () => {
    const withFallback = projectFireWithContributionPlan({
      ...BASE,
      growthAssumption: "historical",
      assumedAnnualReturn: 0.08,
      holdingAnnualReturnById: {},
      plan: plan([contribution()]),
    });
    const explicit = projectFireWithContributionPlan({
      ...BASE,
      growthAssumption: "historical",
      assumedAnnualReturn: 0.08,
      holdingAnnualReturnById: { h1: 0.08 },
      plan: plan([contribution()]),
    });

    const fallbackBase = withFallback.scenarios.find((s) => s.label === "base")!;
    const explicitBase = explicit.scenarios.find((s) => s.label === "base")!;
    expect(fallbackBase.trajectory).toEqual(explicitBase.trajectory);
  });

  it("returns three scenarios with ±1.5% shifts off the base return", () => {
    const projection = projectFireWithContributionPlan({
      ...BASE,
      growthAssumption: "flat",
      assumedAnnualReturn: 0,
      plan: plan([contribution()]),
    });

    expect(projection.scenarios.map((s) => s.label)).toEqual([
      "optimistic",
      "base",
      "pessimistic",
    ]);
    expect(projection.scenarios.map((s) => s.annualReturn)).toEqual([0.015, 0, -0.015]);
  });
});
