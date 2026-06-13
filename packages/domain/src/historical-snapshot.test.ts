/**
 * Historical snapshot reconstruction (ADR 0012, PRD #107, Slice 1 / #110).
 *
 * Pure-module tests: given operations + manual-value history + a target date,
 * the module reconstructs the valued portfolio as it was on that date.
 */
import { describe, expect, test } from "vitest";

import {
  amortizationPaymentDatesUpTo,
  buildSnapshotAtDate,
  recalculateSnapshotForAsset,
  recalculateSnapshotForHousing,
  recalculateSnapshotForLiability,
  type DebtBalanceCurveInputs,
} from "./historical-snapshot";
import { lastKnownValueAtDate, type ManualValuePoint } from "./value-history";
import type {
  InvestmentOperation,
  Liability,
  ManualAsset,
  NetWorthSnapshot,
  SnapshotHoldingRow,
  Workspace,
} from "./index";
import { createLiability, createManualAsset, createWorkspace } from "./index";

function makeWorkspace(): Workspace {
  return createWorkspace({
    baseCurrency: "EUR",
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
}

function investment(workspace: Workspace, id: string, name: string): ManualAsset {
  return createManualAsset(workspace, {
    currency: "EUR",
    currentValueMinor: 0,
    id,
    liquidityTier: "market",
    name,
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "investment",
  });
}

function cash(workspace: Workspace, id: string, valueMinor: number): ManualAsset {
  return createManualAsset(workspace, {
    currency: "EUR",
    currentValueMinor: valueMinor,
    id,
    liquidityTier: "cash",
    name: "Cuenta",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "cash",
  });
}

function housing(workspace: Workspace, id: string, valueMinor: number): ManualAsset {
  return createManualAsset(workspace, {
    currency: "EUR",
    currentValueMinor: valueMinor,
    id,
    liquidityTier: "illiquid",
    name: "Piso",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "real_estate",
  });
}

function buy(
  assetId: string,
  id: string,
  executedAt: string,
  units: string,
  pricePerUnit: string,
): InvestmentOperation {
  return {
    assetId,
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id,
    kind: "buy",
    pricePerUnit,
    units,
  };
}

const BASE = {
  capturedAt: "2024-06-01T12:00:00.000Z",
  id: "snap_test",
  scopeId: "member_jose",
  scopeLabel: "Jose",
} as const;

describe("lastKnownValueAtDate", () => {
  const points: ManualValuePoint[] = [
    { dateKey: "2024-01-01", valueMinor: 100 },
    { dateKey: "2024-03-01", valueMinor: 300 },
    { dateKey: "2024-06-01", valueMinor: 600 },
  ];

  test("returns the most recent value on or before the date", () => {
    expect(lastKnownValueAtDate(points, "2024-04-15")).toBe(300);
    expect(lastKnownValueAtDate(points, "2024-03-01")).toBe(300);
    expect(lastKnownValueAtDate(points, "2024-12-31")).toBe(600);
  });

  test("returns undefined when no value reaches back far enough", () => {
    expect(lastKnownValueAtDate(points, "2023-12-31")).toBeUndefined();
    expect(lastKnownValueAtDate([], "2024-06-01")).toBeUndefined();
    expect(lastKnownValueAtDate(undefined, "2024-06-01")).toBeUndefined();
  });
});

describe("buildSnapshotAtDate", () => {
  test("values an investment with an operation on or before the date", () => {
    const workspace = makeWorkspace();
    const fund = investment(workspace, "asset_fund", "Fondo");
    const operationsByAsset = new Map([
      ["asset_fund", [buy("asset_fund", "op1", "2024-01-10", "10", "100")]],
    ]);

    const result = buildSnapshotAtDate({
      ...BASE,
      assets: [fund],
      liabilities: [],
      manualValueHistory: new Map(),
      operationsByAsset,
      targetDate: "2024-06-01",
      workspace,
    });

    expect(result).not.toBeNull();
    // 10 units × 100 = 1000.00 EUR
    expect(result!.snapshot.grossAssets.amountMinor).toBe(1_000_00);
    expect(result!.snapshot.dateKey).toBe("2024-06-01");
    const fundRow = result!.holdings.find((h) => h.holdingId === "asset_fund");
    expect(fundRow?.units).toBe("10");
    expect(fundRow?.unitPrice).toBe("100");
  });

  test("values a primary-residence-flagged investment by its operations, not as housing (#148 regression)", () => {
    const workspace = makeWorkspace();
    // An investment can carry isPrimaryResidence; it must still be valued by its
    // operation ledger (derived), never reclassified to the housing curve.
    const fund = {
      ...investment(workspace, "asset_fund", "Fondo"),
      isPrimaryResidence: true,
    };
    const operationsByAsset = new Map([
      ["asset_fund", [buy("asset_fund", "op1", "2024-01-10", "10", "100")]],
    ]);

    const result = buildSnapshotAtDate({
      ...BASE,
      assets: [fund],
      liabilities: [],
      manualValueHistory: new Map(),
      operationsByAsset,
      targetDate: "2024-06-01",
      workspace,
    });

    expect(result).not.toBeNull();
    expect(result!.snapshot.grossAssets.amountMinor).toBe(1_000_00); // 10 × 100, derived
    const fundRow = result!.holdings.find((h) => h.holdingId === "asset_fund");
    expect(fundRow?.units).toBe("10"); // investmentDetails preserved, not dropped
    expect(fundRow?.unitPrice).toBe("100");
  });

  test("omits a primary-residence-flagged investment before its first operation (#148 regression)", () => {
    const workspace = makeWorkspace();
    const fund = {
      ...investment(workspace, "asset_fund", "Fondo"),
      isPrimaryResidence: true,
    };
    const operationsByAsset = new Map([
      ["asset_fund", [buy("asset_fund", "op1", "2024-09-10", "10", "100")]],
    ]);

    const result = buildSnapshotAtDate({
      ...BASE,
      assets: [fund],
      liabilities: [],
      manualValueHistory: new Map(),
      operationsByAsset,
      targetDate: "2024-06-01",
      workspace,
    });

    // Not yet held → omitted, never resurrected at its current value as housing.
    expect(result).toBeNull();
  });

  test("omits an investment with no operation on or before the date", () => {
    const workspace = makeWorkspace();
    const fund = investment(workspace, "asset_fund", "Fondo");
    const operationsByAsset = new Map([
      ["asset_fund", [buy("asset_fund", "op1", "2024-09-10", "10", "100")]],
    ]);

    const result = buildSnapshotAtDate({
      ...BASE,
      assets: [fund],
      liabilities: [],
      manualValueHistory: new Map(),
      operationsByAsset,
      targetDate: "2024-06-01",
      workspace,
    });

    // No holdings at all on this date → nothing to capture.
    expect(result).toBeNull();
  });

  test("uses the last known operation price when there is a price gap", () => {
    const workspace = makeWorkspace();
    const fund = investment(workspace, "asset_fund", "Fondo");
    const operationsByAsset = new Map([
      [
        "asset_fund",
        [
          buy("asset_fund", "op1", "2024-01-10", "10", "100"),
          buy("asset_fund", "op2", "2024-03-10", "5", "120"),
          // A later op exists but must not influence the 2024-06-01 valuation
          // because the most recent op ≤ date is op2 @ 120.
          buy("asset_fund", "op3", "2024-09-10", "5", "999"),
        ],
      ],
    ]);

    const result = buildSnapshotAtDate({
      ...BASE,
      assets: [fund],
      liabilities: [],
      manualValueHistory: new Map(),
      operationsByAsset,
      targetDate: "2024-06-01",
      workspace,
    });

    // 15 units held by 2024-06-01, priced at the last known op price (120).
    expect(result!.snapshot.grossAssets.amountMinor).toBe(15 * 120_00);
    expect(result!.holdings[0]?.unitPrice).toBe("120");
  });

  test("captured unit prices override operation prices (ripple recalc)", () => {
    const workspace = makeWorkspace();
    const fund = investment(workspace, "asset_fund", "Fondo");
    const operationsByAsset = new Map([
      ["asset_fund", [buy("asset_fund", "op1", "2024-01-10", "10", "100")]],
    ]);

    const result = buildSnapshotAtDate({
      ...BASE,
      assets: [fund],
      capturedUnitPrices: new Map([["asset_fund", "150"]]),
      liabilities: [],
      manualValueHistory: new Map(),
      operationsByAsset,
      targetDate: "2024-06-01",
      workspace,
    });

    // 10 units × the captured price 150, not the op price 100.
    expect(result!.snapshot.grossAssets.amountMinor).toBe(10 * 150_00);
    expect(result!.holdings[0]?.unitPrice).toBe("150");
  });

  test("omits a position fully sold by the date", () => {
    const workspace = makeWorkspace();
    const fund = investment(workspace, "asset_fund", "Fondo");
    const operationsByAsset = new Map([
      [
        "asset_fund",
        [
          buy("asset_fund", "op1", "2024-01-10", "10", "100"),
          {
            assetId: "asset_fund",
            currency: "EUR",
            executedAt: "2024-02-10",
            feesMinor: 0,
            id: "op2",
            kind: "sell" as const,
            pricePerUnit: "110",
            units: "10",
          },
        ],
      ],
    ]);

    const result = buildSnapshotAtDate({
      ...BASE,
      assets: [fund],
      liabilities: [],
      manualValueHistory: new Map(),
      operationsByAsset,
      targetDate: "2024-06-01",
      workspace,
    });

    expect(result).toBeNull();
  });

  test("manual holding uses last known value ≤ date, else current value", () => {
    const workspace = makeWorkspace();
    const account = cash(workspace, "asset_cash", 9_999_00); // current value fallback
    const withHistory = cash(workspace, "asset_cash_2", 5_000_00);

    const result = buildSnapshotAtDate({
      ...BASE,
      assets: [account, withHistory],
      liabilities: [],
      manualValueHistory: new Map([
        [
          "asset_cash_2",
          [
            { dateKey: "2024-01-01", valueMinor: 1_000_00 },
            { dateKey: "2024-05-01", valueMinor: 2_000_00 },
            { dateKey: "2024-08-01", valueMinor: 8_000_00 }, // after target, ignored
          ],
        ],
      ]),
      operationsByAsset: new Map(),
      targetDate: "2024-06-01",
      workspace,
    });

    // asset_cash: no history → current value 9999.00; asset_cash_2: last ≤ date = 2000.00
    expect(result!.snapshot.grossAssets.amountMinor).toBe(9_999_00 + 2_000_00);
  });

  test("values a real_estate asset from its curve when it has anchors (PRD #108)", () => {
    const workspace = makeWorkspace();
    const piso = housing(workspace, "asset_piso", 130_000_00);

    const result = buildSnapshotAtDate({
      ...BASE,
      assets: [piso],
      capturedAt: "2024-10-01T12:00:00.000Z",
      housingValuationByAsset: new Map([
        [
          "asset_piso",
          {
            anchors: [
              {
                adjustsPriorCurve: true,
                valuationDate: "2024-01-01",
                valueMinor: 100_000_00,
              },
              {
                adjustsPriorCurve: false,
                valuationDate: "2024-07-01",
                valueMinor: 10_000_00,
              },
              {
                adjustsPriorCurve: true,
                valuationDate: "2025-01-01",
                valueMinor: 120_000_00,
              },
            ],
            annualAppreciationRate: "0.03",
            currentValueMinor: 130_000_00,
          },
        ],
      ]),
      liabilities: [],
      manualValueHistory: new Map(),
      operationsByAsset: new Map(),
      targetDate: "2024-10-01",
      today: "2026-06-12",
      workspace,
    });

    // PRD pinned example: 2024-10-01 → 117.486,34 €.
    expect(result!.snapshot.grossAssets.amountMinor).toBe(117_486_34);
    expect(result!.snapshot.housingEquity.amountMinor).toBe(117_486_34);
  });

  test("a real_estate asset with no anchors and no rate keeps last-known-value (no regression)", () => {
    const workspace = makeWorkspace();
    const piso = housing(workspace, "asset_piso", 200_000_00);

    const result = buildSnapshotAtDate({
      ...BASE,
      assets: [piso],
      // No housingValuationByAsset entry → behaves like any manual holding.
      liabilities: [],
      manualValueHistory: new Map([
        ["asset_piso", [{ dateKey: "2024-01-01", valueMinor: 180_000_00 }]],
      ]),
      operationsByAsset: new Map(),
      targetDate: "2024-06-01",
      workspace,
    });

    // Falls back to last known manual value ≤ date, not any curve.
    expect(result!.snapshot.grossAssets.amountMinor).toBe(180_000_00);
  });
});

describe("recalculateSnapshotForHousing", () => {
  const eur = (amountMinor: number) => ({ amountMinor, currency: "EUR" });

  function housingRow(valueMinor: number): SnapshotHoldingRow {
    return {
      holdingId: "asset_piso",
      kind: "asset",
      label: "Piso",
      liquidityTier: "illiquid",
      valueMinor,
    };
  }

  function snapshotWithHousing(grossMinor: number): NetWorthSnapshot {
    return {
      capturedAt: "2024-10-01T12:00:00.000Z",
      dateKey: "2024-10-01",
      debts: eur(0),
      grossAssets: eur(grossMinor),
      housingEquity: eur(grossMinor),
      id: "snap_h",
      isMonthlyClose: false,
      liquidNetWorth: eur(0),
      monthKey: "2024-10",
      scopeId: "member_jose",
      scopeLabel: "Jose",
      totalNetWorth: eur(grossMinor),
      warnings: [],
    };
  }

  test("recomputes the housing row from the curve and adjusts housing figures", () => {
    const workspace = makeWorkspace();
    const piso = housing(workspace, "asset_piso", 130_000_00);

    const result = recalculateSnapshotForHousing({
      asset: piso,
      curve: {
        anchors: [
          {
            adjustsPriorCurve: true,
            valuationDate: "2024-01-01",
            valueMinor: 100_000_00,
          },
          {
            adjustsPriorCurve: false,
            valuationDate: "2024-07-01",
            valueMinor: 10_000_00,
          },
          {
            adjustsPriorCurve: true,
            valuationDate: "2025-01-01",
            valueMinor: 120_000_00,
          },
        ],
        annualAppreciationRate: "0.03",
        currentValueMinor: 130_000_00,
      },
      frozenHoldings: [housingRow(100_000_00)],
      snapshot: snapshotWithHousing(100_000_00),
      today: "2026-06-12",
      workspace,
    })!;

    // 2024-10-01 → 117.486,34 €; the delta moves gross + housingEquity together.
    expect(result.snapshot.grossAssets.amountMinor).toBe(117_486_34);
    expect(result.snapshot.housingEquity.amountMinor).toBe(117_486_34);
    expect(result.snapshot.liquidNetWorth.amountMinor).toBe(0);
  });

  test("preserves other frozen rows verbatim", () => {
    const workspace = makeWorkspace();
    const piso = housing(workspace, "asset_piso", 130_000_00);
    const cashRow: SnapshotHoldingRow = {
      holdingId: "asset_cash",
      kind: "asset",
      label: "Cuenta",
      liquidityTier: "cash",
      valueMinor: 5_000_00,
    };

    const result = recalculateSnapshotForHousing({
      asset: piso,
      curve: {
        anchors: [
          {
            adjustsPriorCurve: true,
            valuationDate: "2024-01-01",
            valueMinor: 100_000_00,
          },
          {
            adjustsPriorCurve: false,
            valuationDate: "2024-07-01",
            valueMinor: 10_000_00,
          },
          {
            adjustsPriorCurve: true,
            valuationDate: "2025-01-01",
            valueMinor: 120_000_00,
          },
        ],
        annualAppreciationRate: "0.03",
        currentValueMinor: 130_000_00,
      },
      frozenHoldings: [housingRow(100_000_00), cashRow],
      snapshot: {
        ...snapshotWithHousing(105_000_00),
        liquidNetWorth: eur(5_000_00),
      },
      today: "2026-06-12",
      workspace,
    })!;

    const cash = result.holdings.find((h) => h.holdingId === "asset_cash");
    expect(cash).toEqual(cashRow);
    expect(result.snapshot.grossAssets.amountMinor).toBe(117_486_34 + 5_000_00);
    expect(result.snapshot.liquidNetWorth.amountMinor).toBe(5_000_00);
  });

  test("falls back to last-known-value when the curve is empty (no anchors, no rate)", () => {
    // Scenario: user deletes the last anchor of a housing asset that had a
    // manual value history. The curve becomes {anchors:[], rate:null}.
    // recalculateSnapshotForHousing must use last-known-value at the snapshot
    // date (same as buildSnapshotAtDate does for an asset without a curve),
    // NOT flat currentValue from valueHousingAtDate with no anchors.
    const workspace = makeWorkspace();
    const piso = housing(workspace, "asset_piso", 200_000_00); // currentValue is 200k

    const result = recalculateSnapshotForHousing({
      asset: piso,
      // Empty curve — last anchor was deleted.
      curve: { anchors: [], annualAppreciationRate: null, currentValueMinor: 200_000_00 },
      frozenHoldings: [housingRow(150_000_00)], // snapshot was frozen at 150k
      // The manual value history recorded 170k on 2024-06-01, before the snapshot date.
      manualValueHistory: new Map([
        ["asset_piso", [{ dateKey: "2024-06-01", valueMinor: 170_000_00 }]],
      ]),
      snapshot: snapshotWithHousing(150_000_00), // snapshot date is 2024-10-01
      today: "2026-06-12",
      workspace,
    })!;

    // Must use last-known-value at 2024-10-01 → 170k (NOT flat currentValue 200k).
    expect(result.snapshot.grossAssets.amountMinor).toBe(170_000_00);
    expect(result.snapshot.housingEquity.amountMinor).toBe(170_000_00);
  });

  test("falls back to currentValue when curve is empty and no manual history reaches that date", () => {
    const workspace = makeWorkspace();
    const piso = housing(workspace, "asset_piso", 200_000_00);

    const result = recalculateSnapshotForHousing({
      asset: piso,
      curve: { anchors: [], annualAppreciationRate: null, currentValueMinor: 200_000_00 },
      frozenHoldings: [housingRow(150_000_00)],
      // No manual history that reaches back to 2024-10-01.
      manualValueHistory: new Map([
        ["asset_piso", [{ dateKey: "2025-01-01", valueMinor: 190_000_00 }]],
      ]),
      snapshot: snapshotWithHousing(150_000_00),
      today: "2026-06-12",
      workspace,
    })!;

    // No history reaches back → falls through to currentValue (the accepted
    // approximation, same as buildSnapshotAtDate for manual holdings).
    expect(result.snapshot.grossAssets.amountMinor).toBe(200_000_00);
  });
});

describe("recalculateSnapshotForAsset", () => {
  const eur = (amountMinor: number) => ({ amountMinor, currency: "EUR" });

  function fundAsset(workspace: Workspace): ManualAsset {
    return investment(workspace, "asset_fund", "Fondo");
  }

  function frozenFundRow(valueMinor: number, units: string): SnapshotHoldingRow {
    return {
      holdingId: "asset_fund",
      kind: "asset",
      label: "Fondo",
      liquidityTier: "market",
      unitPrice: "100",
      units,
      valueMinor,
    };
  }

  // A snapshot whose figures already reflect an unassociated mortgage frozen
  // with a null tier (housing debt) — the exact shape that broke the earlier
  // row-summing recompute.
  function snapshotWithMortgage(): NetWorthSnapshot {
    return {
      capturedAt: "2024-06-01T12:00:00.000Z",
      dateKey: "2024-06-01",
      debts: eur(500_00),
      grossAssets: eur(1_000_00),
      housingEquity: eur(-500_00), // 0 housing assets − 500 housing debt
      id: "snap_x",
      isMonthlyClose: false,
      liquidNetWorth: eur(1_000_00), // fund (market) is liquid; mortgage is not
      monthKey: "2024-06",
      scopeId: "member_jose",
      scopeLabel: "Jose",
      totalNetWorth: eur(500_00),
      warnings: [],
    };
  }

  function mortgageRow(): SnapshotHoldingRow {
    return {
      holdingId: "liab_mortgage",
      kind: "liability",
      label: "Hipoteca",
      liquidityTier: null, // unassociated → frozen as null
      valueMinor: 500_00,
    };
  }

  test("preserves a null-tier liability's housingEquity through a ripple", () => {
    const workspace = makeWorkspace();
    const result = recalculateSnapshotForAsset({
      asset: fundAsset(workspace),
      frozenHoldings: [frozenFundRow(1_000_00, "10"), mortgageRow()],
      // The fund grew to 15 units (a backdated buy) at the captured price 100.
      operations: [
        buy("asset_fund", "op1", "2024-01-10", "10", "100"),
        buy("asset_fund", "op2", "2024-02-10", "5", "100"),
      ],
      snapshot: snapshotWithMortgage(),
      workspace,
    })!;

    // Fund delta = +500 (market/liquid). The mortgage's housing classification
    // is frozen, so housingEquity must NOT move.
    expect(result.snapshot.grossAssets.amountMinor).toBe(1_500_00);
    expect(result.snapshot.liquidNetWorth.amountMinor).toBe(1_500_00);
    expect(result.snapshot.housingEquity.amountMinor).toBe(-500_00);
    expect(result.snapshot.debts.amountMinor).toBe(500_00);
    expect(result.snapshot.totalNetWorth.amountMinor).toBe(1_000_00);
  });

  test("dropping the asset adjusts only its tier's figure and keeps the rest", () => {
    const workspace = makeWorkspace();
    const result = recalculateSnapshotForAsset({
      asset: fundAsset(workspace),
      frozenHoldings: [frozenFundRow(1_000_00, "10"), mortgageRow()],
      operations: [], // the only operation was deleted → fund no longer held
      snapshot: snapshotWithMortgage(),
      workspace,
    })!;

    // Fund (-1000, market) leaves; mortgage stays frozen.
    expect(result.snapshot.grossAssets.amountMinor).toBe(0);
    expect(result.snapshot.liquidNetWorth.amountMinor).toBe(0);
    expect(result.snapshot.housingEquity.amountMinor).toBe(-500_00);
    expect(result.snapshot.debts.amountMinor).toBe(500_00);
    expect(result.holdings.map((h) => h.holdingId)).toEqual(["liab_mortgage"]);
  });

  test("returns null when the operated asset was the snapshot's only holding", () => {
    const workspace = makeWorkspace();
    const result = recalculateSnapshotForAsset({
      asset: fundAsset(workspace),
      frozenHoldings: [frozenFundRow(1_000_00, "10")],
      operations: [], // deleted → nothing left
      snapshot: {
        ...snapshotWithMortgage(),
        debts: eur(0),
        housingEquity: eur(0),
        totalNetWorth: eur(1_000_00),
      },
      workspace,
    });

    expect(result).toBeNull();
  });
});

describe("amortizationPaymentDatesUpTo", () => {
  const plan = {
    annualInterestRate: "0.03",
    initialCapitalMinor: 120_000_00,
    startDate: "2024-01-15",
    termMonths: 240,
  };

  test("returns each monthly boundary date strictly before the target, ascending", () => {
    expect(amortizationPaymentDatesUpTo(plan, "2024-04-10")).toEqual([
      "2024-01-15",
      "2024-02-15",
      "2024-03-15",
    ]);
  });

  test("includes a payment date that equals the target only when strictly before", () => {
    // 2024-03-15 == a payment boundary; the target is that same day → excluded
    // (a snapshot for the target date is generated by the date itself, not here).
    expect(amortizationPaymentDatesUpTo(plan, "2024-03-15")).toEqual([
      "2024-01-15",
      "2024-02-15",
    ]);
  });

  test("clamps day-of-month at short months", () => {
    const monthEndPlan = {
      annualInterestRate: "0.03",
      initialCapitalMinor: 100_000_00,
      startDate: "2024-01-31",
      termMonths: 12,
    };
    expect(amortizationPaymentDatesUpTo(monthEndPlan, "2024-03-15")).toEqual([
      "2024-01-31",
      "2024-02-29",
    ]);
  });

  test("never runs past the loan term", () => {
    const shortPlan = {
      annualInterestRate: "0",
      initialCapitalMinor: 1_000_00,
      startDate: "2024-01-01",
      termMonths: 3,
    };
    // term ends 2024-04-01; only the 4 boundaries [0..3] exist, target far away.
    expect(amortizationPaymentDatesUpTo(shortPlan, "2030-01-01")).toEqual([
      "2024-01-01",
      "2024-02-01",
      "2024-03-01",
      "2024-04-01",
    ]);
  });
});

describe("buildSnapshotAtDate with debtBalanceByLiability", () => {
  function mortgage(workspace: Workspace, id: string, balanceMinor: number): Liability {
    return createLiability(workspace, {
      associatedAssetId: "asset_piso",
      balanceMinor,
      currency: "EUR",
      id,
      name: "Hipoteca",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "mortgage",
    });
  }

  test("values an amortizable liability from its debt curve, not last-known", () => {
    const workspace = makeWorkspace();
    const piso = housing(workspace, "asset_piso", 200_000_00);
    const hipoteca = mortgage(workspace, "liab_h", 100_000_00); // current balance

    const debtCurve: DebtBalanceCurveInputs = {
      anchors: [],
      currentBalanceMinor: 100_000_00,
      debtModel: "amortizable",
      plan: {
        annualInterestRate: "0.03",
        initialCapitalMinor: 150_000_00,
        startDate: "2020-01-01",
        termMonths: 240,
      },
      revisions: [],
    };

    const built = buildSnapshotAtDate({
      ...BASE,
      assets: [piso],
      capturedAt: "2022-01-01T12:00:00.000Z",
      debtBalanceByLiability: new Map([["liab_h", debtCurve]]),
      liabilities: [hipoteca],
      manualValueHistory: new Map(),
      operationsByAsset: new Map(),
      targetDate: "2022-01-01",
      today: "2026-06-12",
      workspace,
    })!;

    // The mortgage balance on 2022-01-01 from the curve (2 years into a 20y loan
    // at 3% on 150k) is well above 100k current; equity = piso − that balance.
    const debtRow = built.holdings.find((h) => h.holdingId === "liab_h")!;
    const balance2022 = debtRow.valueMinor;
    expect(balance2022).toBeGreaterThan(100_000_00); // NOT the last-known 100k
    expect(balance2022).toBeLessThan(150_000_00);
    expect(built.snapshot.debts.amountMinor).toBe(balance2022);
    // Housing equity = housing asset value − housing-tier debt (the mortgage).
    expect(built.snapshot.housingEquity.amountMinor).toBe(200_000_00 - balance2022);
    expect(built.snapshot.totalNetWorth.amountMinor).toBe(200_000_00 - balance2022);
  });

  test("values a revolving liability from anchors, flat outside the range", () => {
    const workspace = makeWorkspace();
    const card = createLiability(workspace, {
      balanceMinor: 1_000_00,
      currency: "EUR",
      id: "liab_card",
      name: "Tarjeta",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "debt",
    });

    const debtCurve: DebtBalanceCurveInputs = {
      anchors: [
        { anchorDate: "2024-01-01", balanceMinor: 2_000_00 },
        { anchorDate: "2024-03-01", balanceMinor: 4_000_00 },
      ],
      currentBalanceMinor: 1_000_00,
      debtModel: "revolving",
    };

    const built = buildSnapshotAtDate({
      ...BASE,
      assets: [cash(workspace, "asset_cash", 5_000_00)],
      capturedAt: "2024-02-01T12:00:00.000Z",
      debtBalanceByLiability: new Map([["liab_card", debtCurve]]),
      liabilities: [card],
      manualValueHistory: new Map(),
      operationsByAsset: new Map(),
      targetDate: "2024-02-01",
      workspace,
    })!;

    // 2024-02-01 is midway (31 of 60 days) between 2k and 4k → 3032,79 €.
    const debtRow = built.holdings.find((h) => h.holdingId === "liab_card")!;
    expect(debtRow.valueMinor).toBe(3_033_33);
    expect(built.snapshot.debts.amountMinor).toBe(3_033_33);
  });

  test("no regression: a liability without a debt model keeps last-known-value", () => {
    const workspace = makeWorkspace();
    const loan = createLiability(workspace, {
      balanceMinor: 8_000_00,
      currency: "EUR",
      id: "liab_loan",
      name: "Prestamo",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "debt",
    });

    const built = buildSnapshotAtDate({
      ...BASE,
      assets: [cash(workspace, "asset_cash", 5_000_00)],
      capturedAt: "2024-02-01T12:00:00.000Z",
      // No debtBalanceByLiability entry → manual last-known-value basis.
      liabilities: [loan],
      manualValueHistory: new Map([
        ["liab_loan", [{ dateKey: "2024-01-01", valueMinor: 9_000_00 }]],
      ]),
      operationsByAsset: new Map(),
      targetDate: "2024-02-01",
      workspace,
    })!;

    const debtRow = built.holdings.find((h) => h.holdingId === "liab_loan")!;
    expect(debtRow.valueMinor).toBe(9_000_00); // last-known, unchanged behaviour
  });

  test("a debt model with no usable data falls back to current balance", () => {
    const workspace = makeWorkspace();
    const loan = createLiability(workspace, {
      balanceMinor: 8_000_00,
      currency: "EUR",
      id: "liab_loan",
      name: "Prestamo",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "debt",
    });

    const built = buildSnapshotAtDate({
      ...BASE,
      assets: [cash(workspace, "asset_cash", 5_000_00)],
      capturedAt: "2024-02-01T12:00:00.000Z",
      debtBalanceByLiability: new Map([
        [
          "liab_loan",
          { anchors: [], currentBalanceMinor: 8_000_00, debtModel: "revolving" },
        ],
      ]),
      liabilities: [loan],
      manualValueHistory: new Map(),
      operationsByAsset: new Map(),
      targetDate: "2024-02-01",
      workspace,
    })!;

    const debtRow = built.holdings.find((h) => h.holdingId === "liab_loan")!;
    expect(debtRow.valueMinor).toBe(8_000_00); // current balance fallback
  });
});

describe("recalculateSnapshotForLiability", () => {
  const eur = (amountMinor: number) => ({ amountMinor, currency: "EUR" });

  function makeMortgage(workspace: Workspace, balanceMinor: number): Liability {
    return createLiability(workspace, {
      associatedAssetId: "asset_piso",
      balanceMinor,
      currency: "EUR",
      id: "liab_h",
      name: "Hipoteca",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "mortgage",
    });
  }

  function pisoRow(valueMinor: number): SnapshotHoldingRow {
    return {
      holdingId: "asset_piso",
      kind: "asset",
      label: "Piso",
      liquidityTier: "illiquid",
      valueMinor,
    };
  }

  // A null-tier frozen mortgage row (unassociated mortgage), exactly the shape
  // buildSnapshotHoldingRows freezes for an unassociated mortgage.
  function mortgageRow(valueMinor: number): SnapshotHoldingRow {
    return {
      holdingId: "liab_h",
      kind: "liability",
      label: "Hipoteca",
      liquidityTier: null,
      valueMinor,
    };
  }

  function snapshotWithHousingDebt(
    pisoMinor: number,
    debtMinor: number,
  ): NetWorthSnapshot {
    return {
      capturedAt: "2022-01-01T12:00:00.000Z",
      dateKey: "2022-01-01",
      debts: eur(debtMinor),
      grossAssets: eur(pisoMinor),
      housingEquity: eur(pisoMinor - debtMinor),
      id: "snap_d",
      isMonthlyClose: false,
      liquidNetWorth: eur(0),
      monthKey: "2022-01",
      scopeId: "member_jose",
      scopeLabel: "Jose",
      totalNetWorth: eur(pisoMinor - debtMinor),
      warnings: [],
    };
  }

  const amortizableCurve: DebtBalanceCurveInputs = {
    anchors: [],
    currentBalanceMinor: 100_000_00,
    debtModel: "amortizable",
    plan: {
      annualInterestRate: "0.03",
      initialCapitalMinor: 150_000_00,
      startDate: "2020-01-01",
      termMonths: 240,
    },
    revisions: [],
  };

  test("threads early repayments through to the recomputed debt row", () => {
    const workspace = makeWorkspace();
    const recompute = (curve: DebtBalanceCurveInputs) =>
      recalculateSnapshotForLiability({
        curve,
        frozenHoldings: [pisoRow(200_000_00), mortgageRow(120_000_00)],
        housingAssetIds: new Set(["asset_piso"]),
        liability: makeMortgage(workspace, 100_000_00),
        snapshot: snapshotWithHousingDebt(200_000_00, 120_000_00),
        workspace,
      })!.holdings.find((h) => h.holdingId === "liab_h")!.valueMinor;

    const withoutRepayment = recompute(amortizableCurve);
    const withRepayment = recompute({
      ...amortizableCurve,
      earlyRepayments: [
        { amountMinor: 20_000_00, mode: "reduce-payment", repaymentDate: "2021-01-01" },
      ],
    });
    // A lump dated before the snapshot date lowers the recomputed balance — the
    // liability ripple must thread early repayments into the curve.
    expect(withRepayment).toBeLessThan(withoutRepayment);
  });

  test("recomputes the debt row from the curve and moves debts + housing equity", () => {
    const workspace = makeWorkspace();
    const result = recalculateSnapshotForLiability({
      curve: amortizableCurve,
      frozenHoldings: [pisoRow(200_000_00), mortgageRow(120_000_00)],
      housingAssetIds: new Set(["asset_piso"]),
      liability: makeMortgage(workspace, 100_000_00),
      snapshot: snapshotWithHousingDebt(200_000_00, 120_000_00),
      workspace,
    })!;

    const debtRow = result.holdings.find((h) => h.holdingId === "liab_h")!;
    const balance = debtRow.valueMinor;
    expect(balance).not.toBe(120_000_00); // recomputed from the curve
    expect(result.snapshot.debts.amountMinor).toBe(balance);
    // Mortgage is housing-tier (mortgage type) → housingEquity moves opposite to debt.
    expect(result.snapshot.housingEquity.amountMinor).toBe(200_000_00 - balance);
    expect(result.snapshot.totalNetWorth.amountMinor).toBe(200_000_00 - balance);
    // Gross assets unchanged.
    expect(result.snapshot.grossAssets.amountMinor).toBe(200_000_00);
    // Reconciliation holds.
    expect(
      result.holdings
        .filter((h) => h.kind === "liability")
        .reduce((s, h) => s + h.valueMinor, 0),
    ).toBe(result.snapshot.debts.amountMinor);
  });

  test("preserves other frozen rows verbatim", () => {
    const workspace = makeWorkspace();
    const cashRow: SnapshotHoldingRow = {
      holdingId: "asset_cash",
      kind: "asset",
      label: "Cuenta",
      liquidityTier: "cash",
      valueMinor: 5_000_00,
    };
    const result = recalculateSnapshotForLiability({
      curve: amortizableCurve,
      frozenHoldings: [pisoRow(200_000_00), mortgageRow(120_000_00), cashRow],
      housingAssetIds: new Set(["asset_piso"]),
      liability: makeMortgage(workspace, 100_000_00),
      snapshot: {
        ...snapshotWithHousingDebt(205_000_00, 120_000_00),
        grossAssets: eur(205_000_00),
        liquidNetWorth: eur(5_000_00),
      },
      workspace,
    })!;

    expect(result.holdings.find((h) => h.holdingId === "asset_cash")).toEqual(cashRow);
    expect(result.holdings.find((h) => h.holdingId === "asset_piso")).toEqual(
      pisoRow(200_000_00),
    );
    expect(result.snapshot.liquidNetWorth.amountMinor).toBe(5_000_00);
  });

  test("a non-housing (cash-tier) debt moves debts but not housing equity", () => {
    const workspace = makeWorkspace();
    const card = createLiability(workspace, {
      balanceMinor: 1_000_00,
      currency: "EUR",
      id: "liab_card",
      name: "Tarjeta",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "debt",
    });
    const cardRow: SnapshotHoldingRow = {
      holdingId: "liab_card",
      kind: "liability",
      label: "Tarjeta",
      liquidityTier: null,
      valueMinor: 1_000_00,
    };
    const cashRow: SnapshotHoldingRow = {
      holdingId: "asset_cash",
      kind: "asset",
      label: "Cuenta",
      liquidityTier: "cash",
      valueMinor: 5_000_00,
    };
    const snapshot: NetWorthSnapshot = {
      capturedAt: "2024-02-01T12:00:00.000Z",
      dateKey: "2024-02-01",
      debts: eur(1_000_00),
      grossAssets: eur(5_000_00),
      housingEquity: eur(0),
      id: "snap_c",
      isMonthlyClose: false,
      liquidNetWorth: eur(4_000_00), // 5000 cash − 1000 cash-tier debt
      monthKey: "2024-02",
      scopeId: "member_jose",
      scopeLabel: "Jose",
      totalNetWorth: eur(4_000_00),
      warnings: [],
    };

    const result = recalculateSnapshotForLiability({
      curve: {
        anchors: [
          { anchorDate: "2024-01-01", balanceMinor: 2_000_00 },
          { anchorDate: "2024-03-01", balanceMinor: 4_000_00 },
        ],
        currentBalanceMinor: 1_000_00,
        debtModel: "revolving",
      },
      frozenHoldings: [cashRow, cardRow],
      housingAssetIds: new Set(),
      liability: card,
      snapshot,
      workspace,
    })!;

    const debtRow = result.holdings.find((h) => h.holdingId === "liab_card")!;
    expect(debtRow.valueMinor).toBe(3_033_33);
    expect(result.snapshot.debts.amountMinor).toBe(3_033_33);
    // cash-tier debt → liquidNetWorth moves, housingEquity stays 0.
    expect(result.snapshot.housingEquity.amountMinor).toBe(0);
    expect(result.snapshot.liquidNetWorth.amountMinor).toBe(5_000_00 - 3_033_33);
  });

  test("returns null when the recomputed debt was the snapshot's only holding", () => {
    const workspace = makeWorkspace();
    const result = recalculateSnapshotForLiability({
      curve: {
        anchors: [],
        currentBalanceMinor: 0,
        debtModel: "revolving",
      },
      frozenHoldings: [mortgageRow(120_000_00)],
      housingAssetIds: new Set(["asset_piso"]),
      liability: makeMortgage(workspace, 0),
      snapshot: snapshotWithHousingDebt(0, 120_000_00),
      workspace,
    });

    // Balance recomputes to 0 (no anchors → current balance 0) → row drops →
    // nothing left → null.
    expect(result).toBeNull();
  });
});
