import { describe, expect, test } from "vitest";

import {
  calculateNetWorth,
  createLiability,
  createManualAsset,
  createWorkspace,
  presentNetWorth,
} from "./index";

describe("net worth calculations", () => {
  test("allocates liquid manual assets across household, member, and group scopes", () => {
    const workspace = createWorkspace({
      groups: [
        {
          id: "scope_adults",
          memberIds: ["member_ana", "member_jose"],
          name: "Adultos",
        },
      ],
      members: [
        { id: "member_ana", name: "Ana" },
        { id: "member_jose", name: "Jose" },
        { id: "member_luz", name: "Luz" },
      ],
      mode: "household",
    });
    const sharedCash = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 120_000,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Cuenta compartida",
      ownership: [
        { memberId: "member_ana", shareBps: 5_000 },
        { memberId: "member_jose", shareBps: 5_000 },
      ],
      type: "cash",
    });
    const joseBroker = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 80_000,
      id: "asset_broker",
      liquidityTier: "market",
      name: "Broker Jose",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "manual",
    });
    const illiquidNote = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 50_000,
      id: "asset_note",
      liquidityTier: "illiquid",
      name: "Activo bloqueado",
      ownership: [{ memberId: "member_ana", shareBps: 10_000 }],
      type: "manual",
    });

    expect(
      calculateNetWorth({
        assets: [sharedCash, joseBroker, illiquidNote],
        scopeId: "household",
        workspace,
      }).liquidNetWorth.amountMinor,
    ).toBe(200_000);
    expect(
      calculateNetWorth({
        assets: [sharedCash, joseBroker, illiquidNote],
        scopeId: "member_ana",
        workspace,
      }).liquidNetWorth.amountMinor,
    ).toBe(60_000);
    expect(
      calculateNetWorth({
        assets: [sharedCash, joseBroker, illiquidNote],
        scopeId: "member_jose",
        workspace,
      }).liquidNetWorth.amountMinor,
    ).toBe(140_000);
    expect(
      calculateNetWorth({
        assets: [sharedCash, joseBroker, illiquidNote],
        scopeId: "scope_adults",
        workspace,
      }).liquidNetWorth.amountMinor,
    ).toBe(200_000);
  });

  test("blocks invalid asset currency, owner references, and non-integer money", () => {
    const workspace = createWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    const validOwnership = [{ memberId: "member_jose", shareBps: 10_000 }];

    expect(() =>
      createManualAsset(workspace, {
        currency: "",
        currentValueMinor: 100,
        id: "asset_no_currency",
        liquidityTier: "cash",
        name: "Sin divisa",
        ownership: validOwnership,
        type: "cash",
      }),
    ).toThrow("Currency is required");
    expect(() =>
      createManualAsset(workspace, {
        currency: "EUR",
        currentValueMinor: 100,
        id: "asset_bad_owner",
        liquidityTier: "cash",
        name: "Owner malo",
        ownership: [{ memberId: "member_missing", shareBps: 10_000 }],
        type: "cash",
      }),
    ).toThrow("unknown member");
    expect(() =>
      createManualAsset(workspace, {
        currency: "EUR",
        currentValueMinor: 10.5,
        id: "asset_float",
        liquidityTier: "cash",
        name: "Float",
        ownership: validOwnership,
        type: "cash",
      }),
    ).toThrow("integer minor units");
  });

  test("sums money as integer minor units without floating-point drift", () => {
    const workspace = createWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    const assets = [
      createManualAsset(workspace, {
        currency: "EUR",
        currentValueMinor: 10,
        id: "asset_a",
        liquidityTier: "cash",
        name: "A",
        ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
        type: "cash",
      }),
      createManualAsset(workspace, {
        currency: "EUR",
        currentValueMinor: 20,
        id: "asset_b",
        liquidityTier: "cash",
        name: "B",
        ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
        type: "cash",
      }),
    ];

    expect(
      calculateNetWorth({ assets, scopeId: "household", workspace }).liquidNetWorth
        .amountMinor,
    ).toBe(30);
  });

  test("keeps ownership references valid for soft-disabled members", () => {
    const workspace = createWorkspace({
      members: [
        { id: "member_jose", name: "Jose" },
        { disabledAt: "2026-06-08T20:00:00.000Z", id: "member_old", name: "Old" },
      ],
      mode: "household",
    });
    const archivedAsset = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 10_000,
      id: "asset_archived",
      liquidityTier: "cash",
      name: "Archivado",
      ownership: [{ memberId: "member_old", shareBps: 10_000 }],
      type: "cash",
    });

    expect(
      calculateNetWorth({
        assets: [archivedAsset],
        scopeId: "household",
        workspace,
      }).liquidNetWorth.amountMinor,
    ).toBe(0);
  });

  test("separates real estate, mortgage debt, and presentation modes", () => {
    const workspace = createWorkspace({
      members: [
        { id: "member_ana", name: "Ana" },
        { id: "member_jose", name: "Jose" },
      ],
      mode: "household",
    });
    const home = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 30_000_000,
      id: "asset_home",
      isPrimaryResidence: true,
      liquidityTier: "illiquid",
      name: "Vivienda",
      ownership: [
        { memberId: "member_ana", shareBps: 5_000 },
        { memberId: "member_jose", shareBps: 5_000 },
      ],
      type: "real_estate",
    });
    const cash = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 4_000_000,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });
    const mortgage = createLiability(workspace, {
      associatedAssetId: "asset_home",
      balanceMinor: 18_000_000,
      currency: "EUR",
      id: "debt_mortgage",
      name: "Hipoteca",
      ownership: [
        { memberId: "member_ana", shareBps: 5_000 },
        { memberId: "member_jose", shareBps: 5_000 },
      ],
      type: "mortgage",
    });

    const household = calculateNetWorth({
      assets: [home, cash],
      liabilities: [mortgage],
      scopeId: "household",
      workspace,
    });
    const ana = calculateNetWorth({
      assets: [home, cash],
      liabilities: [mortgage],
      scopeId: "member_ana",
      workspace,
    });

    expect(household.grossAssets.amountMinor).toBe(34_000_000);
    expect(household.debts.amountMinor).toBe(18_000_000);
    expect(household.totalNetWorth.amountMinor).toBe(16_000_000);
    expect(household.housingEquity.amountMinor).toBe(12_000_000);
    expect(household.liquidNetWorth.amountMinor).toBe(4_000_000);
    expect(ana.totalNetWorth.amountMinor).toBe(6_000_000);
    const total = presentNetWorth(household, "total");
    expect(total.framing).toBe("total");
    expect(total.headlineLabel).toBe("Neto total");
    expect(total.headline.amountMinor).toBe(16_000_000);

    const liquid = presentNetWorth(household, "liquid");
    expect(liquid.framing).toBe("liquid");
    expect(liquid.headlineLabel).toBe("Neto liquido");
    expect(liquid.headline.amountMinor).toBe(4_000_000);

    // The breakdown is a fixed set, identical regardless of the framing.
    expect(liquid.breakdown).toEqual(total.breakdown);
    expect(total.breakdown.map((item) => item.id)).toEqual([
      "liquid-net-worth",
      "housing-equity",
      "gross-assets",
      "debts",
    ]);
    const byId = Object.fromEntries(
      total.breakdown.map((item) => [item.id, item.value.amountMinor]),
    );
    expect(byId["liquid-net-worth"]).toBe(4_000_000);
    expect(byId["housing-equity"]).toBe(12_000_000);
    expect(byId["gross-assets"]).toBe(34_000_000);
    expect(byId["debts"]).toBe(18_000_000);
  });
});
