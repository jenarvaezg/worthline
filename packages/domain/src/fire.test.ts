import { describe, expect, it } from "vitest";

import type { ManualAsset, Workspace } from "./index";
import { calculateFire, calculateFireForScope, filterFireEligibleAssets } from "./fire";

const workspace: Workspace = {
  baseCurrency: "EUR",
  mode: "household",
  members: [
    { id: "alice", name: "Alice" },
    { id: "bob", name: "Bob" },
  ],
  groups: [],
};

function makeAsset(
  id: string,
  amountMinor: number,
  isPrimaryResidence = false,
  ownership: { memberId: string; shareBps: number }[] = [
    { memberId: "alice", shareBps: 5000 },
    { memberId: "bob", shareBps: 5000 },
  ],
): ManualAsset {
  return {
    id,
    name: id,
    type: "manual",
    currency: "EUR",
    currentValue: { amountMinor, currency: "EUR" },
    liquidityTier: "market",
    ownership,
    isPrimaryResidence,
  };
}

// ---------------------------------------------------------------------------
// filterFireEligibleAssets
// ---------------------------------------------------------------------------

describe("filterFireEligibleAssets", () => {
  it("excludes primary residence assets", () => {
    const assets = [
      makeAsset("house", 500_000_00, true),
      makeAsset("stocks", 100_000_00, false),
    ];

    const result = filterFireEligibleAssets(assets);

    expect(result.map((a) => a.id)).toEqual(["stocks"]);
  });

  it("excludes explicitly-named asset IDs", () => {
    const assets = [makeAsset("pension", 80_000_00), makeAsset("stocks", 100_000_00)];

    const result = filterFireEligibleAssets(assets, ["pension"]);

    expect(result.map((a) => a.id)).toEqual(["stocks"]);
  });

  it("includes regular non-primary-residence assets", () => {
    const assets = [makeAsset("stocks", 100_000_00), makeAsset("cash", 20_000_00)];

    const result = filterFireEligibleAssets(assets);

    expect(result.map((a) => a.id)).toEqual(["stocks", "cash"]);
  });
});

// ---------------------------------------------------------------------------
// calculateFire
// ---------------------------------------------------------------------------

describe("calculateFire", () => {
  it("FIRE number = (monthlySpendingMinor * 12) / safeWithdrawalRate", () => {
    // monthly spend 2000 EUR → 200000 minor; SWR 4% → fire = 2000*12/0.04 = 600000 EUR → 60000000 minor
    const result = calculateFire(
      {
        monthlySpendingMinor: 200_000,
        safeWithdrawalRate: 0.04,
        expectedRealReturn: 0.07,
      },
      0,
      "EUR",
    );

    expect(result.fireNumber.amountMinor).toBe(60_000_000);
  });

  it("percentFunded = eligibleMinor / fireNumberMinor * 100", () => {
    const result = calculateFire(
      {
        monthlySpendingMinor: 200_000,
        safeWithdrawalRate: 0.04,
        expectedRealReturn: 0.07,
      },
      30_000_000,
      "EUR",
    );

    expect(result.percentFunded).toBeCloseTo(50, 5);
  });

  it("coastFireRequired = fireNumber / pow(1 + return, yearsToRetirement)", () => {
    // fireNumber = 200000*12/0.04 = 60000000
    // yearsToRetirement = 65 - 35 = 30
    // coastRequired = 60000000 / 1.07^30
    const result = calculateFire(
      {
        monthlySpendingMinor: 200_000,
        safeWithdrawalRate: 0.04,
        expectedRealReturn: 0.07,
        currentAge: 35,
        targetRetirementAge: 65,
      },
      0,
      "EUR",
    );

    const expected = Math.round(60_000_000 / Math.pow(1.07, 30));
    expect(result.coastFireRequired?.amountMinor).toBe(expected);
  });

  it("coastFireAge = currentAge + log(fireNumber/eligible) / log(1+return)", () => {
    // eligible = 10000000, fireNumber = 60000000, return = 0.07, currentAge = 35
    // coastAge = 35 + log(60000000/10000000) / log(1.07)
    const eligible = 10_000_000;
    const fireNumber = 60_000_000;
    const expectedAge = 35 + Math.log(fireNumber / eligible) / Math.log(1.07);

    const result = calculateFire(
      {
        monthlySpendingMinor: 200_000,
        safeWithdrawalRate: 0.04,
        expectedRealReturn: 0.07,
        currentAge: 35,
        targetRetirementAge: 65,
      },
      eligible,
      "EUR",
    );

    expect(result.coastFireAge).toBeCloseTo(expectedAge, 5);
  });
});

// ---------------------------------------------------------------------------
// calculateFireForScope
// ---------------------------------------------------------------------------

describe("calculateFireForScope", () => {
  it("scopes down by member ownership correctly", () => {
    // alice owns 100% of asset worth 200000 minor; bob owns 0%
    const assets = [
      makeAsset("etf", 200_000, false, [{ memberId: "alice", shareBps: 10_000 }]),
      // second asset split evenly
      makeAsset("bonds", 100_000, false, [
        { memberId: "alice", shareBps: 5_000 },
        { memberId: "bob", shareBps: 5_000 },
      ]),
    ];

    const aliceResult = calculateFireForScope(
      {
        monthlySpendingMinor: 100_000,
        safeWithdrawalRate: 0.04,
        expectedRealReturn: 0.07,
      },
      assets,
      workspace,
      "alice",
    );

    // alice's eligible: 200000 (etf full) + 50000 (bonds half) = 250000
    expect(aliceResult.eligibleAssets.amountMinor).toBe(250_000);
  });
});
