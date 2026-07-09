import { describe, expect, it } from "vitest";
import { calculateFire, calculateFireForScope } from "./fire";
import { TIER_REAL_RETURN_DEFAULTS } from "./fire-return";
import type { Liability, ManualAsset, Workspace } from "./index";

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

function makeLiability(
  id: string,
  balanceMinor: number,
  associatedAssetId?: string,
  ownership: { memberId: string; shareBps: number }[] = [
    { memberId: "alice", shareBps: 10_000 },
  ],
): Liability {
  return {
    id,
    name: id,
    type: associatedAssetId ? "mortgage" : "debt",
    currency: "EUR",
    currentBalance: { amountMinor: balanceMinor, currency: "EUR" },
    ownership,
    ...(associatedAssetId ? { associatedAssetId } : {}),
  };
}

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

  it("suppresses coastFireAge when the real return cannot compound to FIRE", () => {
    const config = {
      monthlySpendingMinor: 200_000,
      safeWithdrawalRate: 0.04,
      currentAge: 35,
      targetRetirementAge: 65,
    };

    const zeroReturn = calculateFire(config, 10_000_000, "EUR", 0);
    const negativeReturn = calculateFire(config, 10_000_000, "EUR", -0.01);

    expect(zeroReturn.coastFireAge).toBeUndefined();
    expect(negativeReturn.coastFireAge).toBeUndefined();
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
      [],
      workspace,
      "alice",
    );

    // alice's eligible: 200000 (etf full) + 50000 (bonds half) = 250000
    expect(aliceResult.eligibleAssets.amountMinor).toBe(250_000);
  });

  it("lists the primary residence as an excluded asset", () => {
    const assets = [
      makeAsset("house", 500_000_00, true),
      makeAsset("stocks", 100_000_00, false),
    ];

    const result = calculateFireForScope(
      {
        monthlySpendingMinor: 100_000,
        safeWithdrawalRate: 0.04,
        expectedRealReturn: 0.07,
      },
      assets,
      [],
      workspace,
      "household",
    );

    expect(result.excludedAssets).toEqual([
      { id: "house", name: "house", reason: "primary_residence" },
    ]);
    // The formula is untouched: only stocks count.
    expect(result.eligibleAssets.amountMinor).toBe(100_000_00);
  });

  it("lists manually-excluded assets with reason 'manual'", () => {
    const assets = [makeAsset("pension", 80_000_00), makeAsset("stocks", 100_000_00)];

    const result = calculateFireForScope(
      {
        monthlySpendingMinor: 100_000,
        safeWithdrawalRate: 0.04,
        expectedRealReturn: 0.07,
        excludedAssetIds: ["pension"],
      },
      assets,
      [],
      workspace,
      "household",
    );

    expect(result.excludedAssets).toEqual([
      { id: "pension", name: "pension", reason: "manual" },
    ]);
    expect(result.eligibleAssets.amountMinor).toBe(100_000_00);
  });

  it("reports no excluded assets when everything counts", () => {
    const assets = [makeAsset("stocks", 100_000_00), makeAsset("cash", 20_000_00)];

    const result = calculateFireForScope(
      {
        monthlySpendingMinor: 100_000,
        safeWithdrawalRate: 0.04,
        expectedRealReturn: 0.07,
      },
      assets,
      [],
      workspace,
      "household",
    );

    expect(result.excludedAssets).toEqual([]);
  });

  it("omits an excluded asset the scope does not own (zero owned value)", () => {
    // The primary residence belongs entirely to bob; alice's scope holds none.
    const assets = [
      makeAsset("house", 500_000_00, true, [{ memberId: "bob", shareBps: 10_000 }]),
      makeAsset("stocks", 100_000_00, false, [{ memberId: "alice", shareBps: 10_000 }]),
    ];

    const result = calculateFireForScope(
      {
        monthlySpendingMinor: 100_000,
        safeWithdrawalRate: 0.04,
        expectedRealReturn: 0.07,
      },
      assets,
      [],
      workspace,
      "alice",
    );

    expect(result.excludedAssets).toEqual([]);
    expect(result.eligibleAssets.amountMinor).toBe(100_000_00);
  });

  it("subtracts reserved goal capital from eligible assets (#426)", () => {
    const assets = [
      makeAsset("stocks", 100_000_00, false, [{ memberId: "alice", shareBps: 10_000 }]),
    ];
    const config = {
      monthlySpendingMinor: 100_000,
      safeWithdrawalRate: 0.04,
      expectedRealReturn: 0.07,
    };

    const result = calculateFireForScope(
      config,
      assets,
      [],
      workspace,
      "alice",
      30_000_00,
    );

    // eligible drops by the reservation; gross/excluded are untouched
    expect(result.eligibleAssets.amountMinor).toBe(70_000_00);
    expect(result.reservedForGoals?.amountMinor).toBe(30_000_00);
  });

  it("clamps the reservation to the eligible total (never negative eligible)", () => {
    const assets = [
      makeAsset("stocks", 10_000_00, false, [{ memberId: "alice", shareBps: 10_000 }]),
    ];
    const config = {
      monthlySpendingMinor: 100_000,
      safeWithdrawalRate: 0.04,
      expectedRealReturn: 0.07,
    };

    const result = calculateFireForScope(
      config,
      assets,
      [],
      workspace,
      "alice",
      50_000_00,
    );

    expect(result.eligibleAssets.amountMinor).toBe(0);
    expect(result.reservedForGoals?.amountMinor).toBe(10_000_00);
  });

  it("nets the scope's debt against eligible capital (mortgage + unsecured loan)", () => {
    // A second property (not the primary residence) counts at full value; its
    // mortgage and an unsecured loan reduce the drawable capital.
    const assets = [
      makeAsset("rental", 170_000_00, false, [{ memberId: "alice", shareBps: 10_000 }]),
    ];
    const liabilities = [
      makeLiability("rental-mortgage", 77_000_00, "rental"),
      makeLiability("loan", 15_000_00),
    ];
    const config = {
      monthlySpendingMinor: 100_000,
      safeWithdrawalRate: 0.04,
      expectedRealReturn: 0.07,
    };

    const result = calculateFireForScope(config, assets, liabilities, workspace, "alice");

    // 170k − 77k mortgage − 15k loan = 78k
    expect(result.eligibleAssets.amountMinor).toBe(78_000_00);
  });

  it("keeps non-primary property eligible and includes housing in the return weighting", () => {
    const stocks = makeAsset("stocks", 100_000_00, false, [
      { memberId: "alice", shareBps: 10_000 },
    ]);
    const rental: ManualAsset = {
      ...makeAsset("rental", 100_000_00, false, [
        { memberId: "alice", shareBps: 10_000 },
      ]),
      instrument: "property",
      liquidityTier: "illiquid",
      type: "real_estate",
    };

    const result = calculateFireForScope(
      {
        monthlySpendingMinor: 100_000,
        safeWithdrawalRate: 0.04,
      },
      [stocks, rental],
      [],
      workspace,
      "alice",
    );

    expect(result.eligibleAssets.amountMinor).toBe(200_000_00);
    expect(result.effectiveRealReturn).toBeCloseTo(
      (TIER_REAL_RETURN_DEFAULTS.market + TIER_REAL_RETURN_DEFAULTS.housing) / 2,
      10,
    );
  });

  it("does NOT subtract a mortgage secured against the excluded primary residence", () => {
    // The home is excluded as an asset, so its mortgage is dropped with it —
    // netting it too would double-count the exclusion.
    const assets = [
      makeAsset("home", 480_000_00, true, [{ memberId: "alice", shareBps: 10_000 }]),
      makeAsset("stocks", 100_000_00, false, [{ memberId: "alice", shareBps: 10_000 }]),
    ];
    const liabilities = [makeLiability("home-mortgage", 320_000_00, "home")];
    const config = {
      monthlySpendingMinor: 100_000,
      safeWithdrawalRate: 0.04,
      expectedRealReturn: 0.07,
    };

    const result = calculateFireForScope(config, assets, liabilities, workspace, "alice");

    expect(result.eligibleAssets.amountMinor).toBe(100_000_00);
  });

  it("clamps net eligible at 0 when debt exceeds eligible assets (underwater)", () => {
    const assets = [
      makeAsset("stocks", 10_000_00, false, [{ memberId: "alice", shareBps: 10_000 }]),
    ];
    const liabilities = [makeLiability("loan", 50_000_00)];
    const config = {
      monthlySpendingMinor: 100_000,
      safeWithdrawalRate: 0.04,
      expectedRealReturn: 0.07,
    };

    const result = calculateFireForScope(config, assets, liabilities, workspace, "alice");

    expect(result.eligibleAssets.amountMinor).toBe(0);
  });

  it("calculateFire returns an empty excludedAssets list", () => {
    const result = calculateFire(
      {
        monthlySpendingMinor: 200_000,
        safeWithdrawalRate: 0.04,
        expectedRealReturn: 0.07,
      },
      30_000_000,
      "EUR",
    );

    expect(result.excludedAssets).toEqual([]);
  });
});
