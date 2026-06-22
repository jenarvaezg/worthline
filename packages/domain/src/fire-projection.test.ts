import { describe, expect, it } from "vitest";

import { projectFire } from "./fire-projection";

describe("projectFire", () => {
  it("returns three scenarios in order with ±1.5% shifts off the base return", () => {
    const projection = projectFire({
      startingEligibleMinor: 0,
      monthlyContributionMinor: 100_000,
      expectedRealReturn: 0.05,
      fireNumberMinor: 12_000_000,
    });

    expect(projection.scenarios.map((s) => s.label)).toEqual([
      "optimistic",
      "base",
      "pessimistic",
    ]);
    expect(projection.scenarios.map((s) => s.annualReturn)).toEqual([0.065, 0.05, 0.035]);
    expect(projection.fireNumberMinor).toBe(12_000_000);
  });

  it("already at FIRE → 0 years, no contributions, age unchanged", () => {
    const projection = projectFire({
      startingEligibleMinor: 80_000_000,
      monthlyContributionMinor: 100_000,
      expectedRealReturn: 0.05,
      fireNumberMinor: 75_000_000,
      currentAge: 40,
    });

    const base = projection.scenarios.find((s) => s.label === "base")!;
    expect(base.yearsToFire).toBe(0);
    expect(base.ageAtFire).toBe(40);
    expect(base.totalContributedMinor).toBe(0);
    expect(base.finalEligibleMinor).toBe(80_000_000);
    expect(base.trajectory[0]).toEqual({ year: 0, eligibleMinor: 80_000_000 });
  });

  it("zero return + steady contribution is exact linear growth", () => {
    // 1000 €/month = 12 000 €/yr; target 120 000 € from 0 → exactly 10 years
    const base = projectFire({
      startingEligibleMinor: 0,
      monthlyContributionMinor: 100_000,
      expectedRealReturn: 0,
      fireNumberMinor: 12_000_000,
      currentAge: 30,
    }).scenarios.find((s) => s.label === "base")!;

    expect(base.yearsToFire).toBe(10);
    expect(base.ageAtFire).toBe(40);
    expect(base.totalContributedMinor).toBe(12_000_000);
    expect(base.finalEligibleMinor).toBe(12_000_000);
    // trajectory is one entry per year, year 0 through the FIRE year
    expect(base.trajectory).toHaveLength(11);
    expect(base.trajectory.at(-1)).toEqual({ year: 10, eligibleMinor: 12_000_000 });
    expect(base.trajectory[5]).toEqual({ year: 5, eligibleMinor: 6_000_000 });
  });

  it("unreachable target → null years, trajectory capped at maxYears", () => {
    const base = projectFire({
      startingEligibleMinor: 0,
      monthlyContributionMinor: 0,
      expectedRealReturn: 0,
      fireNumberMinor: 100_000_000,
      maxYears: 50,
    }).scenarios.find((s) => s.label === "base")!;

    expect(base.yearsToFire).toBeNull();
    expect(base.ageAtFire).toBeNull();
    expect(base.finalEligibleMinor).toBe(0);
    expect(base.trajectory).toHaveLength(51); // year 0..50
  });

  it("compound growth reaches FIRE no later than the linear (zero-return) case", () => {
    const common = {
      startingEligibleMinor: 10_000_000,
      monthlyContributionMinor: 100_000,
      fireNumberMinor: 50_000_000,
      currentAge: 35,
    };
    const compounded = projectFire({
      ...common,
      expectedRealReturn: 0.06,
    }).scenarios.find((s) => s.label === "base")!;
    const linear = projectFire({ ...common, expectedRealReturn: 0 }).scenarios.find(
      (s) => s.label === "base",
    )!;

    expect(compounded.yearsToFire).not.toBeNull();
    expect(linear.yearsToFire).not.toBeNull();
    expect(compounded.yearsToFire!).toBeLessThanOrEqual(linear.yearsToFire!);
    expect(compounded.finalEligibleMinor).toBeGreaterThanOrEqual(common.fireNumberMinor);
  });

  it("optimistic reaches FIRE no later than base, base no later than pessimistic", () => {
    const projection = projectFire({
      startingEligibleMinor: 5_000_000,
      monthlyContributionMinor: 120_000,
      expectedRealReturn: 0.05,
      fireNumberMinor: 60_000_000,
      currentAge: 30,
    });
    const [opt, base, pes] = projection.scenarios;

    expect(opt!.yearsToFire!).toBeLessThanOrEqual(base!.yearsToFire!);
    expect(base!.yearsToFire!).toBeLessThanOrEqual(pes!.yearsToFire!);
  });

  it("omits age fields when no current age is given", () => {
    const base = projectFire({
      startingEligibleMinor: 0,
      monthlyContributionMinor: 100_000,
      expectedRealReturn: 0,
      fireNumberMinor: 12_000_000,
    }).scenarios.find((s) => s.label === "base")!;

    expect(base.yearsToFire).toBe(10);
    expect(base.ageAtFire).toBeNull();
  });
});
