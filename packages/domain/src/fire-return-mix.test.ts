import { describe, expect, it } from "vitest";

import {
  effectiveRealReturn,
  fireReturnMix,
  TIER_REAL_RETURN_DEFAULTS,
} from "./fire-return";

describe("fireReturnMix", () => {
  it("names every weight behind the rate, and the weights add up to one", () => {
    const mix = fireReturnMix({
      eligibleByTierMinor: { market: 600_000, housing: 400_000 },
    });

    expect(mix.rows.map((row) => [row.key, row.weightFraction, row.rate])).toEqual([
      ["market", 0.6, TIER_REAL_RETURN_DEFAULTS.market],
      ["housing", 0.4, TIER_REAL_RETURN_DEFAULTS.housing],
    ]);
    expect(mix.rows.reduce((sum, row) => sum + row.weightFraction, 0)).toBeCloseTo(1, 10);
    expect(mix.totalMinor).toBe(1_000_000);
  });

  it("each row lends its weight × its rate, and the rows add up to the rate", () => {
    const mix = fireReturnMix({
      eligibleByTierMinor: { market: 266_000, housing: 687_000, illiquid: 27_000 },
    });

    for (const row of mix.rows) {
      expect(row.contribution).toBeCloseTo(row.weightFraction * row.rate, 10);
    }
    expect(mix.rows.reduce((sum, row) => sum + row.contribution, 0)).toBeCloseTo(
      mix.rate,
      10,
    );
  });

  it("is the same engine `effectiveRealReturn` answers with", () => {
    const input = {
      assetRateOverrides: [
        {
          assetId: "asset_rental",
          tier: "housing" as const,
          amountMinor: 300_000,
          rate: 0.042,
        },
      ],
      eligibleByTierMinor: { market: 200_000, housing: 400_000, cash: 100_000 },
      tierRealReturns: { market: 0.06 },
    };

    expect(fireReturnMix(input).rate).toBe(effectiveRealReturn(input));
  });

  it("an asset with its own rate takes its slice out of its rung, never beside it", () => {
    const mix = fireReturnMix({
      assetLabelById: { asset_rental: "Piso de Plasencia" },
      assetRateOverrides: [
        { assetId: "asset_rental", tier: "housing", amountMinor: 300_000, rate: 0.042 },
      ],
      eligibleByTierMinor: { housing: 400_000 },
    });

    expect(mix.rows).toEqual([
      {
        contribution: 0.25 * TIER_REAL_RETURN_DEFAULTS.housing,
        key: "housing",
        kind: "tier",
        label: "Vivienda",
        rate: TIER_REAL_RETURN_DEFAULTS.housing,
        tier: "housing",
        weightFraction: 0.25,
        weightMinor: 100_000,
      },
      {
        contribution: 0.75 * 0.042,
        key: "asset:asset_rental",
        kind: "asset",
        label: "Piso de Plasencia",
        rate: 0.042,
        tier: "housing",
        weightFraction: 0.75,
        weightMinor: 300_000,
      },
    ]);
    expect(mix.rate).toBeCloseTo(0.25 * 0.03 + 0.75 * 0.042, 10);
  });

  it("drops rungs the scope holds nothing in — a 0 % weight explains nothing", () => {
    const mix = fireReturnMix({
      eligibleByTierMinor: { cash: 0, market: 100_000, "term-locked": 0 },
    });

    expect(mix.rows.map((row) => row.key)).toEqual(["market"]);
  });

  it("an empty pool has nothing to explain, and says so with no rows", () => {
    const mix = fireReturnMix({ eligibleByTierMinor: {} });

    expect(mix.rows).toEqual([]);
    expect(mix.totalMinor).toBe(0);
    expect(mix.rate).toBe(TIER_REAL_RETURN_DEFAULTS.market);
  });

  it("falls back to the asset id when nobody handed in its name", () => {
    const mix = fireReturnMix({
      assetRateOverrides: [
        { assetId: "asset_rental", tier: "housing", amountMinor: 400_000, rate: 0.042 },
      ],
      eligibleByTierMinor: { housing: 400_000 },
    });

    expect(mix.rows.map((row) => row.label)).toEqual(["asset_rental"]);
  });
});
