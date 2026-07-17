/**
 * Tests for fireLevels (PRD #507 N1, issue #513).
 * Run: cd packages/domain && npx vitest run fire-levels
 */
import { describe, expect, it } from "vitest";

import type { FireContext, FireScopeConfig } from "./fire";
import type { FireLevelsInput } from "./fire-levels";
import { fireLevels } from "./fire-levels";
import { projectFire } from "./fire-projection";

/** A minimal valid base config.
 *  monthlySpending=2000 EUR, SWR=4%, return=5%, age 35→65.
 *  Regular FIRE = 200_000 * 12 / 0.04 = 60_000_000 minor (600 000 EUR).
 */
const BASE_CONFIG: FireScopeConfig = {
  monthlySpendingMinor: 200_000, // 2 000 EUR in minor (cents)
  safeWithdrawalRate: 0.04,
  expectedRealReturn: 0.05,
  currentAge: 35,
  targetRetirementAge: 65,
  monthlySavingsCapacityMinor: 100_000, // 1 000 EUR/month
};

/**
 * Build a `FireContext` the way `calculateFireForScope` would — the rate rides
 * with the totals (#1026). Tests override the config, eligible total or rate;
 * everything else is derived so the invariant (rate travels with totals) holds.
 */
function ctx(
  overrides: {
    config?: FireScopeConfig;
    eligibleMinor?: number;
    realReturnUsed?: number;
  } = {},
): FireContext {
  const config = overrides.config ?? BASE_CONFIG;
  const eligibleMinor = overrides.eligibleMinor ?? 0;
  const effectiveRealReturn = config.expectedRealReturn ?? 0.05;
  return {
    config,
    currency: "EUR",
    realReturnUsed: overrides.realReturnUsed ?? effectiveRealReturn,
    effectiveRealReturn,
    eligibleMinor,
    eligibleGrossMinor: eligibleMinor,
    fireNumberMinor: Math.round(
      (config.monthlySpendingMinor * 12) / config.safeWithdrawalRate,
    ),
  };
}

const input = (overrides?: Parameters<typeof ctx>[0]): FireLevelsInput => ({
  context: ctx(overrides),
});

describe("fireLevels — amounts", () => {
  it("regular = monthlySpending*12/SWR", () => {
    const levels = fireLevels(input())!;
    const regular = levels.find((l) => l.key === "regular")!;
    // 200_000 * 12 / 0.04 = 60_000_000
    expect(regular.amountMinor).toBe(60_000_000);
  });

  it("lean = spending*0.7*12/SWR by default", () => {
    const levels = fireLevels(input())!;
    const lean = levels.find((l) => l.key === "lean")!;
    expect(lean.amountMinor).toBe(Math.round((200_000 * 0.7 * 12) / 0.04));
  });

  it("fat = spending*1.5*12/SWR by default", () => {
    const levels = fireLevels(input())!;
    const fat = levels.find((l) => l.key === "fat")!;
    expect(fat.amountMinor).toBe(Math.round((200_000 * 1.5 * 12) / 0.04));
  });

  it("lean multiplier override respected", () => {
    const levels = fireLevels(
      input({ config: { ...BASE_CONFIG, leanMultiplier: 0.5 } }),
    )!;
    const lean = levels.find((l) => l.key === "lean")!;
    expect(lean.amountMinor).toBe(Math.round((200_000 * 0.5 * 12) / 0.04));
  });

  it("fat multiplier override respected", () => {
    const levels = fireLevels(input({ config: { ...BASE_CONFIG, fatMultiplier: 2.0 } }))!;
    const fat = levels.find((l) => l.key === "fat")!;
    expect(fat.amountMinor).toBe(Math.round((200_000 * 2.0 * 12) / 0.04));
  });

  it("coast amount comes from calculateFire (coastFireRequired)", () => {
    // growthFactor = (1.05)^30; coastRequired = fireNumber / growthFactor
    const regular = Math.round((200_000 * 12) / 0.04);
    const expected = Math.round(regular / Math.pow(1.05, 30));
    const levels = fireLevels(input())!;
    const coast = levels.find((l) => l.key === "coast")!;
    expect(coast.amountMinor).toBe(expected);
  });

  it("returns 4 levels in order: coast, lean, regular, fat", () => {
    const levels = fireLevels(input())!;
    expect(levels.map((l) => l.key)).toEqual(["coast", "lean", "regular", "fat"]);
  });
});

describe("fireLevels — ETA coherence with base scenario", () => {
  it("regular ETA uses the same trajectory as the internal projection (net eligible)", () => {
    // fireLevels runs projectFire with fireNumberMinor = fatAmount, then
    // interpolates fractionalFireYear for each level on that trajectory.
    // Verify: if we run the same projection externally and interpolate Regular
    // on the same trajectory, we get the same ETA as the rail reports.
    const fatAmount = Math.round(
      (BASE_CONFIG.monthlySpendingMinor * 1.5 * 12) / BASE_CONFIG.safeWithdrawalRate,
    );
    const regularAmount = Math.round(
      (BASE_CONFIG.monthlySpendingMinor * 12) / BASE_CONFIG.safeWithdrawalRate,
    );
    const base = projectFire({
      startingEligibleMinor: 0,
      monthlyContributionMinor: BASE_CONFIG.monthlySavingsCapacityMinor!,
      expectedRealReturn: BASE_CONFIG.expectedRealReturn!,
      fireNumberMinor: fatAmount,
    }).scenarios.find((s) => s.label === "base")!;

    // Manually interpolate what fireLevels would compute for regular.
    let expectedYears: number | null = null;
    for (let i = 1; i < base.trajectory.length; i++) {
      const prev = base.trajectory[i - 1]!;
      const curr = base.trajectory[i]!;
      if (curr.eligibleMinor >= regularAmount) {
        const frac =
          (regularAmount - prev.eligibleMinor) /
          (curr.eligibleMinor - prev.eligibleMinor);
        expectedYears = Math.round((prev.year + frac) * 10) / 10;
        break;
      }
    }

    const levels = fireLevels(input())!;
    const regular = levels.find((l) => l.key === "regular")!;

    expect(regular.eta.kind).toBe("eta");
    if (regular.eta.kind === "eta") {
      expect(regular.eta.years).toBe(expectedYears);
    }
  });
});

describe("fireLevels — eta ordering (lean ≤ regular ≤ fat)", () => {
  it("lean ETA ≤ regular ETA ≤ fat ETA when starting from 0", () => {
    const levels = fireLevels(input())!;
    const lean = levels.find((l) => l.key === "lean")!;
    const regular = levels.find((l) => l.key === "regular")!;
    const fat = levels.find((l) => l.key === "fat")!;

    const toYears = (l: typeof lean) =>
      l.eta.kind === "eta" ? l.eta.years : l.eta.kind === "reached" ? 0 : Infinity;

    expect(toYears(lean)).toBeLessThanOrEqual(toYears(regular));
    expect(toYears(regular)).toBeLessThanOrEqual(toYears(fat));
  });
});

describe("fireLevels — reached vs eta vs unreachable", () => {
  it("all levels reached when eligible far exceeds fat amount", () => {
    const levels = fireLevels(input({ eligibleMinor: 200_000_000 }))!;
    for (const level of levels) {
      expect(level.eta.kind).toBe("reached");
    }
  });

  it("eta for levels above eligible, reached for levels below", () => {
    const leanAmount = Math.round((200_000 * 0.7 * 12) / 0.04);
    const levels = fireLevels(input({ eligibleMinor: leanAmount + 1_000_000 }))!;
    expect(levels.find((l) => l.key === "lean")!.eta.kind).toBe("reached");
    expect(levels.find((l) => l.key === "regular")!.eta.kind).toBe("eta");
  });

  it("eta years is a positive number when not reached", () => {
    const levels = fireLevels(input())!;
    const regular = levels.find((l) => l.key === "regular")!;
    expect(regular.eta.kind).toBe("eta");
    if (regular.eta.kind === "eta") {
      expect(regular.eta.years).toBeGreaterThan(0);
    }
  });

  it("fat returns unreachable when no contributions and eligible=0", () => {
    // No contributions, zero eligible, massive fat target → never reached.
    const levels = fireLevels(
      input({
        eligibleMinor: 0,
        config: { ...BASE_CONFIG, monthlySavingsCapacityMinor: 0 },
      }),
    )!;
    const fat = levels.find((l) => l.key === "fat")!;
    expect(fat.eta.kind).toBe("unreachable");
  });
});

describe("fireLevels — Barista FIRE (N2, #514)", () => {
  const BARISTA_INCOME = 50_000; // 500 EUR/month in minor

  it("emits a Barista level when baristaMonthlyIncomeMinor > 0", () => {
    const levels = fireLevels(
      input({ config: { ...BASE_CONFIG, baristaMonthlyIncomeMinor: BARISTA_INCOME } }),
    )!;
    expect(levels.find((l) => l.key === "barista")).toBeDefined();
  });

  it("Barista amount = (spending - income) * 12 / SWR", () => {
    const levels = fireLevels(
      input({ config: { ...BASE_CONFIG, baristaMonthlyIncomeMinor: BARISTA_INCOME } }),
    )!;
    const barista = levels.find((l) => l.key === "barista")!;
    // (200_000 - 50_000) * 12 / 0.04 = 45_000_000
    expect(barista.amountMinor).toBe(Math.round(((200_000 - 50_000) * 12) / 0.04));
  });

  it("Barista is positioned before regular in the rail", () => {
    const levels = fireLevels(
      input({ config: { ...BASE_CONFIG, baristaMonthlyIncomeMinor: BARISTA_INCOME } }),
    )!;
    const keys = levels.map((l) => l.key);
    const bIdx = keys.indexOf("barista");
    const rIdx = keys.indexOf("regular");
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeLessThan(rIdx);
  });

  it("Barista ETA ≤ Regular ETA (lower target = sooner)", () => {
    const levels = fireLevels(
      input({ config: { ...BASE_CONFIG, baristaMonthlyIncomeMinor: BARISTA_INCOME } }),
    )!;
    const barista = levels.find((l) => l.key === "barista")!;
    const regular = levels.find((l) => l.key === "regular")!;
    const toYears = (l: typeof barista) =>
      l.eta.kind === "eta" ? l.eta.years : l.eta.kind === "reached" ? 0 : Infinity;
    expect(toYears(barista)).toBeLessThanOrEqual(toYears(regular));
  });

  it("NO Barista level when baristaMonthlyIncomeMinor is undefined", () => {
    const levels = fireLevels(input())!;
    expect(levels.find((l) => l.key === "barista")).toBeUndefined();
  });

  it("NO Barista level when baristaMonthlyIncomeMinor is 0", () => {
    const levels = fireLevels(
      input({ config: { ...BASE_CONFIG, baristaMonthlyIncomeMinor: 0 } }),
    )!;
    expect(levels.find((l) => l.key === "barista")).toBeUndefined();
  });

  it("Barista amount clamps to 0 when income >= spending", () => {
    const levels = fireLevels(
      input({ config: { ...BASE_CONFIG, baristaMonthlyIncomeMinor: 300_000 } }), // > 200_000 spending
    )!;
    const barista = levels.find((l) => l.key === "barista")!;
    expect(barista).toBeDefined();
    expect(barista.amountMinor).toBe(0);
    expect(barista.eta.kind).toBe("reached");
  });

  it("rail order is coast · lean · barista · regular · fat with Barista", () => {
    const levels = fireLevels(
      input({ config: { ...BASE_CONFIG, baristaMonthlyIncomeMinor: BARISTA_INCOME } }),
    )!;
    expect(levels.map((l) => l.key)).toEqual([
      "coast",
      "lean",
      "barista",
      "regular",
      "fat",
    ]);
  });
});

describe("fireLevels — edge cases", () => {
  it("returns null when SWR is 0 (degenerate config → hide rail)", () => {
    const result = fireLevels(
      input({ config: { ...BASE_CONFIG, safeWithdrawalRate: 0 } }),
    );
    expect(result).toBeNull();
  });

  it("returns null when monthlySpending is 0 (degenerate config → hide rail)", () => {
    const result = fireLevels(
      input({ config: { ...BASE_CONFIG, monthlySpendingMinor: 0 } }),
    );
    expect(result).toBeNull();
  });

  it("coast is absent when no currentAge configured", () => {
    const noAge: FireScopeConfig = {
      monthlySpendingMinor: BASE_CONFIG.monthlySpendingMinor,
      safeWithdrawalRate: BASE_CONFIG.safeWithdrawalRate,
      expectedRealReturn: BASE_CONFIG.expectedRealReturn!,
      monthlySavingsCapacityMinor: 100_000,
    };
    const levels = fireLevels(input({ config: noAge }))!;
    expect(levels.find((l) => l.key === "coast")).toBeUndefined();
  });
});
