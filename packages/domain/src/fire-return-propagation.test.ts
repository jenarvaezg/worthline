/**
 * FIRE rate resolution + context (#1026, was the N3 anti-drift suite, #515).
 *
 * The 364-line propagation suite this replaces existed to police a convention:
 * that every consumer (coast, projectFire, fireLevels, goalFireDelay) remembered
 * to thread `realReturnUsed` instead of reaching for `config.expectedRealReturn`.
 * That invariant is now carried by a TYPE — `FireContext` bundles the resolved
 * rate with the eligible totals, and consumers take the context, so there is no
 * loose rate a caller can forget. What's left to test is just the resolution
 * itself and the one explicit override path (`withRate`).
 */
import { describe, expect, it } from "vitest";
import { calculateFireForScope, projectFireFromContext, withRate } from "./fire";
import { projectFireWithContributionPlan } from "./fire-plan-projection";
import { projectFire } from "./fire-projection";
import { TIER_REAL_RETURN_DEFAULTS } from "./fire-return";
import type { ContributionPlan, ManualAsset, PayoutSchedule, Workspace } from "./index";

const workspace: Workspace = {
  baseCurrency: "EUR",
  mode: "household",
  members: [{ id: "alice", name: "Alice" }],
  groups: [],
};

function makeAsset(
  id: string,
  amountMinor: number,
  liquidityTier: ManualAsset["liquidityTier"] = "market",
): ManualAsset {
  return {
    id,
    name: id,
    type: "manual",
    currency: "EUR",
    currentValue: { amountMinor, currency: "EUR" },
    liquidityTier,
    ownership: [{ memberId: "alice", shareBps: 10_000 }],
    isPrimaryResidence: false,
  };
}

const BASE_CONFIG = {
  monthlySpendingMinor: 200_000,
  safeWithdrawalRate: 0.04,
} as const;

describe("calculateFireForScope resolves the rate into the context", () => {
  it("override set → context.realReturnUsed is the override; effective still computed", () => {
    const { context } = calculateFireForScope(
      { ...BASE_CONFIG, expectedRealReturn: 0.07 },
      [makeAsset("stocks", 1_000_000, "market")],
      [],
      workspace,
      "alice",
    );

    expect(context.realReturnUsed).toBeCloseTo(0.07, 10);
    expect(context.effectiveRealReturn).toBeCloseTo(TIER_REAL_RETURN_DEFAULTS.market, 10);
  });

  it("no override → context.realReturnUsed === effective (weighted tier mix)", () => {
    const { context } = calculateFireForScope(
      BASE_CONFIG,
      [makeAsset("stocks", 600_000, "market"), makeAsset("cash", 400_000, "cash")],
      [],
      workspace,
      "alice",
    );

    // 60% market + 40% cash → 3%
    expect(context.effectiveRealReturn).toBeCloseTo(0.03, 10);
    expect(context.realReturnUsed).toBeCloseTo(context.effectiveRealReturn, 10);
  });
});

// ---------------------------------------------------------------------------
// The rent-derived rate (#1448): a rented property's declared NET yield replaces
// the housing rung's guessed 3 % — for that asset only, and never from a gross.
// ---------------------------------------------------------------------------

describe("a declared net rent resolves the rate for its own property", () => {
  function rentedFlat(id: string, valueMinor: number): ManualAsset {
    return { ...makeAsset(id, valueMinor, "illiquid"), instrument: "property" };
  }

  function rent(
    holdingId: string,
    amountMinor: number,
    expensesMinor?: number,
  ): PayoutSchedule {
    return {
      amountMinor,
      cadence: "monthly",
      endISO: null,
      exclusions: [],
      holdingId,
      id: `sched-${holdingId}`,
      label: "Alquiler",
      startISO: "2024-01-01",
      ...(expensesMinor === undefined ? {} : { expensesMinor }),
    };
  }

  // Jorge's shape, scaled: 370.000 € of rented brick beside 168.000 € of market.
  const brick = rentedFlat("piso", 37_000_000);
  const market = makeAsset("fondo", 16_800_000, "market");

  it("the housing default is what applies with no schedule in hand", () => {
    const { context } = calculateFireForScope(
      BASE_CONFIG,
      [brick, market],
      [],
      workspace,
      "alice",
    );

    expect(context.effectiveRealReturn).toBeCloseTo(0.0362, 4);
  });

  it("net rent over value replaces it, and the coast math follows the new rate", () => {
    // 1.550 €/mes gross, 250 €/mes of costs → 15.600 €/año net over 370.000 € = 4,22 %.
    const result = calculateFireForScope(
      { ...BASE_CONFIG, currentAge: 63, targetRetirementAge: 68 },
      [brick, market],
      [],
      workspace,
      "alice",
      0,
      { payoutSchedules: [rent("piso", 155_000, 25_000)], todayISO: "2026-08-18" },
    );

    expect(result.rentReturns.applied).toHaveLength(1);
    // 1.560.000 minor/año net over 37.000.000 minor of brick.
    const brickRate = 1_560_000 / 37_000_000;
    expect(result.rentReturns.applied[0]?.rate).toBeCloseTo(brickRate, 10);
    expect(result.context.effectiveRealReturn).toBeCloseTo(
      (37_000_000 / 53_800_000) * brickRate + (16_800_000 / 53_800_000) * 0.05,
      10,
    );
    // The context is the only rate downstream, so coast moves with it (#1026).
    const withRent = result.coastFireRequired!.amountMinor;
    const withDefault = calculateFireForScope(
      { ...BASE_CONFIG, currentAge: 63, targetRetirementAge: 68 },
      [brick, market],
      [],
      workspace,
      "alice",
    ).coastFireRequired!.amountMinor;
    expect(withRent).toBeLessThan(withDefault);
  });

  it("a rent with no declared expenses leaves the rate alone and says why", () => {
    const result = calculateFireForScope(
      BASE_CONFIG,
      [brick, market],
      [],
      workspace,
      "alice",
      0,
      { payoutSchedules: [rent("piso", 155_000)], todayISO: "2026-08-18" },
    );

    expect(result.context.effectiveRealReturn).toBeCloseTo(0.0362, 4);
    expect(result.rentReturns.applied).toEqual([]);
    expect(result.rentReturns.notices).toEqual([
      {
        assetId: "piso",
        assetName: "piso",
        // 1.550 × 12 / 370.000 = 5,03 %: the gross the app refuses to seal.
        grossRate: expect.closeTo(0.0503, 4),
        reason: "missing_expenses",
      },
    ]);
  });

  it("only that asset's rate moves: the market rung keeps its default", () => {
    const result = calculateFireForScope(
      BASE_CONFIG,
      [brick, market, rentedFlat("otro-piso", 10_000_000)],
      [],
      workspace,
      "alice",
      0,
      { payoutSchedules: [rent("piso", 155_000, 25_000)], todayISO: "2026-08-18" },
    );

    const total = 37_000_000 + 16_800_000 + 10_000_000;
    expect(result.context.effectiveRealReturn).toBeCloseTo(
      (37_000_000 / total) * (1_560_000 / 37_000_000) +
        (16_800_000 / total) * TIER_REAL_RETURN_DEFAULTS.market +
        (10_000_000 / total) * TIER_REAL_RETURN_DEFAULTS.housing,
      4,
    );
  });

  // ── La renta neta como INGRESO, no como tasa (#1428) ───────────────────
  // El gasto sostenible se presenta partido en «rentas netas + lo que el capital
  // vendible soporta», así que la mitad de las rentas tiene que salir del mismo
  // motor que la tasa: dos lecturas de la misma renta acabarían discrepando.

  it("el informe publica la renta NETA anual del ámbito, no la bruta", () => {
    const result = calculateFireForScope(
      BASE_CONFIG,
      [brick, market],
      [],
      workspace,
      "alice",
      0,
      { payoutSchedules: [rent("piso", 155_000, 25_000)], todayISO: "2026-08-18" },
    );

    // (1.550 − 250) × 12 = 15.600 €/año.
    expect(result.rentReturns.netRentAnnualMinor).toBe(1_560_000);
  });

  it("la renta se escala a lo que el ámbito posee, como el peso que entró en la tasa", () => {
    const halfOwned: ManualAsset = {
      ...brick,
      ownership: [
        { memberId: "alice", shareBps: 5_000 },
        { memberId: "outsider", shareBps: 5_000 },
      ],
    };
    const result = calculateFireForScope(
      BASE_CONFIG,
      [halfOwned, market],
      [],
      workspace,
      "alice",
      0,
      { payoutSchedules: [rent("piso", 155_000, 25_000)], todayISO: "2026-08-18" },
    );

    expect(result.rentReturns.netRentAnnualMinor).toBe(780_000);
  });

  it("sin gastos declarados no aporta nada: neto o nada, igual que la tasa", () => {
    const result = calculateFireForScope(
      BASE_CONFIG,
      [brick, market],
      [],
      workspace,
      "alice",
      0,
      { payoutSchedules: [rent("piso", 155_000)], todayISO: "2026-08-18" },
    );

    expect(result.rentReturns.netRentAnnualMinor).toBe(0);
  });

  it("declarar el inmovilizado fuera del capital FIRE no borra su alquiler", () => {
    const options = {
      payoutSchedules: [rent("piso", 155_000, 25_000)],
      todayISO: "2026-08-18",
    };
    const declaredOut = calculateFireForScope(
      { ...BASE_CONFIG, immobilizedCountsAsFireCapital: false },
      [brick, market],
      [],
      workspace,
      "alice",
      0,
      options,
    );

    // El piso sale del capital y de la ponderación (#1460)…
    expect(declaredOut.rentReturns.applied).toEqual([]);
    // …y su renta sigue llegando todos los meses.
    expect(declaredOut.rentReturns.netRentAnnualMinor).toBe(1_560_000);
  });

  it("a manual expectedRealReturn still wins over everything", () => {
    const { context } = calculateFireForScope(
      { ...BASE_CONFIG, expectedRealReturn: 0.07 },
      [brick, market],
      [],
      workspace,
      "alice",
      0,
      { payoutSchedules: [rent("piso", 155_000, 25_000)], todayISO: "2026-08-18" },
    );

    expect(context.realReturnUsed).toBeCloseTo(0.07, 10);
    // The effective rate still carries the rent, so /objetivos can say what the
    // manual figure is overriding.
    expect(context.effectiveRealReturn).toBeCloseTo(
      (37_000_000 / 53_800_000) * (1_560_000 / 37_000_000) +
        (16_800_000 / 53_800_000) * TIER_REAL_RETURN_DEFAULTS.market,
      10,
    );
  });
});

describe("the context is what every projection consumes", () => {
  it("projectFireFromContext's base scenario uses context.realReturnUsed verbatim", () => {
    const { context } = calculateFireForScope(
      BASE_CONFIG,
      [makeAsset("stocks", 600_000, "market"), makeAsset("cash", 400_000, "cash")],
      [],
      workspace,
      "alice",
    );

    const base = projectFireFromContext(context, {
      monthlyContributionMinor: 0,
    }).scenarios.find((s) => s.label === "base")!;
    expect(base.annualReturn).toBeCloseTo(context.realReturnUsed, 10);
  });

  it("withRate is the ONLY way to override — explicit, never by omission", () => {
    const { context } = calculateFireForScope(
      BASE_CONFIG,
      [makeAsset("stocks", 1_000_000, "market")],
      [],
      workspace,
      "alice",
    );

    const whatIf = withRate(context, 0.09);
    expect(whatIf.realReturnUsed).toBeCloseTo(0.09, 10);
    // Everything else rides along unchanged — only the rate moved.
    expect(whatIf.eligibleMinor).toBe(context.eligibleMinor);
    expect(whatIf.fireNumberMinor).toBe(context.fireNumberMinor);
    // The original context is untouched (immutable override).
    expect(context.realReturnUsed).not.toBeCloseTo(0.09, 10);

    const whatIfBase = projectFireFromContext(whatIf, {
      monthlyContributionMinor: 0,
    }).scenarios.find((s) => s.label === "base")!;
    expect(whatIfBase.annualReturn).toBeCloseTo(0.09, 10);
  });
});

// ---------------------------------------------------------------------------
// The single projection door (#1122): the door must reproduce, verbatim, what
// the scalar engine and the contribution-plan engine produced when callers
// reached for them directly — so re-routing every entry through it cannot move
// a single figure.
// ---------------------------------------------------------------------------

describe("projectFireFromContext is the single door with no numeric drift", () => {
  const { context } = calculateFireForScope(
    BASE_CONFIG,
    [makeAsset("stocks", 600_000, "market"), makeAsset("cash", 400_000, "cash")],
    [],
    workspace,
    "alice",
  );

  it("scalar mode equals the internal projectFire engine, defaults drawn from the context", () => {
    const viaDoor = projectFireFromContext(context, {
      monthlyContributionMinor: 50_000,
    });
    const direct = projectFire({
      startingEligibleMinor: context.eligibleMinor,
      monthlyContributionMinor: 50_000,
      expectedRealReturn: context.realReturnUsed,
      fireNumberMinor: context.fireNumberMinor,
    });
    expect(viaDoor).toEqual(direct);
  });

  it("honours the fireNumberMinor override (the level rail projects to Fat)", () => {
    const fat = context.fireNumberMinor * 2;
    const viaDoor = projectFireFromContext(context, {
      monthlyContributionMinor: 50_000,
      fireNumberMinor: fat,
    });
    expect(viaDoor.fireNumberMinor).toBe(fat);
    expect(viaDoor).toEqual(
      projectFire({
        startingEligibleMinor: context.eligibleMinor,
        monthlyContributionMinor: 50_000,
        expectedRealReturn: context.realReturnUsed,
        fireNumberMinor: fat,
      }),
    );
  });

  it("honours the startingEligibleMinor override (goal-delay's with/without probes)", () => {
    const viaDoor = projectFireFromContext(context, {
      monthlyContributionMinor: 0,
      startingEligibleMinor: 123_456,
    });
    expect(viaDoor).toEqual(
      projectFire({
        startingEligibleMinor: 123_456,
        monthlyContributionMinor: 0,
        expectedRealReturn: context.realReturnUsed,
        fireNumberMinor: context.fireNumberMinor,
      }),
    );
  });

  it("plan mode equals the internal contribution-plan engine (the what-if)", () => {
    const plan: ContributionPlan = {
      scopeId: "scope-1",
      contributions: [
        {
          id: "c1",
          destinationHoldingId: "h1",
          amount: { mode: "money", value: 100_000 },
          cadence: { kind: "monthly", dayOfMonth: 1 },
          startDate: "2026-01-01",
        },
      ],
    };
    const holdingAnnualReturnById = { h1: 0.06 };

    const viaDoor = projectFireFromContext(context, {
      plan,
      growthAssumption: "historical",
      assumedAnnualReturn: context.realReturnUsed,
      holdingAnnualReturnById,
      todayISO: "2026-01-01",
    });
    const direct = projectFireWithContributionPlan({
      startingEligibleMinor: context.eligibleMinor,
      expectedRealReturn: context.realReturnUsed,
      fireNumberMinor: context.fireNumberMinor,
      todayISO: "2026-01-01",
      plan,
      growthAssumption: "historical",
      assumedAnnualReturn: context.realReturnUsed,
      holdingAnnualReturnById,
    });
    expect(viaDoor).toEqual(direct);
  });
});
