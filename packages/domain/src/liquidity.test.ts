import { describe, expect, test } from "vitest";

import {
  buildLiquidityBreakdown,
  createLiability,
  createManualAsset,
  createWorkspace,
} from "./index";

describe("liquidity breakdown", () => {
  test("returns empty rungs and groups scoped net, gross, and debt values by rung", () => {
    const workspace = createWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });

    expect(
      buildLiquidityBreakdown({
        assets: [],
        liabilities: [],
        scopeId: "household",
        workspace,
      }).map((tier) => [tier.tier, tier.netValue.amountMinor]),
    ).toEqual([
      ["cash", 0],
      ["market", 0],
      ["term-locked", 0],
      ["illiquid", 0],
      ["housing", 0],
    ]);

    const cash = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 10_000,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });
    const oneTier = buildLiquidityBreakdown({
      assets: [cash],
      liabilities: [],
      scopeId: "household",
      workspace,
    });

    expect(oneTier.find((tier) => tier.tier === "cash")?.netValue.amountMinor).toBe(
      10_000,
    );
    expect(
      oneTier
        .filter((tier) => tier.tier !== "cash")
        .every((tier) => tier.netValue.amountMinor === 0),
    ).toBe(true);

    const broker = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 20_000,
      id: "asset_broker",
      liquidityTier: "market",
      name: "Broker",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "manual",
    });
    // Real estate sits on the housing rung (ADR 0022) regardless of declared tier.
    const home = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 300_000,
      id: "asset_home",
      isPrimaryResidence: true,
      liquidityTier: "illiquid",
      name: "Vivienda",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "real_estate",
    });
    const mortgage = createLiability(workspace, {
      associatedAssetId: "asset_home",
      balanceMinor: 180_000,
      currency: "EUR",
      id: "debt_mortgage",
      name: "Hipoteca",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "mortgage",
    });

    const pyramid = buildLiquidityBreakdown({
      assets: [cash, broker, home],
      liabilities: [mortgage],
      scopeId: "household",
      workspace,
    });

    expect(pyramid.find((tier) => tier.tier === "cash")).toMatchObject({
      debts: { amountMinor: 0 },
      grossAssets: { amountMinor: 10_000 },
      netValue: { amountMinor: 10_000 },
    });
    expect(pyramid.find((tier) => tier.tier === "market")).toMatchObject({
      grossAssets: { amountMinor: 20_000 },
      netValue: { amountMinor: 20_000 },
    });
    // The house and its mortgage net against each other on the housing rung.
    expect(pyramid.find((tier) => tier.tier === "housing")).toMatchObject({
      debts: { amountMinor: 180_000 },
      grossAssets: { amountMinor: 300_000 },
      netValue: { amountMinor: 120_000 },
    });
    expect(pyramid.find((tier) => tier.tier === "housing")?.assets).toEqual([
      { id: "asset_home", name: "Vivienda", valueMinor: 300_000 },
    ]);
    expect(pyramid.find((tier) => tier.tier === "housing")?.liabilities).toEqual([
      { id: "debt_mortgage", name: "Hipoteca", valueMinor: 180_000 },
    ]);
    // The illiquid rung now holds neither the house nor the mortgage.
    expect(pyramid.find((tier) => tier.tier === "illiquid")).toMatchObject({
      debts: { amountMinor: 0 },
      grossAssets: { amountMinor: 0 },
      netValue: { amountMinor: 0 },
    });

    // shareOfGrossBps is each rung's share of total gross assets
    // (10_000 + 20_000 + 300_000 = 330_000).
    expect(pyramid.find((tier) => tier.tier === "cash")?.shareOfGrossBps).toBe(303);
    expect(pyramid.find((tier) => tier.tier === "market")?.shareOfGrossBps).toBe(606);
    expect(pyramid.find((tier) => tier.tier === "housing")?.shareOfGrossBps).toBe(9091);
    expect(pyramid.find((tier) => tier.tier === "illiquid")?.shareOfGrossBps).toBe(0);
    expect(pyramid.find((tier) => tier.tier === "term-locked")?.shareOfGrossBps).toBe(0);
  });
});
