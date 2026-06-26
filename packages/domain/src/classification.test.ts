import type { Instrument, LiquidityTier } from "./classification";
import { describe, expect, test } from "vitest";

import { isHousingAsset, isLiquid, tierOfAsset } from "./classification";
import {
  buildLiquidityBreakdown,
  calculateFireForScope,
  calculateNetWorth,
  createLiability,
  createManualAsset,
  createWorkspace,
} from "./index";

const workspace = createWorkspace({
  members: [{ id: "member_jose", name: "Jose" }],
  mode: "individual",
});
const fullOwnership = [{ memberId: "member_jose", shareBps: 10_000 }];

function asset(
  id: string,
  liquidityTier: LiquidityTier,
  overrides: {
    type?: "cash" | "manual" | "real_estate";
    isPrimaryResidence?: boolean;
    instrument?: Instrument;
  } = {},
) {
  return createManualAsset(workspace, {
    currency: "EUR",
    currentValueMinor: 1_000,
    id,
    isPrimaryResidence: overrides.isPrimaryResidence ?? false,
    liquidityTier,
    name: id,
    ownership: fullOwnership,
    type: overrides.type ?? "manual",
    ...(overrides.instrument ? { instrument: overrides.instrument } : {}),
  });
}

describe("asset classification", () => {
  test("tierOfAsset reflects the asset's declared rung", () => {
    expect(tierOfAsset(asset("a", "market"))).toBe("market");
    expect(tierOfAsset(asset("b", "term-locked"))).toBe("term-locked");
  });

  test("real estate and the primary residence sit on the housing rung regardless of declared rung", () => {
    expect(tierOfAsset(asset("home", "cash", { type: "real_estate" }))).toBe("housing");
    expect(tierOfAsset(asset("flat", "market", { isPrimaryResidence: true }))).toBe(
      "housing",
    );
  });

  test("isHousingAsset covers real estate and the primary residence, by type — not by rung", () => {
    expect(isHousingAsset(asset("home", "illiquid", { type: "real_estate" }))).toBe(true);
    expect(isHousingAsset(asset("flat", "cash", { isPrimaryResidence: true }))).toBe(
      true,
    );
    // A non-housing illiquid holding (art) is not housing, even on the same rung.
    expect(isHousingAsset(asset("art", "illiquid"))).toBe(false);
    expect(isHousingAsset(asset("broker", "market"))).toBe(false);
  });

  test("a housing asset is never counted as liquid", () => {
    const home = asset("home", "cash", { type: "real_estate" });
    expect(isHousingAsset(home)).toBe(true);
    expect(isLiquid(tierOfAsset(home))).toBe(false);
  });

  test("a rental property sits on the housing rung yet stays FIRE-eligible (FIRE excludes only the primary residence)", () => {
    // A property instrument that is NOT the primary residence: it lands on the
    // housing rung (housing-ness is the instrument, not isPrimaryResidence), but
    // FIRE eligibility is keyed on isPrimaryResidence, so it still counts.
    const rental = asset("rental", "illiquid", {
      type: "real_estate",
      isPrimaryResidence: false,
    });
    expect(isHousingAsset(rental)).toBe(true);
    expect(tierOfAsset(rental)).toBe("housing");
    const fire = calculateFireForScope(
      {
        monthlySpendingMinor: 100_000,
        safeWithdrawalRate: 0.04,
        expectedRealReturn: 0.07,
      },
      [rental],
      [],
      workspace,
      "household",
    );
    expect(fire.excludedAssets).toEqual([]);
    expect(fire.eligibleAssets.amountMinor).toBeGreaterThan(0);
  });

  test("housing is sourced from the instrument, not the legacy type (#149)", () => {
    // An explicit instrument wins over the type-derived default: a property
    // instrument makes a non-real_estate asset housing…
    const declaredProperty = asset("storage", "illiquid", {
      type: "cash",
      instrument: "property",
    });
    expect(isHousingAsset(declaredProperty)).toBe(true);
    expect(tierOfAsset(declaredProperty)).toBe("housing"); // property → housing rung

    // …and a non-property instrument makes a real_estate-typed asset NOT housing.
    const reclassified = asset("reit", "market", {
      type: "real_estate",
      instrument: "fund",
    });
    expect(isHousingAsset(reclassified)).toBe(false);
  });
});

describe("summary and breakdown reconcile on debt classification", () => {
  test("liquid net worth and housing equity are unaffected by where non-liquid debts sit", () => {
    const cash = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 100_000,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Caja",
      ownership: fullOwnership,
      type: "cash",
    });
    const broker = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 50_000,
      id: "asset_broker",
      liquidityTier: "market",
      name: "Broker",
      ownership: fullOwnership,
      type: "manual",
    });
    const home = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 300_000,
      id: "asset_home",
      isPrimaryResidence: true,
      liquidityTier: "illiquid",
      name: "Vivienda",
      ownership: fullOwnership,
      type: "real_estate",
    });
    const pension = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 80_000,
      id: "asset_pension",
      liquidityTier: "term-locked",
      name: "Plan",
      ownership: fullOwnership,
      type: "manual",
    });
    const mortgage = createLiability(workspace, {
      associatedAssetId: "asset_home",
      balanceMinor: 180_000,
      currency: "EUR",
      id: "debt_mortgage",
      name: "Hipoteca",
      ownership: fullOwnership,
      type: "mortgage",
    });
    const cashDebt = createLiability(workspace, {
      balanceMinor: 10_000,
      currency: "EUR",
      id: "debt_card",
      name: "Tarjeta",
      ownership: fullOwnership,
      type: "debt",
    });
    const pensionDebt = createLiability(workspace, {
      associatedAssetId: "asset_pension",
      balanceMinor: 20_000,
      currency: "EUR",
      id: "debt_pension",
      name: "Anticipo plan",
      ownership: fullOwnership,
      type: "debt",
    });

    const assets = [cash, broker, home, pension];
    const liabilities = [mortgage, cashDebt, pensionDebt];

    const summary = calculateNetWorth({
      assets,
      liabilities,
      scopeId: "household",
      workspace,
    });
    const pyramid = buildLiquidityBreakdown({
      assets,
      liabilities,
      scopeId: "household",
      workspace,
    });

    const tierDebt = (tier: LiquidityTier) =>
      pyramid.find((breakdown) => breakdown.tier === tier)?.debts.amountMinor ?? 0;

    // Hand-computed expectations — the headline figures are UNCHANGED by the recut
    // (housing becomes its own rung, but isLiquid and the housing-equity derivation
    // are untouched, so liquid/total/housing figures cannot move).
    expect(summary.debts.amountMinor).toBe(210_000);
    expect(summary.housingEquity.amountMinor).toBe(120_000); // 300k - 180k mortgage
    expect(summary.liquidNetWorth.amountMinor).toBe(140_000); // (100k+50k) - 10k cash debt

    // The mortgage nets against its house on the housing rung; the pension-backed
    // debt sits term-locked; only the unassociated card erodes liquid net worth.
    // The illiquid rung no longer holds the house, so it carries no debt.
    expect(tierDebt("housing")).toBe(180_000);
    expect(tierDebt("illiquid")).toBe(0);
    expect(tierDebt("term-locked")).toBe(20_000);
    expect(tierDebt("cash") + tierDebt("market")).toBe(10_000);

    // Reconciliation: per-rung debts sum to the headline debts.
    expect(
      tierDebt("cash") +
        tierDebt("market") +
        tierDebt("term-locked") +
        tierDebt("illiquid") +
        tierDebt("housing"),
    ).toBe(summary.debts.amountMinor);
    // The house and its mortgage are the only holdings on the housing rung, so that
    // rung's net equals housing equity.
    expect(pyramid.find((b) => b.tier === "housing")?.netValue.amountMinor).toBe(
      summary.housingEquity.amountMinor,
    );
  });
});
