/**
 * Snapshot holding rows (ADR 0008, issue #72).
 *
 * Every capture records the valued portfolio behind its figures: one row per
 * holding, with label and liquidity tier denormalized at capture time and the
 * scope-weighted value in integer minor units. Investments additionally carry
 * units and unit price as decimal strings. At capture time the rows must sum
 * exactly to the headline gross assets and debts or the capture fails loudly.
 */
import { describe, expect, test } from "vitest";

import type {
  InvestmentCaptureDetail,
  Liability,
  ManualAsset,
  PositionDelta,
  SnapshotHoldingRow,
  SnapshotPositionInput,
  SnapshotPositionRow,
  Workspace,
} from "./index";
import {
  assertSnapshotHoldingsReconcile,
  buildSnapshotHoldingRows,
  captureValuedNetWorthSnapshot,
  createLiability,
  createManualAsset,
  createWorkspace,
  deriveHoldingDeltas,
  derivePositionDeltas,
} from "./index";

function makeWorkspace(): Workspace {
  return createWorkspace({
    baseCurrency: "EUR",
    members: [
      { id: "member_jose", name: "Jose" },
      { id: "member_ana", name: "Ana" },
    ],
    mode: "household",
  });
}

function makeAssets(workspace: Workspace): ManualAsset[] {
  return [
    createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 50_000_00,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Cuenta corriente",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    }),
    createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 300_000_00,
      id: "asset_home",
      isPrimaryResidence: true,
      // tier is denormalized via tierOfAsset: primary residence → illiquid,
      // regardless of the stored liquidityTier.
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: [
        { memberId: "member_jose", shareBps: 5_000 },
        { memberId: "member_ana", shareBps: 5_000 },
      ],
      type: "real_estate",
    }),
    createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 13_000_00,
      id: "asset_fund",
      liquidityTier: "market",
      name: "Fondo indexado",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "investment",
    }),
    createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 7_000_00,
      id: "asset_ana_only",
      liquidityTier: "cash",
      name: "Cuenta de Ana",
      ownership: [{ memberId: "member_ana", shareBps: 10_000 }],
      type: "cash",
    }),
  ];
}

function makeLiabilities(workspace: Workspace): Liability[] {
  return [
    createLiability(workspace, {
      associatedAssetId: "asset_home",
      balanceMinor: 120_000_00,
      currency: "EUR",
      id: "liability_mortgage",
      name: "Hipoteca",
      ownership: [
        { memberId: "member_jose", shareBps: 5_000 },
        { memberId: "member_ana", shareBps: 5_000 },
      ],
      type: "mortgage",
    }),
    createLiability(workspace, {
      balanceMinor: 3_000_00,
      currency: "EUR",
      id: "liability_loan",
      name: "Prestamo personal",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "debt",
    }),
  ];
}

describe("buildSnapshotHoldingRows — row production and denormalization", () => {
  test("produces one row per holding with label and tier frozen at capture time", () => {
    const workspace = makeWorkspace();
    const rows = buildSnapshotHoldingRows({
      assets: makeAssets(workspace),
      liabilities: makeLiabilities(workspace),
      scopeId: "household",
      workspace,
    });

    const cashRow = rows.find((row) => row.holdingId === "asset_cash");
    expect(cashRow).toMatchObject({
      kind: "asset",
      label: "Cuenta corriente",
      liquidityTier: "cash",
      valueMinor: 50_000_00,
    });

    // Primary residence resolves to the housing rung (tierOfAsset, ADR 0022), not
    // the stored liquidityTier.
    const homeRow = rows.find((row) => row.holdingId === "asset_home");
    expect(homeRow).toMatchObject({
      kind: "asset",
      label: "Piso",
      liquidityTier: "housing",
      valueMinor: 300_000_00,
    });
  });

  test("liability secured by an asset freezes that asset's tier; unsecured tier is null", () => {
    const workspace = makeWorkspace();
    const rows = buildSnapshotHoldingRows({
      assets: makeAssets(workspace),
      liabilities: makeLiabilities(workspace),
      scopeId: "household",
      workspace,
    });

    // The mortgage inherits its house's rung — now the housing rung (ADR 0022).
    const mortgageRow = rows.find((row) => row.holdingId === "liability_mortgage");
    expect(mortgageRow).toMatchObject({
      kind: "liability",
      label: "Hipoteca",
      liquidityTier: "housing",
      valueMinor: 120_000_00,
    });

    const loanRow = rows.find((row) => row.holdingId === "liability_loan");
    expect(loanRow).toMatchObject({
      kind: "liability",
      label: "Prestamo personal",
      liquidityTier: null,
      valueMinor: 3_000_00,
    });
  });

  test("freezes securesHousing=true for a debt on a housing asset, false otherwise (#180)", () => {
    const workspace = makeWorkspace();
    const rows = buildSnapshotHoldingRows({
      assets: makeAssets(workspace),
      liabilities: makeLiabilities(workspace),
      scopeId: "household",
      workspace,
    });

    // The mortgage secures the primary residence (a housing asset) → frozen true.
    expect(
      rows.find((row) => row.holdingId === "liability_mortgage")?.securesHousing,
    ).toBe(true);

    // An unassociated personal loan secures no housing → frozen false.
    expect(rows.find((row) => row.holdingId === "liability_loan")?.securesHousing).toBe(
      false,
    );

    // Assets never secure housing — the signal is liability-only by meaning.
    expect(rows.find((row) => row.holdingId === "asset_home")?.securesHousing).toBe(
      false,
    );
    expect(rows.find((row) => row.holdingId === "asset_cash")?.securesHousing).toBe(
      false,
    );
  });

  test("a debt associated to a NON-housing asset freezes securesHousing=false (#180)", () => {
    const workspace = makeWorkspace();
    const assets = makeAssets(workspace);
    // A debt secured against the (liquid, non-housing) cash account.
    const liabilities = [
      createLiability(workspace, {
        associatedAssetId: "asset_cash",
        balanceMinor: 1_000_00,
        currency: "EUR",
        id: "liability_secured_cash",
        name: "Pignoración",
        ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
        type: "debt",
      }),
    ];
    const rows = buildSnapshotHoldingRows({
      assets,
      liabilities,
      scopeId: "household",
      workspace,
    });

    expect(
      rows.find((row) => row.holdingId === "liability_secured_cash")?.securesHousing,
    ).toBe(false);
  });

  test("scope-weights values by ownership and omits holdings outside the scope", () => {
    const workspace = makeWorkspace();
    const rows = buildSnapshotHoldingRows({
      assets: makeAssets(workspace),
      liabilities: makeLiabilities(workspace),
      scopeId: "member_jose",
      workspace,
    });

    // Jose's own account: full value.
    expect(rows.find((row) => row.holdingId === "asset_cash")?.valueMinor).toBe(
      50_000_00,
    );
    // Shared home: half of it.
    expect(rows.find((row) => row.holdingId === "asset_home")?.valueMinor).toBe(
      150_000_00,
    );
    // Shared mortgage: half of it.
    expect(rows.find((row) => row.holdingId === "liability_mortgage")?.valueMinor).toBe(
      60_000_00,
    );
    // Ana's account is not in Jose's scope — no row at all.
    expect(rows.some((row) => row.holdingId === "asset_ana_only")).toBe(false);
  });

  test("investment rows carry units and unit price as decimal strings", () => {
    const workspace = makeWorkspace();
    const investmentDetails = new Map<string, InvestmentCaptureDetail>([
      ["asset_fund", { unitPrice: "130.25", units: "99.8123" }],
    ]);
    const rows = buildSnapshotHoldingRows({
      assets: makeAssets(workspace),
      investmentDetails,
      liabilities: makeLiabilities(workspace),
      scopeId: "household",
      workspace,
    });

    const fundRow = rows.find((row) => row.holdingId === "asset_fund");
    expect(fundRow?.units).toBe("99.8123");
    expect(fundRow?.unitPrice).toBe("130.25");

    // Non-investments never carry units or unit price.
    const cashRow = rows.find((row) => row.holdingId === "asset_cash");
    expect(cashRow?.units).toBeUndefined();
    expect(cashRow?.unitPrice).toBeUndefined();
  });
});

describe("captureValuedNetWorthSnapshot — reconciliation invariant", () => {
  test("asset rows sum exactly to headline gross assets and liability rows to debts", () => {
    const workspace = makeWorkspace();
    // Uneven splits force per-holding rounding — the invariant must still hold
    // exactly because rows and headline figures round the same way.
    const assets = [
      createManualAsset(workspace, {
        currency: "EUR",
        currentValueMinor: 33_333,
        id: "asset_odd",
        liquidityTier: "cash",
        name: "Cuenta impar",
        ownership: [
          { memberId: "member_jose", shareBps: 3_333 },
          { memberId: "member_ana", shareBps: 6_667 },
        ],
        type: "cash",
      }),
    ];
    const liabilities = [
      createLiability(workspace, {
        balanceMinor: 11_111,
        currency: "EUR",
        id: "liability_odd",
        name: "Deuda impar",
        ownership: [
          { memberId: "member_jose", shareBps: 3_333 },
          { memberId: "member_ana", shareBps: 6_667 },
        ],
        type: "debt",
      }),
    ];

    for (const scopeId of ["household", "member_jose", "member_ana"]) {
      const { holdings, snapshot } = captureValuedNetWorthSnapshot({
        assets,
        capturedAt: "2026-06-10T10:00:00.000Z",
        id: `snapshot_${scopeId}`,
        liabilities,
        scopeId,
        scopeLabel: scopeId,
        workspace,
      });

      const assetSum = holdings
        .filter((row) => row.kind === "asset")
        .reduce((sum, row) => sum + row.valueMinor, 0);
      const liabilitySum = holdings
        .filter((row) => row.kind === "liability")
        .reduce((sum, row) => sum + row.valueMinor, 0);

      expect(assetSum).toBe(snapshot.grossAssets.amountMinor);
      expect(liabilitySum).toBe(snapshot.debts.amountMinor);
    }
  });

  test("returns the snapshot with the same headline figures as captureNetWorthSnapshot", () => {
    const workspace = makeWorkspace();
    const { snapshot } = captureValuedNetWorthSnapshot({
      assets: makeAssets(workspace),
      capturedAt: "2026-06-10T10:00:00.000Z",
      id: "snapshot_household",
      liabilities: makeLiabilities(workspace),
      scopeId: "household",
      scopeLabel: "Hogar",
      workspace,
    });

    expect(snapshot.grossAssets.amountMinor).toBe(370_000_00);
    expect(snapshot.debts.amountMinor).toBe(123_000_00);
    expect(snapshot.totalNetWorth.amountMinor).toBe(247_000_00);
  });
});

describe("assertSnapshotHoldingsReconcile — both sides of the invariant", () => {
  const reconciledRows = [
    {
      countsAsHousing: false,
      holdingId: "asset_a",
      kind: "asset" as const,
      label: "A",
      liquidityTier: "cash" as const,
      securesHousing: false,
      valueMinor: 70_00,
    },
    {
      countsAsHousing: false,
      holdingId: "asset_b",
      kind: "asset" as const,
      label: "B",
      liquidityTier: "market" as const,
      securesHousing: false,
      valueMinor: 30_00,
    },
    {
      countsAsHousing: false,
      holdingId: "liability_c",
      kind: "liability" as const,
      label: "C",
      liquidityTier: null,
      securesHousing: false,
      valueMinor: 25_00,
    },
  ];

  test("passes silently when rows sum exactly to the headline figures", () => {
    expect(() =>
      assertSnapshotHoldingsReconcile(reconciledRows, {
        debtsMinor: 25_00,
        grossAssetsMinor: 100_00,
      }),
    ).not.toThrow();
  });

  test("fails loudly when asset rows do not sum to gross assets", () => {
    expect(() =>
      assertSnapshotHoldingsReconcile(reconciledRows, {
        debtsMinor: 25_00,
        grossAssetsMinor: 99_99,
      }),
    ).toThrow(/gross assets/i);
  });

  test("fails loudly when liability rows do not sum to debts", () => {
    expect(() =>
      assertSnapshotHoldingsReconcile(reconciledRows, {
        debtsMinor: 26_00,
        grossAssetsMinor: 100_00,
      }),
    ).toThrow(/debts/i);
  });
});

describe("assertSnapshotHoldingsReconcile — five-figure invariant (#181)", () => {
  // A piso (illiquid housing asset), a market fund (liquid), a mortgage that
  // secures the piso (housing debt, null rung), and a cash-tier card (liquid debt).
  const rows: SnapshotHoldingRow[] = [
    {
      countsAsHousing: true, // piso is the housing asset
      holdingId: "asset_piso",
      kind: "asset",
      label: "Piso",
      liquidityTier: "illiquid",
      securesHousing: false,
      valueMinor: 200_000_00,
    },
    {
      countsAsHousing: false,
      holdingId: "asset_fund",
      kind: "asset",
      label: "Fondo",
      liquidityTier: "market",
      securesHousing: false,
      valueMinor: 10_000_00,
    },
    {
      countsAsHousing: false,
      holdingId: "liab_mortgage",
      kind: "liability",
      label: "Hipoteca",
      liquidityTier: null,
      securesHousing: true,
      valueMinor: 120_000_00,
    },
    {
      countsAsHousing: false,
      holdingId: "liab_card",
      kind: "liability",
      label: "Tarjeta",
      liquidityTier: null,
      securesHousing: false,
      valueMinor: 1_000_00,
    },
  ];

  // The five figures consistent with the rows. countsAsHousing drives housing assets:
  // piso (countsAsHousing=true) = 200k; housingDebts (securesHousing=true) = 120k.
  // housingEquity = 200k − 120k = 80k. liquidAssets 10k − liquidNonHousingDebts 1k = 9k.
  // total = 210k − 121k = 89k.
  const correct = {
    debtsMinor: 121_000_00,
    grossAssetsMinor: 210_000_00,
    housingEquityMinor: 80_000_00,
    liquidNetWorthMinor: 9_000_00,
    totalNetWorthMinor: 89_000_00,
  };

  test("passes silently when all five figures reconcile with the rows", () => {
    expect(() => assertSnapshotHoldingsReconcile(rows, correct)).not.toThrow();
  });

  test("throws when totalNetWorth is not grossAssets − debts", () => {
    expect(() =>
      assertSnapshotHoldingsReconcile(rows, {
        ...correct,
        totalNetWorthMinor: 90_000_00,
      }),
    ).toThrow(/total net worth/i);
  });

  test("throws when housing equity imputes a non-housing debt to the housing axis", () => {
    // The wrong-axis corruption: the card (securesHousing=false) was netted
    // against housing equity (80k − 1k = 79k), and pulled out of liquid (9k → 10k).
    // Row-derived housing debts exclude the card, so the figures contradict.
    expect(() =>
      assertSnapshotHoldingsReconcile(rows, {
        ...correct,
        housingEquityMinor: 79_000_00,
        liquidNetWorthMinor: 10_000_00,
      }),
    ).toThrow(/housing equity|liquid net worth/i);
  });

  test("throws when liquid net worth omits a liquid, non-housing debt", () => {
    expect(() =>
      assertSnapshotHoldingsReconcile(rows, {
        ...correct,
        liquidNetWorthMinor: 10_000_00,
      }),
    ).toThrow(/liquid net worth/i);
  });

  test("throws when housing equity is wrong because a housing asset's countsAsHousing flag drives the asset sum (#181)", () => {
    // A row set where the piso has countsAsHousing=true: housing assets = 200k,
    // housing debts = 120k, so correct housing equity = 80k. Once countsAsHousing is
    // self-classifying on each asset row, the caller no longer supplies
    // housingAssetsMinor — it is derived from the rows directly. Supplying a wrong
    // housingEquityMinor must throw regardless (the 6th check in the invariant).
    const rowsWithFlag: SnapshotHoldingRow[] = rows.map((r) => ({
      ...r,
      countsAsHousing: r.holdingId === "asset_piso",
    }));
    // correct housing equity = 200k (piso, countsAsHousing=true) − 120k (securesHousing=true) = 80k.
    // Supplying 79k contradicts what the flags derive (no housingAssetsMinor needed now).
    expect(() =>
      assertSnapshotHoldingsReconcile(rowsWithFlag, {
        ...correct,
        housingEquityMinor: 79_000_00,
      }),
    ).toThrow(/housing equity/i);
  });
});

describe("deriveHoldingDeltas", () => {
  function row(partial: Partial<SnapshotHoldingRow> = {}): SnapshotHoldingRow {
    return {
      holdingId: "h",
      kind: "asset",
      label: "Holding",
      liquidityTier: "market",
      countsAsHousing: false,
      securesHousing: false,
      valueMinor: 0,
      ...partial,
    };
  }

  test("an asset that gains value contributes the rise positively", () => {
    const previous = [row({ holdingId: "fund", label: "Fondo", valueMinor: 1_000 })];
    const current = [row({ holdingId: "fund", label: "Fondo", valueMinor: 1_500 })];

    const deltas = deriveHoldingDeltas(previous, current);

    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      holdingId: "fund",
      contributionMinor: 500,
      status: "changed",
    });
  });

  test("a liability paid down contributes positively to net worth", () => {
    const previous = [
      row({
        holdingId: "loan",
        kind: "liability",
        label: "Hipoteca",
        valueMinor: 10_000,
      }),
    ];
    const current = [
      row({ holdingId: "loan", kind: "liability", label: "Hipoteca", valueMinor: 9_200 }),
    ];

    const deltas = deriveHoldingDeltas(previous, current);

    // Balance fell by 800 → net worth rose by 800.
    expect(deltas[0]?.contributionMinor).toBe(800);
  });

  test("a holding present only on the current day is new and contributes its full value", () => {
    const current = [row({ holdingId: "gold", label: "Oro", valueMinor: 1_200 })];

    const deltas = deriveHoldingDeltas([], current);

    expect(deltas[0]).toMatchObject({
      holdingId: "gold",
      contributionMinor: 1_200,
      status: "new",
    });
  });

  test("a holding present only on the previous day is gone and subtracts its value", () => {
    const previous = [
      row({ holdingId: "sold", label: "Acción vendida", valueMinor: 3_000 }),
    ];

    const deltas = deriveHoldingDeltas(previous, []);

    expect(deltas[0]).toMatchObject({
      holdingId: "sold",
      contributionMinor: -3_000,
      status: "gone",
    });
  });

  test("holdings whose value did not move are omitted", () => {
    const previous = [
      row({ holdingId: "flat", valueMinor: 5_000 }),
      row({ holdingId: "fund", valueMinor: 1_000 }),
    ];
    const current = [
      row({ holdingId: "flat", valueMinor: 5_000 }),
      row({ holdingId: "fund", valueMinor: 1_400 }),
    ];

    const deltas = deriveHoldingDeltas(previous, current);

    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.holdingId).toBe("fund");
  });

  test("sorted by contribution magnitude, largest first", () => {
    const previous = [
      row({ holdingId: "small", valueMinor: 100 }),
      row({ holdingId: "big", valueMinor: 100 }),
      row({ holdingId: "mid", valueMinor: 100 }),
    ];
    const current = [
      row({ holdingId: "small", valueMinor: 110 }),
      row({ holdingId: "big", valueMinor: 100 - 5_000 + 100 }), // drops by ~5000
      row({ holdingId: "mid", valueMinor: 1_100 }),
    ];

    const deltas = deriveHoldingDeltas(previous, current);

    expect(deltas.map((d) => d.holdingId)).toEqual(["big", "mid", "small"]);
  });

  test("contributions sum exactly to the aggregate net-worth change (ADR 0008)", () => {
    const previous = [
      row({ holdingId: "cash", valueMinor: 50_000 }),
      row({ holdingId: "fund", valueMinor: 20_000 }),
      row({ holdingId: "loan", kind: "liability", valueMinor: 30_000 }),
    ];
    const current = [
      row({ holdingId: "cash", valueMinor: 51_000 }), // +1000 asset
      row({ holdingId: "fund", valueMinor: 19_500 }), // −500 asset
      row({ holdingId: "loan", kind: "liability", valueMinor: 29_400 }), // −600 debt → +600
      row({ holdingId: "gold", valueMinor: 2_000 }), // new asset → +2000
    ];

    const sum = (rows: SnapshotHoldingRow[]) =>
      rows.reduce(
        (net, r) => net + (r.kind === "asset" ? r.valueMinor : -r.valueMinor),
        0,
      );
    const aggregateDelta = sum(current) - sum(previous);

    const totalContribution = deriveHoldingDeltas(previous, current).reduce(
      (acc, d) => acc + d.contributionMinor,
      0,
    );

    expect(totalContribution).toBe(aggregateDelta);
    expect(totalContribution).toBe(3_100);
  });
});

describe("buildSnapshotHoldingRows — per-position breakdown (ADR 0035)", () => {
  function coinCollection(
    workspace: Workspace,
    ownership = [{ memberId: "member_jose", shareBps: 10_000 }],
  ): ManualAsset {
    return createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 5_000_00,
      id: "asset_coins",
      liquidityTier: "illiquid",
      name: "Colección Numista",
      ownership,
      type: "manual",
    });
  }

  const twoCoins: SnapshotPositionInput[] = [
    {
      positionKey: "numista_item_1",
      label: "5 Pounds Charles III",
      valueMinor: 3_000_00,
      metal: "gold",
      imageUrl: "https://numista.test/charles.jpg",
    },
    {
      positionKey: "numista_item_2",
      label: "Krugerrand",
      valueMinor: 2_000_00,
      metal: "gold",
      imageUrl: null,
    },
  ];

  test("freezes one position row per coin under a connected holding, summing to the holding", () => {
    const workspace = makeWorkspace();
    const rows = buildSnapshotHoldingRows({
      assets: [coinCollection(workspace)],
      positionDetails: new Map([["asset_coins", twoCoins]]),
      scopeId: "household",
      workspace,
    });

    const holding = rows.find((row) => row.holdingId === "asset_coins");
    expect(holding?.valueMinor).toBe(5_000_00);
    // Each coin frozen as a child row: stable key, label, value, metal + image.
    expect(holding?.positions).toEqual([
      {
        positionKey: "numista_item_1",
        label: "5 Pounds Charles III",
        valueMinor: 3_000_00,
        metal: "gold",
        imageUrl: "https://numista.test/charles.jpg",
      },
      {
        positionKey: "numista_item_2",
        label: "Krugerrand",
        valueMinor: 2_000_00,
        metal: "gold",
        imageUrl: null,
      },
    ]);
    // ADR 0035 invariant: the coin rows sum EXACTLY to the holding's value.
    const sum = holding!.positions!.reduce((acc, p) => acc + p.valueMinor, 0);
    expect(sum).toBe(holding!.valueMinor);
  });

  test("a manual holding with no position breakdown carries no position rows", () => {
    const workspace = makeWorkspace();
    const rows = buildSnapshotHoldingRows({
      assets: makeAssets(workspace),
      liabilities: makeLiabilities(workspace),
      scopeId: "household",
      workspace,
    });

    for (const row of rows) {
      expect(row.positions).toBeUndefined();
    }
  });

  test("scope-allocates the position rows so they sum EXACTLY to the holding's owned value", () => {
    const workspace = makeWorkspace();
    // A 50/50 household collection, captured for Jose's scope → he owns half.
    const rows = buildSnapshotHoldingRows({
      assets: [
        coinCollection(workspace, [
          { memberId: "member_jose", shareBps: 5_000 },
          { memberId: "member_ana", shareBps: 5_000 },
        ]),
      ],
      positionDetails: new Map([["asset_coins", twoCoins]]),
      scopeId: "member_jose",
      workspace,
    });

    const holding = rows.find((row) => row.holdingId === "asset_coins");
    // Half of the 5_000_00 collection.
    expect(holding?.valueMinor).toBe(2_500_00);
    // The coin rows are scope-allocated too: 3:2 of 2_500_00.
    expect(holding?.positions?.map((p) => p.valueMinor)).toEqual([1_500_00, 1_000_00]);
    // ADR 0035 invariant holds under partial ownership.
    const sum = holding!.positions!.reduce((acc, p) => acc + p.valueMinor, 0);
    expect(sum).toBe(holding!.valueMinor);
  });

  test("distributes the rounding residual by largest remainder, keeping the sub-sum exact", () => {
    const workspace = makeWorkspace();
    // Three equal coins of 1,00 € each (full collection 3,00 €). Jose owns a third,
    // so his owned share is 1,00 € — which cannot split three ways evenly.
    const threeEqualCoins: SnapshotPositionInput[] = [
      {
        positionKey: "c1",
        label: "Coin 1",
        valueMinor: 1_00,
        metal: null,
        imageUrl: null,
      },
      {
        positionKey: "c2",
        label: "Coin 2",
        valueMinor: 1_00,
        metal: null,
        imageUrl: null,
      },
      {
        positionKey: "c3",
        label: "Coin 3",
        valueMinor: 1_00,
        metal: null,
        imageUrl: null,
      },
    ];
    const thirds = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 3_00,
      id: "asset_coins",
      liquidityTier: "illiquid",
      name: "Colección Numista",
      ownership: [
        { memberId: "member_jose", shareBps: 3_333 },
        { memberId: "member_ana", shareBps: 6_667 },
      ],
      type: "manual",
    });

    const rows = buildSnapshotHoldingRows({
      assets: [thirds],
      positionDetails: new Map([["asset_coins", threeEqualCoins]]),
      scopeId: "member_jose",
      workspace,
    });

    const holding = rows.find((row) => row.holdingId === "asset_coins");
    // allocateByBps(300, 3333) = round(99.99) = 100 minor units owned.
    expect(holding?.valueMinor).toBe(1_00);
    // 100 ÷ 3 leaves a 1-unit residual; largest-remainder gives it to the first.
    expect(holding?.positions?.map((p) => p.valueMinor)).toEqual([34, 33, 33]);
    const sum = holding!.positions!.reduce((acc, p) => acc + p.valueMinor, 0);
    expect(sum).toBe(holding!.valueMinor);
  });

  test("stays exact for a large collection whose value × weight overflows MAX_SAFE_INTEGER", () => {
    const workspace = makeWorkspace();
    // A 2.000.000 € bullion collection at 50% ownership: the owned value (1e8 minor)
    // times a coin's weight (1.2e8 minor) is 1.2e16 — past Number.MAX_SAFE_INTEGER
    // (~9e15), so a naive product would corrupt the floor. The BigInt path keeps it
    // exact and the sub-sum reconciles.
    const bigCoins: SnapshotPositionInput[] = [
      {
        positionKey: "bar1",
        label: "Lingote 1",
        valueMinor: 1_200_000_00,
        metal: "gold",
        imageUrl: null,
      },
      {
        positionKey: "bar2",
        label: "Lingote 2",
        valueMinor: 800_000_00,
        metal: "gold",
        imageUrl: null,
      },
    ];
    const bullion = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 2_000_000_00,
      id: "asset_coins",
      liquidityTier: "illiquid",
      name: "Lingotes",
      ownership: [
        { memberId: "member_jose", shareBps: 5_000 },
        { memberId: "member_ana", shareBps: 5_000 },
      ],
      type: "manual",
    });

    const rows = buildSnapshotHoldingRows({
      assets: [bullion],
      positionDetails: new Map([["asset_coins", bigCoins]]),
      scopeId: "member_jose",
      workspace,
    });

    const holding = rows.find((row) => row.holdingId === "asset_coins");
    expect(holding?.valueMinor).toBe(1_000_000_00); // half of 2.000.000 €
    expect(holding?.positions?.map((p) => p.valueMinor)).toEqual([
      600_000_00, 400_000_00,
    ]);
    const sum = holding!.positions!.reduce((acc, p) => acc + p.valueMinor, 0);
    expect(sum).toBe(holding!.valueMinor);
  });
});

describe("assertSnapshotHoldingsReconcile — per-position sub-sum (ADR 0035)", () => {
  function connectedRow(positions: SnapshotPositionRow[]): SnapshotHoldingRow {
    return {
      countsAsHousing: false,
      holdingId: "asset_coins",
      kind: "asset",
      label: "Colección Numista",
      liquidityTier: "illiquid",
      positions,
      securesHousing: false,
      valueMinor: 5_000_00,
    };
  }

  test("rejects a connected holding whose position rows do not sum to its value", () => {
    const rows = [
      connectedRow([
        {
          positionKey: "c1",
          label: "A",
          valueMinor: 3_000_00,
          metal: null,
          imageUrl: null,
        },
        {
          positionKey: "c2",
          label: "B",
          valueMinor: 1_000_00,
          metal: null,
          imageUrl: null,
        },
      ]),
    ];

    expect(() =>
      assertSnapshotHoldingsReconcile(rows, {
        debtsMinor: 0,
        grossAssetsMinor: 5_000_00,
      }),
    ).toThrow(/Colección Numista|asset_coins/);
  });

  test("accepts a connected holding whose position rows sum exactly to its value", () => {
    const rows = [
      connectedRow([
        {
          positionKey: "c1",
          label: "A",
          valueMinor: 3_000_00,
          metal: null,
          imageUrl: null,
        },
        {
          positionKey: "c2",
          label: "B",
          valueMinor: 2_000_00,
          metal: null,
          imageUrl: null,
        },
      ]),
    ];

    expect(() =>
      assertSnapshotHoldingsReconcile(rows, {
        debtsMinor: 0,
        grossAssetsMinor: 5_000_00,
      }),
    ).not.toThrow();
  });

  test("a legacy holding with no position rows reconciles exactly as before", () => {
    const workspace = makeWorkspace();
    const rows = buildSnapshotHoldingRows({
      assets: makeAssets(workspace),
      liabilities: makeLiabilities(workspace),
      scopeId: "household",
      workspace,
    });

    // No position rows anywhere → the original ADR 0008 invariant alone applies.
    expect(() =>
      assertSnapshotHoldingsReconcile(rows, {
        debtsMinor: 123_000_00,
        grossAssetsMinor: 370_000_00,
      }),
    ).not.toThrow();
  });
});

describe("derivePositionDeltas — second drilldown level (ADR 0035)", () => {
  function coin(
    positionKey: string,
    valueMinor: number,
    overrides: Partial<SnapshotPositionRow> = {},
  ): SnapshotPositionRow {
    return {
      positionKey,
      label: positionKey,
      valueMinor,
      metal: "gold",
      imageUrl: null,
      ...overrides,
    };
  }

  test("attributes a connected holding's change to its per-coin movers, signed and sorted", () => {
    const previous = [coin("c1", 3_000_00, { label: "Sovereign" }), coin("c2", 1_000_00)];
    const current = [
      coin("c1", 3_141_00, { label: "Sovereign" }), // +141,00 €
      coin("c2", 1_000_00), // unchanged → omitted
      coin("c3", 50_00, { label: "Krugerrand" }), // newly acquired → +50,00 €
    ];

    expect(derivePositionDeltas(previous, current)).toEqual([
      {
        positionKey: "c1",
        label: "Sovereign",
        metal: "gold",
        imageUrl: null,
        contributionMinor: 141_00,
        status: "changed",
      },
      {
        positionKey: "c3",
        label: "Krugerrand",
        metal: "gold",
        imageUrl: null,
        contributionMinor: 50_00,
        status: "new",
      },
    ]);
  });

  test("a coin entering on its acquisition date reads as a step-up (full value, status new)", () => {
    const deltas: PositionDelta[] = derivePositionDeltas(
      [],
      [coin("c1", 3_000_00, { label: "Sovereign" })],
    );
    expect(deltas).toEqual([
      {
        positionKey: "c1",
        label: "Sovereign",
        metal: "gold",
        imageUrl: null,
        contributionMinor: 3_000_00,
        status: "new",
      },
    ]);
  });

  test("a coin that left the collection reads as gone with a negative contribution", () => {
    expect(
      derivePositionDeltas([coin("c1", 3_000_00, { label: "Sovereign" })], []),
    ).toEqual([
      {
        positionKey: "c1",
        label: "Sovereign",
        metal: "gold",
        imageUrl: null,
        contributionMinor: -3_000_00,
        status: "gone",
      },
    ]);
  });

  test("no position rows yields no movers (so no second drilldown level appears)", () => {
    expect(derivePositionDeltas([], [])).toEqual([]);
  });
});
