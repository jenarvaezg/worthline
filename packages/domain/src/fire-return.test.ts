import { describe, expect, it } from "vitest";

import { effectiveRealReturn, TIER_REAL_RETURN_DEFAULTS } from "./fire-return";

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

  it("the four non-housing tiers equal weight → average of defaults", () => {
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

  it("housing tier participates when property is FIRE-eligible", () => {
    const result = effectiveRealReturn({
      eligibleByTierMinor: { market: 100_000, housing: 100_000 },
    });

    expect(result).toBeCloseTo(
      (TIER_REAL_RETURN_DEFAULTS.market + TIER_REAL_RETURN_DEFAULTS.housing) / 2,
      10,
    );
  });
});

// ── per-asset overrides (#1448) ────────────────────────────────────────────────

describe("effectiveRealReturn with per-asset overrides", () => {
  it("substitutes the tier rate over the asset's slice, never adds one", () => {
    // 100.000 € of housing, of which 60.000 € is a flat yielding 4,5 % net; the
    // remaining 40.000 € stays on the housing default (3 %).
    const result = effectiveRealReturn({
      assetRateOverrides: [
        { amountMinor: 60_000, assetId: "piso", rate: 0.045, tier: "housing" },
      ],
      eligibleByTierMinor: { housing: 100_000 },
    });

    expect(result).toBeCloseTo(0.6 * 0.045 + 0.4 * TIER_REAL_RETURN_DEFAULTS.housing, 10);
  });

  it("an override covering the whole tier leaves the tier default unused", () => {
    const result = effectiveRealReturn({
      assetRateOverrides: [
        { amountMinor: 100_000, assetId: "piso", rate: 0.041, tier: "housing" },
      ],
      eligibleByTierMinor: { housing: 100_000 },
    });

    expect(result).toBeCloseTo(0.041, 10);
  });

  it("Jorge's mix: the brick's own yield moves the portfolio rate", () => {
    // 370.000 € of rented brick at 4,2 % net + 168.000 € of market at 5 %.
    const withDefaults = effectiveRealReturn({
      eligibleByTierMinor: { housing: 37_000_000, market: 16_800_000 },
    });
    const withRent = effectiveRealReturn({
      assetRateOverrides: [
        { amountMinor: 37_000_000, assetId: "ladrillo", rate: 0.042, tier: "housing" },
      ],
      eligibleByTierMinor: { housing: 37_000_000, market: 16_800_000 },
    });

    expect(withDefaults).toBeCloseTo(0.0362, 4);
    expect(withRent).toBeCloseTo(0.0445, 4);
  });

  it("a negative asset rate drags the weighted rate down, it is not clamped away", () => {
    const result = effectiveRealReturn({
      assetRateOverrides: [
        { amountMinor: 50_000, assetId: "ruina", rate: -0.02, tier: "housing" },
      ],
      eligibleByTierMinor: { housing: 50_000, market: 50_000 },
    });

    expect(result).toBeCloseTo(0.5 * -0.02 + 0.5 * TIER_REAL_RETURN_DEFAULTS.market, 10);
  });

  it("a per-tier override still applies to the non-overridden remainder", () => {
    const result = effectiveRealReturn({
      assetRateOverrides: [
        { amountMinor: 40_000, assetId: "piso", rate: 0.05, tier: "housing" },
      ],
      eligibleByTierMinor: { housing: 100_000 },
      tierRealReturns: { housing: 0.01 },
    });

    expect(result).toBeCloseTo(0.4 * 0.05 + 0.6 * 0.01, 10);
  });

  it("no overrides → identical to the tier-only weighting", () => {
    const mix = { housing: 100_000, market: 100_000 };
    expect(
      effectiveRealReturn({ assetRateOverrides: [], eligibleByTierMinor: mix }),
    ).toBeCloseTo(effectiveRealReturn({ eligibleByTierMinor: mix }), 10);
  });
});
