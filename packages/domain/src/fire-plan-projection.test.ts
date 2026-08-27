import { describe, expect, it } from "vitest";

import type { ContributionPlan, PlannedContribution } from "./contribution-plan";
import { projectFireWithContributionPlan } from "./fire-plan-projection";
import { projectFire } from "./fire-projection";
import type { HoldingReturnsView } from "./returns-display";
import { resolveHoldingAnnualReturnForProjection } from "./returns-display";

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

  it("una aportación anual equivale a la mensual que suma lo mismo en el año", () => {
    // El stepper reparte por AÑO de proyección (#1597): la cadencia dentro del año no
    // mueve la trayectoria, solo el total que cae en él.
    const monthly = projectFireWithContributionPlan({
      ...BASE,
      growthAssumption: "historical",
      assumedAnnualReturn: BASE.expectedRealReturn,
      holdingAnnualReturnById: { h1: BASE.expectedRealReturn },
      plan: plan([contribution()]),
    });
    const yearly = projectFireWithContributionPlan({
      ...BASE,
      growthAssumption: "historical",
      assumedAnnualReturn: BASE.expectedRealReturn,
      holdingAnnualReturnById: { h1: BASE.expectedRealReturn },
      plan: plan([
        contribution({
          amount: { mode: "money", value: 1_200_000 },
          cadence: { kind: "annual" },
        }),
      ]),
    });

    const monthlyBase = monthly.scenarios.find((s) => s.label === "base")!;
    const yearlyBase = yearly.scenarios.find((s) => s.label === "base")!;
    expect(yearlyBase.trajectory).toEqual(monthlyBase.trajectory);
    expect(yearlyBase.totalContributedMinor).toBe(monthlyBase.totalContributedMinor);
  });

  it("un plan que cambia de aportación sigue el mismo paso que el escalar hasta que cambia", () => {
    // La equivalencia que faltaba (#1597): antes solo estaba clavado el caso «mensual
    // constante + tasa uniforme», que es justo el caso en el que los dos bucles no
    // podían discrepar. Aquí la aportación DOBLA en el año 4.
    const STEP_UP_YEAR = 4;
    const MAX_YEARS = 6;
    const START = 1_000_000;
    const RATE = 0.05;
    const commonArgs = {
      ...BASE,
      startingEligibleMinor: START,
      expectedRealReturn: RATE,
      // Inalcanzable dentro del horizonte: así la trayectoria llega entera.
      fireNumberMinor: 999_000_000,
      maxYears: MAX_YEARS,
      growthAssumption: "historical" as const,
      assumedAnnualReturn: RATE,
      holdingAnnualReturnById: { h1: RATE },
    };

    const varying = projectFireWithContributionPlan({
      ...commonArgs,
      plan: plan([
        contribution({ id: "c1", endDate: "2028-12-31" }),
        contribution({
          id: "c2",
          amount: { mode: "money", value: 200_000 },
          startDate: "2029-01-01",
        }),
      ]),
    });
    const varyingBase = varying.scenarios.find((s) => s.label === "base")!;

    // 1. Mientras el plan es la aportación de siempre, el motor de plan y el escalar
    //    pisan exactamente los mismos puntos.
    const scalarBase = projectFire({
      startingEligibleMinor: START,
      monthlyContributionMinor: 100_000,
      expectedRealReturn: RATE,
      fireNumberMinor: 999_000_000,
      currentAge: BASE.currentAge,
      maxYears: MAX_YEARS,
    }).scenarios.find((s) => s.label === "base")!;
    expect(varyingBase.trajectory.slice(0, STEP_UP_YEAR)).toEqual(
      scalarBase.trajectory.slice(0, STEP_UP_YEAR),
    );

    // 2. …y a partir del salto sigue el mismo paso, con la aportación nueva. La
    //    referencia se escribe aquí a mano: crecer, luego aportar.
    let capital = START;
    const expected = [{ year: 0, eligibleMinor: START }];
    let contributed = 0;
    for (let year = 1; year <= MAX_YEARS; year += 1) {
      capital = capital * (1 + RATE) + (year < STEP_UP_YEAR ? 1_200_000 : 2_400_000);
      contributed += year < STEP_UP_YEAR ? 1_200_000 : 2_400_000;
      expected.push({ year, eligibleMinor: Math.round(capital) });
    }
    expect(varyingBase.trajectory).toEqual(expected);
    expect(varyingBase.totalContributedMinor).toBe(contributed);
    // El salto es real: el escalar se queda corto desde el año 4.
    expect(varyingBase.trajectory.at(-1)!.eligibleMinor).toBeGreaterThan(
      scalarBase.trajectory.at(-1)!.eligibleMinor,
    );
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

  it("returns three flat scenarios with zero appreciation in every branch", () => {
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
    expect(projection.scenarios.map((s) => s.annualReturn)).toEqual([0, 0, 0]);
    const [opt, base, pes] = projection.scenarios;
    expect(opt!.trajectory).toEqual(base!.trajectory);
    expect(pes!.trajectory).toEqual(base!.trajectory);
  });

  it("uses per-holding historical growth for an empty plan with a starting split", () => {
    const cashHeavy = projectFireWithContributionPlan({
      ...BASE,
      startingEligibleMinor: 1_000_000,
      growthAssumption: "historical",
      assumedAnnualReturn: 0.02,
      holdingAnnualReturnById: { h1: 0.02, h2: 0.12 },
      startingEligibleByHoldingId: { h1: 900_000, h2: 100_000 },
      plan: plan([]),
      fireNumberMinor: 5_000_000,
      maxYears: 10,
    });
    const growthHeavy = projectFireWithContributionPlan({
      ...BASE,
      startingEligibleMinor: 1_000_000,
      growthAssumption: "historical",
      assumedAnnualReturn: 0.02,
      holdingAnnualReturnById: { h1: 0.02, h2: 0.12 },
      startingEligibleByHoldingId: { h1: 100_000, h2: 900_000 },
      plan: plan([]),
      fireNumberMinor: 5_000_000,
      maxYears: 10,
    });

    const cashBase = cashHeavy.scenarios.find((s) => s.label === "base")!;
    const growthBase = growthHeavy.scenarios.find((s) => s.label === "base")!;
    expect(growthBase.finalEligibleMinor).toBeGreaterThan(cashBase.finalEligibleMinor);
  });
});
