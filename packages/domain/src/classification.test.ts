import type { LiquidityTier } from "@worthline/contracts";
import { describe, expect, test } from "vitest";

import {
  isHousing,
  isHousingAsset,
  isLiquid,
  tierOfAsset,
  tierOfLiability,
} from "./classification";
import {
  buildLiquidityPyramid,
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
  overrides: { type?: "cash" | "manual" | "real_estate"; isPrimaryResidence?: boolean } = {},
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
  });
}

function liability(
  id: string,
  type: "mortgage" | "debt",
  associatedAssetId?: string,
) {
  return createLiability(workspace, {
    balanceMinor: 1_000,
    currency: "EUR",
    id,
    name: id,
    ownership: fullOwnership,
    type,
    ...(associatedAssetId ? { associatedAssetId } : {}),
  });
}

describe("tier posture predicates", () => {
  test("isLiquid is true only for cash and market", () => {
    expect(isLiquid("cash")).toBe(true);
    expect(isLiquid("market")).toBe(true);
    expect(isLiquid("retirement")).toBe(false);
    expect(isLiquid("illiquid")).toBe(false);
    expect(isLiquid("housing")).toBe(false);
  });

  test("isHousing is true only for the housing tier", () => {
    expect(isHousing("housing")).toBe(true);
    expect(isHousing("cash")).toBe(false);
  });
});

describe("asset classification", () => {
  test("tierOfAsset reflects the asset's declared liquidity tier", () => {
    expect(tierOfAsset(asset("a", "market"))).toBe("market");
    expect(tierOfAsset(asset("b", "retirement"))).toBe("retirement");
  });

  test("isHousingAsset covers real estate, primary residence, and the housing tier", () => {
    expect(isHousingAsset(asset("home", "illiquid", { type: "real_estate" }))).toBe(true);
    expect(isHousingAsset(asset("flat", "cash", { isPrimaryResidence: true }))).toBe(true);
    expect(isHousingAsset(asset("plot", "housing"))).toBe(true);
    expect(isHousingAsset(asset("broker", "market"))).toBe(false);
  });

  test("real_estate or primary residence assets normalize to housing tier regardless of declared tier", () => {
    expect(tierOfAsset(asset("home", "cash", { type: "real_estate" }))).toBe("housing");
    expect(tierOfAsset(asset("flat", "market", { isPrimaryResidence: true }))).toBe(
      "housing",
    );
  });

  test("a housing asset is never counted as liquid", () => {
    const home = asset("home", "cash", { type: "real_estate" });
    expect(isHousingAsset(home)).toBe(true);
    expect(isLiquid(tierOfAsset(home))).toBe(false);
  });
});

describe("liability classification", () => {
  const assetTierById = new Map<string, LiquidityTier>([
    ["asset_home", "housing"],
    ["asset_broker", "market"],
    ["asset_pension", "retirement"],
  ]);

  test("an associated liability inherits the owning asset's tier", () => {
    expect(tierOfLiability(liability("l1", "debt", "asset_broker"), assetTierById)).toBe(
      "market",
    );
    expect(
      tierOfLiability(liability("l2", "debt", "asset_pension"), assetTierById),
    ).toBe("retirement");
  });

  test("an unknown associated asset falls back to housing", () => {
    expect(tierOfLiability(liability("l3", "debt", "asset_ghost"), assetTierById)).toBe(
      "housing",
    );
  });

  test("an unassociated liability falls back by type: mortgage -> housing, debt -> cash", () => {
    expect(tierOfLiability(liability("l4", "mortgage"), assetTierById)).toBe("housing");
    expect(tierOfLiability(liability("l5", "debt"), assetTierById)).toBe("cash");
  });
});

describe("summary and pyramid reconcile on debt classification", () => {
  test("a debt tied to a non-liquid asset is classified identically by both views", () => {
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
      liquidityTier: "housing",
      name: "Vivienda",
      ownership: fullOwnership,
      type: "real_estate",
    });
    const pension = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 80_000,
      id: "asset_pension",
      liquidityTier: "retirement",
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
    const pyramid = buildLiquidityPyramid({
      assets,
      liabilities,
      scopeId: "household",
      workspace,
    });

    const tierDebt = (tier: LiquidityTier) =>
      pyramid.find((breakdown) => breakdown.tier === tier)?.debts.amountMinor ?? 0;

    // Hand-computed expectations.
    expect(summary.debts.amountMinor).toBe(210_000);
    expect(summary.housingEquity.amountMinor).toBe(120_000); // 300k - 180k mortgage
    expect(summary.liquidNetWorth.amountMinor).toBe(140_000); // (100k+50k) - 10k cash debt

    // The pension-backed debt must NOT erode liquid net worth (the bug being fixed).
    const housingDebt = tierDebt("housing");
    const liquidDebt = tierDebt("cash") + tierDebt("market");

    expect(housingDebt).toBe(180_000);
    expect(liquidDebt).toBe(10_000);
    expect(tierDebt("retirement")).toBe(20_000);

    // Reconciliation: pyramid per-tier debts match the summary's housing/liquid split.
    expect(housingDebt).toBe(300_000 - summary.housingEquity.amountMinor);
    expect(liquidDebt).toBe(150_000 - summary.liquidNetWorth.amountMinor);
    expect(housingDebt + liquidDebt + tierDebt("retirement")).toBe(
      summary.debts.amountMinor,
    );
  });
});
