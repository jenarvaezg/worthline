import { describe, expect, it } from "vitest";

import { TIER_REAL_RETURN_DEFAULTS, effectiveRealReturn } from "./fire-return";

// ── effectiveRealReturn ───────────────────────────────────────────────────────

describe("effectiveRealReturn", () => {
  it("2-tier mix: 60% market@5% + 40% cash@0% → 3.0%", () => {
    const result = effectiveRealReturn({
      eligibleByTierMinor: { market: 600_000, cash: 400_000 },
    });
    expect(result).toBeCloseTo(0.03, 10);
  });

  it("single market tier → market default (5%)", () => {
    const result = effectiveRealReturn({
      eligibleByTierMinor: { market: 100_000 },
    });
    expect(result).toBeCloseTo(TIER_REAL_RETURN_DEFAULTS.market, 10);
  });

  it("single cash tier → 0%", () => {
    const result = effectiveRealReturn({
      eligibleByTierMinor: { cash: 100_000 },
    });
    expect(result).toBeCloseTo(0, 10);
  });

  it("all four eligible tiers equal weight → average of defaults", () => {
    const avg =
      (TIER_REAL_RETURN_DEFAULTS.cash +
        TIER_REAL_RETURN_DEFAULTS.market +
        TIER_REAL_RETURN_DEFAULTS["term-locked"] +
        TIER_REAL_RETURN_DEFAULTS.illiquid) /
      4;
    const result = effectiveRealReturn({
      eligibleByTierMinor: {
        cash: 100,
        market: 100,
        "term-locked": 100,
        illiquid: 100,
      },
    });
    expect(result).toBeCloseTo(avg, 10);
  });

  it("per-tier override changes the result", () => {
    // 100% market but override to 10%
    const result = effectiveRealReturn({
      eligibleByTierMinor: { market: 100_000 },
      tierRealReturns: { market: 0.1 },
    });
    expect(result).toBeCloseTo(0.1, 10);
  });

  it("per-tier override only affects the overridden tier", () => {
    // 50% market@default(5%) + 50% term-locked@override(3%)
    const result = effectiveRealReturn({
      eligibleByTierMinor: { market: 500, "term-locked": 500 },
      tierRealReturns: { "term-locked": 0.03 },
    });
    expect(result).toBeCloseTo(0.5 * 0.05 + 0.5 * 0.03, 10);
  });

  it("total 0 → safe fallback (market default), no NaN", () => {
    const result = effectiveRealReturn({ eligibleByTierMinor: {} });
    expect(Number.isNaN(result)).toBe(false);
    expect(result).toBe(TIER_REAL_RETURN_DEFAULTS.market);
  });

  it("total 0 with custom market override → uses the override as fallback", () => {
    const result = effectiveRealReturn({
      eligibleByTierMinor: {},
      tierRealReturns: { market: 0.08 },
    });
    expect(result).toBeCloseTo(0.08, 10);
  });

  it("housing tier in input is ignored (not an eligible tier)", () => {
    // Only market counts; housing should be ignored
    const withHousing = effectiveRealReturn({
      eligibleByTierMinor: { market: 100_000, housing: 500_000 },
    });
    const withoutHousing = effectiveRealReturn({
      eligibleByTierMinor: { market: 100_000 },
    });
    expect(withHousing).toBeCloseTo(withoutHousing, 10);
  });
});
