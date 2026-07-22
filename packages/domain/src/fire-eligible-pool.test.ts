import { describe, expect, it } from "vitest";
import { assembleFireEligiblePool } from "./fire-eligible-pool";
import type { Liability, ManualAsset, Workspace } from "./index";

// ---------------------------------------------------------------------------
// Fixtures — a two-member household so scope allocation is exercised.
// ---------------------------------------------------------------------------

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
  overrides: Partial<
    Pick<ManualAsset, "isPrimaryResidence" | "liquidityTier" | "ownership">
  > = {},
): ManualAsset {
  return {
    id,
    name: id,
    type: "manual",
    currency: "EUR",
    currentValue: { amountMinor, currency: "EUR" },
    liquidityTier: overrides.liquidityTier ?? "market",
    ownership: overrides.ownership ?? [
      { memberId: "alice", shareBps: 5000 },
      { memberId: "bob", shareBps: 5000 },
    ],
    isPrimaryResidence: overrides.isPrimaryResidence ?? false,
  };
}

function makeLiability(
  id: string,
  balanceMinor: number,
  associatedAssetId?: string,
  ownership: { memberId: string; shareBps: number }[] = [
    { memberId: "alice", shareBps: 5000 },
    { memberId: "bob", shareBps: 5000 },
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

const HOUSEHOLD_SCOPE = "household";

function assemble(
  assets: ManualAsset[],
  liabilities: Liability[] = [],
  excludedAssetIds: string[] = [],
) {
  return assembleFireEligiblePool({
    config: { excludedAssetIds },
    assets,
    liabilities,
    workspace,
    scopeId: HOUSEHOLD_SCOPE,
  });
}

describe("assembleFireEligiblePool", () => {
  it("sums scope-owned eligible assets and nets scoped debt", () => {
    const pool = assemble(
      [makeAsset("stocks", 100_000), makeAsset("cash", 40_000)],
      [makeLiability("loan", 30_000)],
    );

    expect(pool.eligiblePreDebtMinor).toBe(140_000);
    expect(pool.scopedDebtMinor).toBe(30_000);
    expect(pool.netEligibleMinor).toBe(110_000);
    expect(pool.excludedAssets).toEqual([]);
  });

  it("excludes the primary residence and surfaces it as an exclusion", () => {
    const pool = assemble([
      makeAsset("home", 500_000, { isPrimaryResidence: true }),
      makeAsset("stocks", 100_000),
    ]);

    expect(pool.eligiblePreDebtMinor).toBe(100_000);
    expect(pool.netEligibleMinor).toBe(100_000);
    expect(pool.excludedAssets).toEqual([
      { id: "home", name: "home", reason: "primary_residence" },
    ]);
  });

  it("excludes manually excluded assets (config.excludedAssetIds)", () => {
    const pool = assemble(
      [makeAsset("gold", 20_000), makeAsset("stocks", 100_000)],
      [],
      ["gold"],
    );

    expect(pool.eligiblePreDebtMinor).toBe(100_000);
    expect(pool.excludedAssets).toEqual([{ id: "gold", name: "gold", reason: "manual" }]);
  });

  // ── Subtle case #1: debt secured against an EXCLUDED asset is dropped, not netted.
  it("drops debt secured against an excluded asset instead of double-counting", () => {
    const pool = assemble(
      [
        makeAsset("home", 500_000, { isPrimaryResidence: true }),
        makeAsset("stocks", 200_000),
      ],
      [makeLiability("mortgage", 300_000, "home")],
    );

    // Home is excluded; its mortgage rides out with it. Only the eligible stocks
    // remain and no debt is netted against them.
    expect(pool.eligiblePreDebtMinor).toBe(200_000);
    expect(pool.scopedDebtMinor).toBe(0);
    expect(pool.netEligibleMinor).toBe(200_000);
  });

  it("nets debt secured against an eligible asset", () => {
    const pool = assemble(
      [makeAsset("rental", 300_000), makeAsset("stocks", 100_000)],
      [makeLiability("rental-loan", 120_000, "rental")],
    );

    expect(pool.scopedDebtMinor).toBe(120_000);
    expect(pool.netEligibleMinor).toBe(280_000);
  });

  // ── Subtle case #2: a misclassified tier still accumulates under its own key.
  it("accumulates eligible minor per tier, including a housing-tier asset that is not the primary residence", () => {
    const pool = assemble([
      makeAsset("etf", 100_000, { liquidityTier: "market" }),
      makeAsset("second-home", 250_000, { liquidityTier: "housing" }),
      makeAsset("savings", 50_000, { liquidityTier: "cash" }),
    ]);

    expect(pool.eligibleByTierMinor).toEqual({
      market: 100_000,
      housing: 250_000,
      cash: 50_000,
    });
    // The housing-tier asset is NOT the primary residence, so it stays eligible.
    expect(pool.eligiblePreDebtMinor).toBe(400_000);
    expect(pool.excludedAssets).toEqual([]);
  });

  it("keeps tier weights gross — an excluded asset never lands in the tier mix", () => {
    const pool = assemble(
      [
        makeAsset("etf", 100_000, { liquidityTier: "market" }),
        makeAsset("gold", 60_000, { liquidityTier: "illiquid" }),
      ],
      [],
      ["gold"],
    );

    expect(pool.eligibleByTierMinor).toEqual({ market: 100_000 });
  });

  // ── Subtle case #3: an underwater scope clamps to zero, not negative capital.
  it("clamps net eligible at zero when scoped debt exceeds eligible assets", () => {
    const pool = assemble(
      [makeAsset("stocks", 50_000)],
      [makeLiability("loan", 200_000)],
    );

    expect(pool.eligiblePreDebtMinor).toBe(50_000);
    expect(pool.scopedDebtMinor).toBe(200_000);
    expect(pool.netEligibleMinor).toBe(0);
    // Tier weights stay gross even underwater — debt only shifts the level.
    expect(pool.eligibleByTierMinor).toEqual({ market: 50_000 });
  });

  it("is scope-relative: an excluded asset owned entirely outside the scope is not surfaced", () => {
    // A bob-only asset seen from an alice-only scope contributes 0 owned minor.
    const aliceScope: Workspace = {
      ...workspace,
      groups: [{ id: "alice-only", name: "Alice", memberIds: ["alice"] }],
    };
    const pool = assembleFireEligiblePool({
      config: { excludedAssetIds: ["bob-gold"] },
      assets: [
        makeAsset("bob-gold", 40_000, {
          ownership: [{ memberId: "bob", shareBps: 10_000 }],
        }),
        makeAsset("shared-etf", 100_000),
      ],
      liabilities: [],
      workspace: aliceScope,
      scopeId: "alice-only",
    });

    // Alice owns 0 of bob-gold, so the exclusion is silent (not noise), and she
    // owns half of the shared ETF.
    expect(pool.excludedAssets).toEqual([]);
    expect(pool.eligiblePreDebtMinor).toBe(50_000);
  });

  it("allocates by ownership share within a single-member scope", () => {
    const aliceScope: Workspace = {
      ...workspace,
      groups: [{ id: "alice-only", name: "Alice", memberIds: ["alice"] }],
    };
    const pool = assembleFireEligiblePool({
      config: {},
      assets: [makeAsset("shared-etf", 100_000)],
      liabilities: [makeLiability("shared-loan", 40_000)],
      workspace: aliceScope,
      scopeId: "alice-only",
    });

    // Alice's 50% of a 100k asset and 50% of a 40k debt.
    expect(pool.eligiblePreDebtMinor).toBe(50_000);
    expect(pool.scopedDebtMinor).toBe(20_000);
    expect(pool.netEligibleMinor).toBe(30_000);
  });
});
