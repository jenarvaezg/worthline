import { describe, expect, test } from "vitest";

import {
  type AssetProjectionContext,
  createWorkspace,
  projectAssets,
  projectPositions,
  type RawAssetRow,
  type RawInvestmentRow,
} from "./index";

const workspace = createWorkspace({
  members: [
    { id: "member_jose", name: "Jose" },
    { id: "member_ana", name: "Ana" },
  ],
  mode: "household",
});

const fullJose = [{ memberId: "member_jose", shareBps: 10_000 }];
const fullAna = [{ memberId: "member_ana", shareBps: 10_000 }];

function emptyContext(): AssetProjectionContext {
  return {
    cachedPriceByAsset: new Map(),
    manualPriceByAsset: new Map(),
    operationsByAsset: new Map(),
    ownershipByAsset: new Map(),
  };
}

describe("projectAssets", () => {
  test("hand-valued assets carry their stored value", () => {
    const rows: RawAssetRow[] = [
      {
        currency: "EUR",
        currentValueMinor: 150_00,
        id: "cash1",
        isPrimaryResidence: false,
        liquidityTier: "cash",
        name: "Cuenta",
        type: "cash",
      },
    ];
    const ctx = emptyContext();
    ctx.ownershipByAsset.set("cash1", fullJose);

    const assets = projectAssets(workspace, rows, ctx);

    expect(assets).toHaveLength(1);
    expect(assets[0]?.currentValue.amountMinor).toBe(150_00);
    expect(assets[0]?.ownership).toEqual(fullJose);
  });

  test("investment value is derived from operations × price, not the stored row value", () => {
    const rows: RawAssetRow[] = [
      {
        currency: "EUR",
        // Stale stored value the projection must ignore for investments.
        currentValueMinor: 42_00,
        id: "inv1",
        isPrimaryResidence: false,
        liquidityTier: "market",
        name: "Fondo",
        type: "investment",
      },
    ];
    const ctx = emptyContext();
    ctx.ownershipByAsset.set("inv1", fullJose);
    ctx.operationsByAsset.set("inv1", [
      {
        assetId: "inv1",
        currency: "EUR",
        executedAt: "2026-01-01T00:00:00.000Z",
        feesMinor: 0,
        id: "op1",
        kind: "buy",
        pricePerUnit: "10",
        units: "10",
      },
    ]);
    ctx.cachedPriceByAsset.set("inv1", "20");

    const assets = projectAssets(workspace, rows, ctx);

    // 10 units × 20 EUR = 200 EUR market value, not the 42 EUR stored row.
    expect(assets[0]?.currentValue.amountMinor).toBe(200_00);
  });
});

describe("projectPositions", () => {
  const rows: RawInvestmentRow[] = [
    { currency: "EUR", id: "inv_jose", name: "Fondo Jose" },
    { currency: "EUR", id: "inv_ana", name: "Fondo Ana" },
  ];

  function contextWithPositions(): AssetProjectionContext {
    const ctx = emptyContext();
    ctx.ownershipByAsset.set("inv_jose", fullJose);
    ctx.ownershipByAsset.set("inv_ana", fullAna);
    ctx.operationsByAsset.set("inv_jose", [
      {
        assetId: "inv_jose",
        currency: "EUR",
        executedAt: "2026-01-01T00:00:00.000Z",
        feesMinor: 0,
        id: "op_j",
        kind: "buy",
        pricePerUnit: "5",
        units: "4",
      },
    ]);
    ctx.cachedPriceByAsset.set("inv_jose", "7");
    return ctx;
  }

  test("returns the full position view with the asset name", () => {
    const positions = projectPositions(workspace, rows, contextWithPositions());

    const jose = positions.find((p) => p.assetId === "inv_jose");
    expect(jose?.name).toBe("Fondo Jose");
    expect(jose?.marketValue?.amountMinor).toBe(28_00); // 4 × 7
  });

  test("scopes positions to the requested members", () => {
    const scoped = projectPositions(
      workspace,
      rows,
      contextWithPositions(),
      "member_jose",
    );

    expect(scoped.map((p) => p.assetId)).toEqual(["inv_jose"]);
  });
});
