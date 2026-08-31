import { describe, expect, it } from "vitest";
import { assembleFireEligiblePool } from "./fire-eligible-pool";
import type { RentDerivedReturn, RentReturnNotice } from "./fire-rent-return";
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
    Pick<
      ManualAsset,
      | "availableFrom"
      | "contributionLots"
      | "isPrimaryResidence"
      | "liquidityTier"
      | "ownership"
    >
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
    ...(overrides.availableFrom ? { availableFrom: overrides.availableFrom } : {}),
    ...(overrides.contributionLots
      ? { contributionLots: overrides.contributionLots }
      : {}),
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
  todayISO?: string,
) {
  return assembleFireEligiblePool({
    config: { excludedAssetIds },
    assets,
    liabilities,
    workspace,
    scopeId: HOUSEHOLD_SCOPE,
    ...(todayISO === undefined ? {} : { todayISO }),
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

  // ── The debt has a rung too (#1447): it nets inside the side it belongs to.
  it("attributes a secured debt to the rung of the asset it secures", () => {
    const pool = assemble(
      [
        makeAsset("rental", 300_000, { liquidityTier: "housing" }),
        makeAsset("etf", 100_000, { liquidityTier: "market" }),
      ],
      [makeLiability("mortgage", 120_000, "rental")],
    );

    expect(pool.scopedDebtByTierMinor).toEqual({ housing: 120_000 });
    expect(pool.scopedDebtMinor).toBe(120_000);
  });

  it("lands an unassociated debt on the cash rung", () => {
    const pool = assemble(
      [makeAsset("etf", 100_000, { liquidityTier: "market" })],
      [makeLiability("personal-loan", 20_000)],
    );

    expect(pool.scopedDebtByTierMinor).toEqual({ cash: 20_000 });
  });

  it("lands a debt pointing at an asset that is no longer present on the cash rung", () => {
    const pool = assemble(
      [makeAsset("etf", 100_000, { liquidityTier: "market" })],
      [makeLiability("ghost-loan", 20_000, "sold-flat")],
    );

    expect(pool.scopedDebtByTierMinor).toEqual({ cash: 20_000 });
  });

  it("drops the rung attribution of a debt secured against an excluded asset", () => {
    const pool = assemble(
      [
        makeAsset("home", 400_000, {
          isPrimaryResidence: true,
          liquidityTier: "housing",
        }),
        makeAsset("etf", 100_000, { liquidityTier: "market" }),
      ],
      [makeLiability("mortgage", 300_000, "home")],
    );

    expect(pool.scopedDebtByTierMinor).toEqual({});
    expect(pool.scopedDebtMinor).toBe(0);
  });

  it("keeps the per-rung debt in sync with the scoped total", () => {
    const pool = assemble(
      [
        makeAsset("rental", 300_000, { liquidityTier: "housing" }),
        makeAsset("gold", 60_000, { liquidityTier: "illiquid" }),
      ],
      [
        makeLiability("mortgage", 120_000, "rental"),
        makeLiability("pawn", 10_000, "gold"),
        makeLiability("card", 5_000),
      ],
    );

    const perRung = Object.values(pool.scopedDebtByTierMinor).reduce(
      (sum, minor) => sum + (minor ?? 0),
      0,
    );
    expect(perRung).toBe(pool.scopedDebtMinor);
    expect(pool.scopedDebtByTierMinor).toEqual({
      housing: 120_000,
      illiquid: 10_000,
      cash: 5_000,
    });
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

// ── rent-derived rates, filtered by eligibility and ownership (#1448) ─────────

describe("assembleFireEligiblePool + rent-derived rates", () => {
  const derived = (assetId: string, rate: number): RentDerivedReturn => ({
    annualExpensesMinor: 300_000,
    annualGrossRentMinor: 1_200_000,
    annualNetRentMinor: 900_000,
    assetId,
    assetName: assetId,
    isNetNegative: false,
    projectedSchedules: [],
    rate,
    scheduleIds: ["s1"],
    valueMinor: 20_000_000,
  });
  const notice = (assetId: string): RentReturnNotice => ({
    assetId,
    assetName: assetId,
    grossRate: 0.063,
    reason: "missing_expenses",
  });

  it("carries the derived rate with the SCOPED value as its weight", () => {
    const aliceScope: Workspace = {
      ...workspace,
      groups: [{ id: "alice-only", name: "Alice", memberIds: ["alice"] }],
    };
    const pool = assembleFireEligiblePool({
      assets: [makeAsset("piso", 20_000_000, { liquidityTier: "illiquid" })],
      config: {},
      liabilities: [],
      rentRealReturns: {
        byAssetId: new Map([["piso", derived("piso", 0.045)]]),
        notices: [],
      },
      scopeId: "alice-only",
      workspace: aliceScope,
    });

    // The rate is share-invariant (declared at 100 %); the WEIGHT is Alice's half.
    expect(pool.assetRateOverrides).toEqual([
      { amountMinor: 10_000_000, assetId: "piso", rate: 0.045, tier: "illiquid" },
    ]);
  });

  it("drops the rate of an asset FIRE excludes — its capital is out too", () => {
    const pool = assembleFireEligiblePool({
      assets: [
        makeAsset("casa", 20_000_000, { isPrimaryResidence: true }),
        makeAsset("otro", 10_000_000),
      ],
      config: { excludedAssetIds: ["otro"] },
      liabilities: [],
      rentRealReturns: {
        byAssetId: new Map([
          ["casa", derived("casa", 0.05)],
          ["otro", derived("otro", 0.06)],
        ]),
        notices: [notice("casa")],
      },
      scopeId: "household",
      workspace,
    });

    expect(pool.assetRateOverrides).toEqual([]);
    expect(pool.rentReturnNotices).toEqual([]);
  });

  it("keeps a notice for an eligible asset the scope owns", () => {
    const pool = assembleFireEligiblePool({
      assets: [makeAsset("piso", 20_000_000)],
      config: {},
      liabilities: [],
      rentRealReturns: { byAssetId: new Map(), notices: [notice("piso")] },
      scopeId: "household",
      workspace,
    });

    expect(pool.rentReturnNotices).toEqual([notice("piso")]);
  });

  it("stays silent about an asset the scope owns nothing of", () => {
    const aliceScope: Workspace = {
      ...workspace,
      groups: [{ id: "alice-only", name: "Alice", memberIds: ["alice"] }],
    };
    const pool = assembleFireEligiblePool({
      assets: [
        makeAsset("piso-de-bob", 20_000_000, {
          ownership: [{ memberId: "bob", shareBps: 10_000 }],
        }),
      ],
      config: {},
      liabilities: [],
      rentRealReturns: {
        byAssetId: new Map([["piso-de-bob", derived("piso-de-bob", 0.045)]]),
        notices: [notice("piso-de-bob")],
      },
      scopeId: "alice-only",
      workspace: aliceScope,
    });

    expect(pool.assetRateOverrides).toEqual([]);
    expect(pool.rentReturnNotices).toEqual([]);
  });

  it("no rent input at all → nothing overridden, nothing warned", () => {
    const pool = assembleFireEligiblePool({
      assets: [makeAsset("piso", 20_000_000)],
      config: {},
      liabilities: [],
      scopeId: "household",
      workspace,
    });

    expect(pool.assetRateOverrides).toEqual([]);
    expect(pool.rentReturnNotices).toEqual([]);
  });
});

describe("assembleFireEligiblePool \u2014 la disponibilidad declarada (#1528)", () => {
  it("recoge la fecha del escal\u00f3n a plazo, escalada a lo que el \u00e1mbito posee", () => {
    const pool = assemble([
      makeAsset("pp", 1_000_000, {
        availableFrom: "2035-06-01",
        liquidityTier: "term-locked",
        ownership: [{ memberId: "alice", shareBps: 5000 }],
      }),
    ]);

    // El hogar posee la mitad del plan: la declaraci\u00f3n vale por esa mitad, igual que
    // el capital que la lleva detr\u00e1s.
    expect(pool.declaredAvailability).toEqual([
      { amountMinor: 500_000, availableFrom: "2035-06-01" },
    ]);
    expect(pool.undeclaredTermLockedMinor).toBe(0);
  });

  it("un holding a plazo SIN fecha es un hueco con nombre, no un cero", () => {
    const pool = assemble([
      makeAsset("pp", 1_000_000, { liquidityTier: "term-locked" }),
      makeAsset("etf", 400_000, { liquidityTier: "market" }),
    ]);

    expect(pool.declaredAvailability).toEqual([]);
    expect(pool.undeclaredTermLockedMinor).toBe(1_000_000);
  });

  it("una fecha en un escal\u00f3n que no la reclama queda inerte", () => {
    const pool = assemble([
      makeAsset("cuenta", 400_000, {
        availableFrom: "2035-06-01",
        liquidityTier: "cash",
      }),
    ]);

    expect(pool.declaredAvailability).toEqual([]);
    expect(pool.undeclaredTermLockedMinor).toBe(0);
  });

  it("un holding excluido de FIRE no aporta declaraci\u00f3n ni hueco", () => {
    const pool = assemble(
      [
        makeAsset("pp", 1_000_000, {
          availableFrom: "2035-06-01",
          liquidityTier: "term-locked",
        }),
      ],
      [],
      ["pp"],
    );

    expect(pool.declaredAvailability).toEqual([]);
    expect(pool.undeclaredTermLockedMinor).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #1676: el plan de pensiones que es una escalera. El pool es donde los lotes se
// reparten por propiedad, que es lo único que la resolución de lotes no puede saber.
// ---------------------------------------------------------------------------

describe("assembleFireEligiblePool \u2014 los lotes de aportaci\u00f3n (#1676)", () => {
  const TODAY = "2026-08-31";

  it("escala cada lote por lo que el \u00e1mbito posee, como el valor del que cuelgan", () => {
    const pool = assemble(
      [
        makeAsset("pp", 1_000_000, {
          contributionLots: [
            { amountMinor: 400_000, availableFrom: "2024-03-01" },
            { amountMinor: 600_000, availableFrom: "2031-05-01" },
          ],
          liquidityTier: "term-locked",
          ownership: [{ memberId: "alice", shareBps: 5000 }],
        }),
      ],
      [],
      [],
      TODAY,
    );

    // El hogar posee la mitad: 2.000 \u20ac ya rescatables y 3.000 \u20ac bloqueados hasta 2031.
    expect(pool.declaredAvailability).toEqual([
      { amountMinor: 300_000, availableFrom: "2031-05-01" },
    ]);
    expect(pool.undeclaredTermLockedMinor).toBe(0);
  });

  it("lo que los lotes no explican sigue siendo un hueco con nombre", () => {
    const pool = assemble(
      [
        makeAsset("pp", 1_055_658, {
          contributionLots: [
            { amountMinor: 400_000, availableFrom: "2024-03-01" },
            { amountMinor: 200_000, availableFrom: "2031-05-01" },
          ],
          liquidityTier: "term-locked",
          ownership: [{ memberId: "alice", shareBps: 10_000 }],
        }),
      ],
      [],
      [],
      TODAY,
    );

    expect(pool.declaredAvailability).toEqual([
      { amountMinor: 200_000, availableFrom: "2031-05-01" },
    ]);
    expect(pool.undeclaredTermLockedMinor).toBe(455_658);
  });

  it("sin lotes el pool se comporta exactamente como en la fase 1", () => {
    const pool = assemble(
      [
        makeAsset("pp", 1_000_000, {
          availableFrom: "2035-06-01",
          liquidityTier: "term-locked",
          ownership: [{ memberId: "alice", shareBps: 10_000 }],
        }),
      ],
      [],
      [],
      TODAY,
    );

    expect(pool.declaredAvailability).toEqual([
      { amountMinor: 1_000_000, availableFrom: "2035-06-01" },
    ]);
  });

  it("un holding fuera del escal\u00f3n a plazo deja sus lotes inertes", () => {
    const pool = assemble(
      [
        makeAsset("fondo", 1_000_000, {
          contributionLots: [{ amountMinor: 1_000_000, availableFrom: "2031-05-01" }],
          liquidityTier: "market",
          ownership: [{ memberId: "alice", shareBps: 10_000 }],
        }),
      ],
      [],
      [],
      TODAY,
    );

    expect(pool.declaredAvailability).toEqual([]);
    expect(pool.undeclaredTermLockedMinor).toBe(0);
  });
});
