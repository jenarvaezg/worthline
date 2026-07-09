/**
 * Anti-drift / propagation tests for N3 (issue #515).
 *
 * These tests assert that `realReturnUsed` is the SINGLE resolved rate and
 * that every consumer (coast, projectFire scenarios, fireLevels, goalFireDelay)
 * uses it — not the old `config.expectedRealReturn` directly.
 */
import { describe, expect, it } from "vitest";
import { calculateFireForScope } from "./fire";
import { fireLevels } from "./fire-levels";
import { projectFire } from "./fire-projection";
import { TIER_REAL_RETURN_DEFAULTS } from "./fire-return";
import { goalFireDelay } from "./goal-fire-delay";
import type { ManualAsset, Workspace } from "./index";

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
  isPrimaryResidence = false,
): ManualAsset {
  return {
    id,
    name: id,
    type: "manual",
    currency: "EUR",
    currentValue: { amountMinor, currency: "EUR" },
    liquidityTier,
    ownership: [{ memberId: "alice", shareBps: 10_000 }],
    isPrimaryResidence,
  };
}

const BASE_CONFIG = {
  monthlySpendingMinor: 200_000,
  safeWithdrawalRate: 0.04,
} as const;

// ── Resolution: override honored ──────────────────────────────────────────────

describe("calculateFireForScope resolution", () => {
  it("with expectedRealReturn SET → realReturnUsed === override, effectiveRealReturn still computed", () => {
    const assets = [makeAsset("stocks", 1_000_000, "market")];
    const result = calculateFireForScope(
      { ...BASE_CONFIG, expectedRealReturn: 0.07 },
      assets,
      [],
      workspace,
      "alice",
    );

    // explicit override honored
    expect(result.realReturnUsed!).toBeCloseTo(0.07, 10);
    // effective is still computed (100% market → market default)
    expect(result.effectiveRealReturn!).toBeCloseTo(TIER_REAL_RETURN_DEFAULTS.market, 10);
  });

  it("with expectedRealReturn UNDEFINED → realReturnUsed === effectiveRealReturn", () => {
    const assets = [makeAsset("stocks", 1_000_000, "market")];
    const result = calculateFireForScope(BASE_CONFIG, assets, [], workspace, "alice");

    expect(result.realReturnUsed!).toBeCloseTo(result.effectiveRealReturn!, 10);
    // 100% market → market default
    expect(result.realReturnUsed!).toBeCloseTo(TIER_REAL_RETURN_DEFAULTS.market, 10);
  });

  it("mixed 60% market + 40% cash → effective = 3%", () => {
    const assets = [
      makeAsset("stocks", 600_000, "market"),
      makeAsset("cash-acct", 400_000, "cash"),
    ];
    const result = calculateFireForScope(BASE_CONFIG, assets, [], workspace, "alice");

    expect(result.effectiveRealReturn).toBeCloseTo(0.03, 10);
    expect(result.realReturnUsed).toBeCloseTo(0.03, 10);
  });
});

// ── Coast uses realReturnUsed ─────────────────────────────────────────────────

describe("coast FIRE uses realReturnUsed (not config.expectedRealReturn)", () => {
  it("different allocation changes coast amount coherently", () => {
    // 100% cash → effective = 0% → coast = fireNumber (can never compound)
    const allCashAssets = [makeAsset("savings", 100_000, "cash")];
    const allMarketAssets = [makeAsset("stocks", 100_000, "market")];

    const configWithAge = { ...BASE_CONFIG, currentAge: 35, targetRetirementAge: 65 };

    const cashResult = calculateFireForScope(
      configWithAge,
      allCashAssets,
      [],
      workspace,
      "alice",
    );
    const marketResult = calculateFireForScope(
      configWithAge,
      allMarketAssets,
      [],
      workspace,
      "alice",
    );

    // Market has higher effective rate → coast number is LOWER (less needed today)
    expect(marketResult.coastFireRequired!.amountMinor).toBeLessThan(
      cashResult.coastFireRequired!.amountMinor,
    );
    // The effective return drives coast, not a stale config field
    expect(cashResult.realReturnUsed!).toBeCloseTo(0, 10);
    expect(marketResult.realReturnUsed!).toBeCloseTo(
      TIER_REAL_RETURN_DEFAULTS.market,
      10,
    );
  });
});

// ── projectFire + fireLevels + goalFireDelay accept resolved rate ─────────────

describe("projectFire base scenario uses realReturnUsed", () => {
  it("base scenario annualReturn equals realReturnUsed from calculateFireForScope", () => {
    const assets = [
      makeAsset("stocks", 600_000, "market"),
      makeAsset("savings", 400_000, "cash"),
    ];
    const result = calculateFireForScope(BASE_CONFIG, assets, [], workspace, "alice");

    // Caller would pass result.realReturnUsed to projectFire:
    const proj = projectFire({
      startingEligibleMinor: result.eligibleAssets.amountMinor,
      monthlyContributionMinor: 0,
      expectedRealReturn: result.realReturnUsed!,
      fireNumberMinor: result.fireNumber.amountMinor,
    });

    const base = proj.scenarios.find((s) => s.label === "base")!;
    // base scenario annualReturn IS the resolved rate (no shift on base)
    expect(base.annualReturn).toBeCloseTo(result.realReturnUsed!, 10);
  });

  it("flipping allocation changes base scenario annualReturn", () => {
    const cashHeavy = [
      makeAsset("stocks", 200_000, "market"),
      makeAsset("savings", 800_000, "cash"),
    ];
    const marketHeavy = [
      makeAsset("stocks", 800_000, "market"),
      makeAsset("savings", 200_000, "cash"),
    ];

    const cashResult = calculateFireForScope(
      BASE_CONFIG,
      cashHeavy,
      [],
      workspace,
      "alice",
    );
    const marketResult = calculateFireForScope(
      BASE_CONFIG,
      marketHeavy,
      [],
      workspace,
      "alice",
    );

    expect(cashResult.realReturnUsed!).toBeLessThan(marketResult.realReturnUsed!);
  });
});

describe("fireLevels uses passed-in resolvedReturn", () => {
  it("coast amount changes with different resolved return rates", () => {
    const eligibleMinor = 500_000;
    const configWithAge = {
      ...BASE_CONFIG,
      currentAge: 35,
      targetRetirementAge: 65,
    };

    // Call fireLevels with a low rate vs high rate
    const lowRateLevels = fireLevels({
      config: { ...configWithAge, expectedRealReturn: 0.01 },
      eligibleMinor,
      currency: "EUR",
    });
    const highRateLevels = fireLevels({
      config: { ...configWithAge, expectedRealReturn: 0.08 },
      eligibleMinor,
      currency: "EUR",
    });

    const lowCoast = lowRateLevels?.find((l) => l.key === "coast")?.amountMinor ?? 0;
    const highCoast = highRateLevels?.find((l) => l.key === "coast")?.amountMinor ?? 0;

    // Higher rate → lower coast (more compounding)
    expect(highCoast).toBeLessThan(lowCoast);
  });

  it("DIVERGENCE: resolvedRealReturn=0.08 overrides config.expectedRealReturn=0.0 for Coast amount (pins CRITICAL-2)", () => {
    // config has a stale/zero expectedRealReturn; resolvedRealReturn is the weighted effective.
    // Coast amount must reflect 8%, not 0%.
    const eligibleMinor = 500_000;
    const configWithAge = {
      ...BASE_CONFIG,
      currentAge: 35,
      targetRetirementAge: 65,
      expectedRealReturn: 0.0, // stale config field
    };

    const withResolved = fireLevels({
      config: configWithAge,
      eligibleMinor,
      currency: "EUR",
      resolvedRealReturn: 0.08, // weighted effective overrides
    });
    const withoutResolved = fireLevels({
      config: configWithAge,
      eligibleMinor,
      currency: "EUR",
      // no resolvedRealReturn → falls back to config.expectedRealReturn = 0.0
    });

    const coastWithResolved = withResolved?.find((l) => l.key === "coast")?.amountMinor;
    const coastWithout = withoutResolved?.find((l) => l.key === "coast")?.amountMinor;

    // At 0% rate the coast required equals the full FIRE number (no growth).
    // At 8% rate over 30 years the coast required is much lower.
    expect(coastWithResolved).toBeDefined();
    expect(coastWithout).toBeDefined();
    expect(coastWithResolved!).toBeLessThan(coastWithout!);
  });
});

describe("goalFireDelay uses passed-in resolvedReturn", () => {
  it("returns no_effect when no currentAge (no horizon)", () => {
    const goal = {
      id: "g1",
      name: "Car",
      targetAmountMinor: 10_000_00,
      deadline: "2027-01-01",
      priority: "medium" as const,
      scopeId: "alice",
      assetIds: [],
    };
    const delay = goalFireDelay({
      goal,
      otherReservationsMinor: 0,
      eligibleGrossMinor: 100_000_00,
      thisGoalReservationMinor: 10_000_00,
      config: { ...BASE_CONFIG, expectedRealReturn: 0.05 },
      now: "2026-01-01",
    });

    expect(delay.kind).toBe("no_effect");
  });

  it("goalFireDelay result changes when rate changes (propagation)", () => {
    // Goal: €5 000 due 2028-01-01; eligible €20 000; FIRE target ~€60 000 (200€/mo × 12 / 4%)
    // At low return (1%) both without/with cross the target; at high rate they cross faster.
    const goal = {
      id: "g1",
      name: "Car",
      targetAmountMinor: 5_000_00,
      deadline: "2028-01-01",
      priority: "medium" as const,
      scopeId: "alice",
      assetIds: [],
    };
    const now = "2026-01-01";
    const sharedConfig = {
      monthlySpendingMinor: 100_000, // €1 000/mo
      safeWithdrawalRate: 0.04, // FIRE target = 300 000€ = 30_000_000 minor
      monthlySavingsCapacityMinor: 1_000_00, // €1 000/mo savings
      currentAge: 35,
      targetRetirementAge: 65,
    };

    // low return → longer to FIRE → delay in months is larger
    const delayLow = goalFireDelay({
      goal,
      otherReservationsMinor: 0,
      eligibleGrossMinor: 10_000_00, // €10 000
      thisGoalReservationMinor: 5_000_00,
      config: { ...sharedConfig, expectedRealReturn: 0.01 },
      now,
    });

    // high return → shorter to FIRE → delay in months is smaller
    const delayHigh = goalFireDelay({
      goal,
      otherReservationsMinor: 0,
      eligibleGrossMinor: 10_000_00,
      thisGoalReservationMinor: 5_000_00,
      config: { ...sharedConfig, expectedRealReturn: 0.08 },
      now,
    });

    // Both must be "delays" kind (goal is in-horizon, has a reservation)
    expect(delayLow.kind).toBe("delays");
    expect(delayHigh.kind).toBe("delays");
    // higher rate accumulates faster → smaller or equal delay
    if (delayLow.kind === "delays" && delayHigh.kind === "delays") {
      expect(delayHigh.months).toBeLessThanOrEqual(delayLow.months);
    }
  });

  it("DIVERGENCE: resolvedRealReturn=0.10 overrides config.expectedRealReturn=0.0 for delay months", () => {
    // config has expectedRealReturn=0 (stale); resolvedRealReturn=0.10 (weighted effective).
    // Use a large reservation (100 000€) so the growth difference is material enough to
    // survive month-rounding (0% vs 10% over 20+ years produces clearly different crossing years).
    const goal = {
      id: "g1",
      name: "House fund",
      targetAmountMinor: 100_000_00, // €100 000
      deadline: "2028-01-01",
      priority: "medium" as const,
      scopeId: "alice",
      assetIds: [],
    };
    const now = "2026-01-01";
    const baseShared = {
      monthlySpendingMinor: 100_000, // €1 000/mo → FIRE = €300 000
      safeWithdrawalRate: 0.04,
      monthlySavingsCapacityMinor: 50_000, // €500/mo savings
      currentAge: 35,
      targetRetirementAge: 65,
      expectedRealReturn: 0.0, // stale config value
    };

    // With resolved rate of 0.10 — higher growth → smaller delay
    const delayWithResolved = goalFireDelay({
      goal,
      otherReservationsMinor: 0,
      eligibleGrossMinor: 200_000_00, // €200 000
      thisGoalReservationMinor: 100_000_00,
      config: baseShared,
      now,
      resolvedRealReturn: 0.1,
    });

    // Without resolved rate → falls back to config.expectedRealReturn = 0.0 → slower growth → larger delay
    const delayWithoutResolved = goalFireDelay({
      goal,
      otherReservationsMinor: 0,
      eligibleGrossMinor: 200_000_00,
      thisGoalReservationMinor: 100_000_00,
      config: baseShared,
      now,
      // no resolvedRealReturn
    });

    expect(delayWithResolved.kind).toBe("delays");
    expect(delayWithoutResolved.kind).toBe("delays");
    // higher resolved rate → faster accumulation → strictly fewer delay months
    if (delayWithResolved.kind === "delays" && delayWithoutResolved.kind === "delays") {
      expect(delayWithResolved.months).toBeLessThan(delayWithoutResolved.months);
    }
  });
});
