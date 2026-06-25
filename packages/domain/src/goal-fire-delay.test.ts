/**
 * Tests for goalFireDelay (PRD #507 S4, issue #512).
 *
 * The helper answers: "how many months does THIS goal delay my FIRE date?"
 * It runs projectFire twice (WITH and WITHOUT the goal's reservation) on the
 * base scenario, interpolates the fractional crossing year, and returns the
 * delta in rounded months.
 */

import { describe, expect, it } from "vitest";

import type { Goal } from "./goals";
import type { FireScopeConfig } from "./fire";
import { goalFireDelay } from "./goal-fire-delay";

// ── shared fixture helpers ──────────────────────────────────────────────────

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "g1",
    name: "Coche",
    targetAmountMinor: 2_000_000, // 20 000 €
    deadline: "2028-01-01",
    priority: "high",
    scopeId: "household",
    assetIds: [],
    ...overrides,
  };
}

const BASE_CONFIG: FireScopeConfig = {
  monthlySpendingMinor: 200_000, // 2 000 €/month
  safeWithdrawalRate: 0.04,
  expectedRealReturn: 0.05,
  currentAge: 35,
  targetRetirementAge: 55,
  monthlySavingsCapacityMinor: 100_000, // 1 000 €/month
};

// fireNumber = 2000 * 12 / 0.04 = 600 000 € = 60_000_000 minor
// fireReservationHorizon = 2026 + (55-35) = 2046

// ── 1. revaluation captured ─────────────────────────────────────────────────

describe("goalFireDelay – revaluation captured", () => {
  it("delay reflects compounding: months < naive linear estimate", () => {
    // eligible = 30 000 000 minor (300 000 €), reservation = 2 000 000 (20 000 €)
    // naive linear: (2M / (100k*12)) * 12 = 20 months
    // with compounding at 5%: interpolated delta = 9 months
    const result = goalFireDelay({
      goal: makeGoal({ targetAmountMinor: 2_000_000 }),
      otherReservationsMinor: 0,
      eligibleGrossMinor: 30_000_000,
      thisGoalReservationMinor: 2_000_000,
      config: BASE_CONFIG,
      now: "2026-06-25",
    });

    expect(result.kind).toBe("delays");
    if (result.kind !== "delays") return;

    // Pinned value: interpolated crossing delta = 9 months.
    expect(result.months).toBe(9);

    // Compounding proof: delay (9) is strictly less than the naive linear
    // estimate of 20 months — because compounding erodes the gap faster.
    const naiveLinearMonths = Math.round((2_000_000 / (100_000 * 12)) * 12);
    expect(result.months).toBeLessThan(naiveLinearMonths);
  });
});

// ── 2. marginal: other reservations already applied ─────────────────────────

describe("goalFireDelay – marginal computation", () => {
  it("marginal delay differs from absolute delay (other reservations shift the base)", () => {
    // absolute: base = 30M, reservation = 2M → starts 28M
    const resultAbsolute = goalFireDelay({
      goal: makeGoal({ id: "g2", targetAmountMinor: 2_000_000 }),
      otherReservationsMinor: 0,
      eligibleGrossMinor: 30_000_000,
      thisGoalReservationMinor: 2_000_000,
      config: BASE_CONFIG,
      now: "2026-06-25",
    });

    // marginal: goal-1 already reserved 2M → base = 28M, this goal adds 2M → starts 26M
    const resultMarginal = goalFireDelay({
      goal: makeGoal({ id: "g2", targetAmountMinor: 2_000_000 }),
      otherReservationsMinor: 2_000_000,
      eligibleGrossMinor: 30_000_000,
      thisGoalReservationMinor: 2_000_000,
      config: BASE_CONFIG,
      now: "2026-06-25",
    });

    expect(resultAbsolute.kind).toBe("delays");
    expect(resultMarginal.kind).toBe("delays");
    if (resultAbsolute.kind !== "delays" || resultMarginal.kind !== "delays") return;

    // Pinned: absolute = 9, marginal = 10 (starting lower makes the gap harder to close).
    expect(resultAbsolute.months).toBe(9);
    expect(resultMarginal.months).toBe(10);

    // Real point: marginal ≠ absolute (non-linear compounding, not a simple sum).
    expect(resultMarginal.months).not.toBe(resultAbsolute.months);
  });
});

// ── 3. interpolation → non-12-multiple month count ──────────────────────────

describe("goalFireDelay – interpolation produces non-12-multiple months", () => {
  it("fractional crossing yields a pinned non-zero, non-12-multiple month count", () => {
    // eligible=25M, contribution=200k/month=2.4M/yr, reservation=3M
    // horizon = 2046, deadline 2029-01-01 is in-horizon
    // Pinned interpolation delta: 10 months (not 0, not a multiple of 12)
    const config: FireScopeConfig = {
      ...BASE_CONFIG,
      monthlySavingsCapacityMinor: 200_000,
    };

    const result = goalFireDelay({
      goal: makeGoal({ targetAmountMinor: 3_000_000, deadline: "2029-01-01" }),
      otherReservationsMinor: 0,
      eligibleGrossMinor: 25_000_000,
      thisGoalReservationMinor: 3_000_000,
      config,
      now: "2026-06-25",
    });

    expect(result.kind).toBe("delays");
    if (result.kind !== "delays") return;

    expect(result.months).toBe(10);
    // Not a multiple of 12 → proves the fractional interpolation is doing work.
    expect(result.months % 12).not.toBe(0);
  });
});

// ── 4. no_effect: deadline ≥ horizon (fireReservationHorizon) ────────────────

describe("goalFireDelay – no_effect when deadline is at or after the FIRE horizon", () => {
  it("returns no_effect when goal deadline >= fireReservationHorizon (not a projectFire date)", () => {
    // horizon = 2026-06-25 + 20y = 2046-06-25
    // deadline 2050-01-01 >= "2046-06-25" → out of horizon → no_effect
    const result = goalFireDelay({
      goal: makeGoal({ targetAmountMinor: 1_000_000, deadline: "2050-01-01" }),
      otherReservationsMinor: 0,
      eligibleGrossMinor: 30_000_000,
      thisGoalReservationMinor: 1_000_000,
      config: BASE_CONFIG,
      now: "2026-06-25",
    });

    expect(result.kind).toBe("no_effect");
  });

  it("returns delays (not no_effect) for a deadline in the horizon-divergence window", () => {
    // This is the critical consistency test: a deadline that is AFTER the
    // projectFire crossing year (~2036 for eligible=30M) but BEFORE the
    // fireReservationHorizon (2046). The old projectFire-derived guard would
    // wrongly return no_effect here; the unified horizon fix returns delays,
    // consistent with countsTowardFire=true for the same goal.
    // deadline 2040-01-01: > ~2036 projectFire year, < 2046 horizon.
    const result = goalFireDelay({
      goal: makeGoal({ targetAmountMinor: 2_000_000, deadline: "2040-01-01" }),
      otherReservationsMinor: 0,
      eligibleGrossMinor: 30_000_000,
      thisGoalReservationMinor: 2_000_000,
      config: BASE_CONFIG,
      now: "2026-06-25",
    });

    // countsTowardFire would be true for this goal (future + before horizon 2046)
    // so fireDelay must also be delays, not no_effect.
    expect(result.kind).toBe("delays");
    if (result.kind !== "delays") return;
    expect(result.months).toBeGreaterThanOrEqual(0);
  });
});

// ── 5. no_effect: reservation 0 / no horizon ─────────────────────────────────

describe("goalFireDelay – no_effect when reservation is 0 or no horizon", () => {
  it("returns no_effect for zero thisGoalReservationMinor (no holdings assigned)", () => {
    const result = goalFireDelay({
      goal: makeGoal({ targetAmountMinor: 2_000_000 }),
      otherReservationsMinor: 0,
      eligibleGrossMinor: 30_000_000,
      thisGoalReservationMinor: 0, // caller passes 0 when out-of-horizon or unassigned
      config: BASE_CONFIG,
      now: "2026-06-25",
    });
    expect(result.kind).toBe("no_effect");
  });

  it("returns no_effect when goal deadline is in the past", () => {
    const result = goalFireDelay({
      goal: makeGoal({ targetAmountMinor: 2_000_000, deadline: "2020-01-01" }),
      otherReservationsMinor: 0,
      eligibleGrossMinor: 30_000_000,
      thisGoalReservationMinor: 2_000_000,
      config: BASE_CONFIG,
      now: "2026-06-25",
    });
    expect(result.kind).toBe("no_effect");
  });

  it("returns no_effect when there is no FIRE horizon (no currentAge)", () => {
    const configNoAge: FireScopeConfig = {
      monthlySpendingMinor: 200_000,
      safeWithdrawalRate: 0.04,
      expectedRealReturn: 0.05,
      monthlySavingsCapacityMinor: 100_000,
      // currentAge omitted → fireReservationHorizon returns undefined
    };
    const result = goalFireDelay({
      goal: makeGoal({ targetAmountMinor: 2_000_000 }),
      otherReservationsMinor: 0,
      eligibleGrossMinor: 30_000_000,
      thisGoalReservationMinor: 2_000_000,
      config: configNoAge,
      now: "2026-06-25",
    });
    expect(result.kind).toBe("no_effect");
  });
});

// ── 6. clamps / edge cases ───────────────────────────────────────────────────

describe("goalFireDelay – clamps and edge cases", () => {
  it("returns 0 months (or no_effect) when already FI, never NaN or negative", () => {
    // eligible > fireNumber → both runs yearsToFire=0 → 0 delta
    const result = goalFireDelay({
      goal: makeGoal({ targetAmountMinor: 2_000_000 }),
      otherReservationsMinor: 0,
      eligibleGrossMinor: 70_000_000, // > 60M fireNumber
      thisGoalReservationMinor: 2_000_000,
      config: BASE_CONFIG,
      now: "2026-06-25",
    });

    if (result.kind === "delays") {
      expect(result.months).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(result.months)).toBe(false);
    } else {
      expect(result.kind).toBe("no_effect");
    }
  });

  it("handles never-reaches-FIRE-within-horizon gracefully (no NaN, no crash)", () => {
    const config: FireScopeConfig = {
      ...BASE_CONFIG,
      monthlySavingsCapacityMinor: 0,
    };
    const result = goalFireDelay({
      goal: makeGoal({ targetAmountMinor: 2_000_000 }),
      otherReservationsMinor: 0,
      eligibleGrossMinor: 1_000_000,
      thisGoalReservationMinor: 2_000_000,
      config,
      now: "2026-06-25",
    });

    if (result.kind === "delays") {
      expect(result.months).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(result.months)).toBe(false);
      expect(Number.isFinite(result.months)).toBe(true);
    } else {
      expect(result.kind).toBe("no_effect");
    }
  });
});
