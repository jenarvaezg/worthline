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
  globalHoldingValueAtDate,
  recalculateSnapshotForAsset,
  recalculateSnapshotForCoinAcquisition,
  recalculateSnapshotForHousing,
  recalculateSnapshotForLiability,
  recalculateSnapshotForOwnership,
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
import {
  calculateNetWorth,
  captureValuedNetWorthSnapshot,
  createLiability,
  createManualAsset,
  createWorkspace,
  money,
} from "./index";

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

  test("values a no-price investment at cost basis when flagged, not at last-op price (#183)", () => {
    const workspace = makeWorkspace();
    const fund = investment(workspace, "asset_fund", "Fondo");
    // Two buys at differing prices → weighted-avg cost ≠ last-op price (120).
    // op1: 10 @ 100 = 1000.00, op2: 5 @ 120 = 600.00 → cost basis 1600.00 for 15.
    const operationsByAsset = new Map([
      [
        "asset_fund",
        [
          buy("asset_fund", "op1", "2024-01-10", "10", "100"),
          buy("asset_fund", "op2", "2024-03-10", "5", "120"),
        ],
      ],
    ]);

    const result = buildSnapshotAtDate({
      ...BASE,
      assets: [fund],
      // Flagged as a no-price investment → cost basis, not 15 × 120 = 1800.00.
      costBasisAssetIds: new Set(["asset_fund"]),
      liabilities: [],
      manualValueHistory: new Map(),
      operationsByAsset,
      targetDate: "2024-06-01",
      workspace,
    });

    expect(result!.snapshot.grossAssets.amountMinor).toBe(1_600_00);
    const fundRow = result!.holdings.find((h) => h.holdingId === "asset_fund");
    expect(fundRow?.units).toBe("15");
    // Cost-basis fallback freezes NO unit price (ADR 0006).
    expect(fundRow?.unitPrice).toBeUndefined();
  });

  test("a captured price beats the cost-basis flag (ADR-0012 carry-over unchanged)", () => {
    const workspace = makeWorkspace();
    const fund = investment(workspace, "asset_fund", "Fondo");
    const operationsByAsset = new Map([
      ["asset_fund", [buy("asset_fund", "op1", "2024-01-10", "10", "100")]],
    ]);

    const result = buildSnapshotAtDate({
      ...BASE,
      assets: [fund],
      // Both signals present: the real captured price wins (ADR 0012).
      capturedUnitPrices: new Map([["asset_fund", "150"]]),
      costBasisAssetIds: new Set(["asset_fund"]),
      liabilities: [],
      manualValueHistory: new Map(),
      operationsByAsset,
      targetDate: "2024-06-01",
      workspace,
    });

    expect(result!.snapshot.grossAssets.amountMinor).toBe(10 * 150_00);
    expect(result!.holdings[0]?.unitPrice).toBe("150");
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

describe("globalHoldingValueAtDate (#187)", () => {
  test("values an investment by its operation ledger to the date (100%, un-allocated)", () => {
    const workspace = makeWorkspace();
    const fund = investment(workspace, "asset_fund", "Fondo");

    const value = globalHoldingValueAtDate(
      {
        holding: { asset: fund, kind: "asset" },
        operations: [buy("asset_fund", "op1", "2024-01-10", "10", "100")],
      },
      "2024-06-01",
    );

    // 10 units × 100 = 1000.00 EUR — the whole-holding value, no scope weighting.
    expect(value).toBe(1_000_00);
  });

  test("values a housing asset from its curve, never from an allocation-rounded row", () => {
    const workspace = makeWorkspace();
    const piso = housing(workspace, "asset_piso", 300_000_01);

    const value = globalHoldingValueAtDate(
      {
        holding: { asset: piso, kind: "asset" },
        housingCurve: {
          anchors: [
            {
              adjustsPriorCurve: true,
              valuationDate: "2024-01-01",
              valueMinor: 300_000_01,
            },
          ],
          annualAppreciationRate: null,
          currentValueMinor: 300_000_01,
        },
        today: "2024-06-01",
      },
      "2024-06-01",
    );

    // The exact anchored value (odd cents), never a value drifted by re-dividing a
    // rounded household row — the bug this helper fixes (#187).
    expect(value).toBe(300_000_01);
  });

  test("values an amortizable liability from its debt curve, not last-known", () => {
    const workspace = makeWorkspace();
    const hipoteca = createLiability(workspace, {
      balanceMinor: 100_000_00,
      currency: "EUR",
      id: "liab_h",
      name: "Hipoteca",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "mortgage",
    });

    const value = globalHoldingValueAtDate(
      {
        debtCurve: {
          anchors: [],
          currentBalanceMinor: 100_000_00,
          debtModel: "amortizable",
          plan: {
            annualInterestRate: "0.03",
            initialCapitalMinor: 150_000_00,
            disbursementDate: "2020-01-01",
            firstPaymentDate: "2020-02-01",
            termMonths: 240,
          },
          revisions: [],
        },
        holding: { kind: "liability", liability: hipoteca },
      },
      "2022-01-01",
    );

    // The curve balance 2y into a 20y loan is above the 100k last-known balance.
    expect(value).not.toBeNull();
    expect(value!).toBeGreaterThan(100_000_00);
    expect(value!).toBeLessThan(150_000_00);
  });

  test("returns null when the investment was not held on that date (before first op)", () => {
    const workspace = makeWorkspace();
    const fund = investment(workspace, "asset_fund", "Fondo");

    const value = globalHoldingValueAtDate(
      {
        holding: { asset: fund, kind: "asset" },
        operations: [buy("asset_fund", "op1", "2024-05-01", "10", "100")],
      },
      "2024-01-01",
    );

    expect(value).toBeNull();
  });
});

describe("recalculateSnapshotForHousing", () => {
  const eur = (amountMinor: number) => ({ amountMinor, currency: "EUR" });

  function housingRow(valueMinor: number): SnapshotHoldingRow {
    return {
      countsAsHousing: true, // piso is a housing asset
      holdingId: "asset_piso",
      kind: "asset",
      label: "Piso",
      liquidityTier: "illiquid",
      securesHousing: false,
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
      countsAsHousing: false,
      holdingId: "asset_cash",
      kind: "asset",
      label: "Cuenta",
      liquidityTier: "cash",
      securesHousing: false,
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
        // grossAssets = piso 100k + cash 5k = 105k; housingEquity = piso 100k
        // (countsAsHousing); liquidNetWorth = cash 5k. Self-consistent with frozen rows.
        ...snapshotWithHousing(100_000_00),
        grossAssets: eur(105_000_00),
        liquidNetWorth: eur(5_000_00),
        totalNetWorth: eur(105_000_00),
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
      countsAsHousing: false,
      holdingId: "asset_fund",
      kind: "asset",
      label: "Fondo",
      liquidityTier: "market",
      securesHousing: false,
      unitPrice: "100",
      units,
      valueMinor,
    };
  }

  // A snapshot whose figures already reflect a mortgage frozen with a null tier
  // but securesHousing=true (a housing debt) — the exact shape that broke the
  // earlier row-summing recompute. Self-consistent under the five-figure
  // invariant (#181): the debt nets HOUSING equity, never liquid, because its
  // frozen securesHousing says so — not its (null) rung.
  function snapshotWithMortgage(): NetWorthSnapshot {
    return {
      capturedAt: "2024-06-01T12:00:00.000Z",
      dateKey: "2024-06-01",
      debts: eur(500_00),
      grossAssets: eur(1_000_00),
      housingEquity: eur(-500_00), // 0 housing assets − 500 housing-securing debt
      id: "snap_x",
      isMonthlyClose: false,
      liquidNetWorth: eur(1_000_00), // fund (market) is liquid; the housing debt is not
      monthKey: "2024-06",
      scopeId: "member_jose",
      scopeLabel: "Jose",
      totalNetWorth: eur(500_00),
      warnings: [],
    };
  }

  function mortgageRow(): SnapshotHoldingRow {
    return {
      countsAsHousing: false,
      holdingId: "liab_mortgage",
      kind: "liability",
      label: "Hipoteca",
      liquidityTier: null, // null rung (liabilities net against their asset)
      securesHousing: true, // frozen housing debt → nets housing equity, not liquid
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

  // A derived row frozen at cost basis (ADR 0006 fallback) carries units but NO
  // unitPrice — the signal that live capture had no provider/manual price that
  // day. A backdated operation must keep it at cost basis, never recompute it at
  // units × latestOperationPrice (#183).
  function frozenCostBasisRow(valueMinor: number, units: string): SnapshotHoldingRow {
    return {
      countsAsHousing: false,
      holdingId: "asset_fund",
      kind: "asset",
      label: "Fondo",
      liquidityTier: "market",
      securesHousing: false,
      // No unitPrice: captured at cost basis (ADR 0006).
      units,
      valueMinor,
    };
  }

  // A standalone snapshot holding only the cost-basis fund, self-consistent under
  // the five-figure invariant (#181). grossAssets == the cost-basis value.
  function costBasisSnapshot(valueMinor: number): NetWorthSnapshot {
    return {
      capturedAt: "2024-06-01T12:00:00.000Z",
      dateKey: "2024-06-01",
      debts: eur(0),
      grossAssets: eur(valueMinor),
      housingEquity: eur(0),
      id: "snap_cb",
      isMonthlyClose: false,
      liquidNetWorth: eur(valueMinor), // fund is on the market (liquid) rung
      monthKey: "2024-06",
      scopeId: "member_jose",
      scopeLabel: "Jose",
      totalNetWorth: eur(valueMinor),
      warnings: [],
    };
  }

  test("keeps a cost-basis row at cost basis when a backdated operation ripples it (#183)", () => {
    const workspace = makeWorkspace();

    // Frozen at cost basis from op1 (10 @ 100 = 1000.00) + op2 (5 @ 120 = 600.00):
    // weighted-avg cost ≠ last-op price (120), so the bug would be visible.
    // Cost basis = 1600.00 for 15 units; the row carries NO unitPrice.
    const frozen = frozenCostBasisRow(1_600_00, "15");

    // A backdated buy op0 (3 @ 90 on 2024-01-05) within the snapshot's window:
    // the ripple re-folds [op0, op1, op2] → 18 units, cost basis 270 + 1000 + 600
    // = 1870.00. The buggy path would value 18 × latestOperationPrice (120) =
    // 2160.00 — a jump from cost basis to last-op price.
    const result = recalculateSnapshotForAsset({
      asset: fundAsset(workspace),
      frozenHoldings: [frozen],
      operations: [
        buy("asset_fund", "op0", "2024-01-05", "3", "90"),
        buy("asset_fund", "op1", "2024-01-10", "10", "100"),
        buy("asset_fund", "op2", "2024-03-10", "5", "120"),
      ],
      snapshot: costBasisSnapshot(1_600_00),
      workspace,
    })!;

    const rippledRow = result.holdings.find((h) => h.holdingId === "asset_fund");
    // Stays at cost basis (1870.00), not units × last-op price (2160.00).
    expect(result.snapshot.grossAssets.amountMinor).toBe(1_870_00);
    expect(rippledRow?.valueMinor).toBe(1_870_00);
    expect(rippledRow?.units).toBe("18");
    // Still no captured price — the cost-basis signal is preserved.
    expect(rippledRow?.unitPrice).toBeUndefined();
  });

  test("a priced row keeps the ADR-0012 captured-price carry-over on a ripple (unchanged)", () => {
    const workspace = makeWorkspace();

    // A row frozen WITH a captured price (100) must keep ADR-0012 behaviour:
    // the captured price beats the last operation price (120) on recompute.
    const result = recalculateSnapshotForAsset({
      asset: fundAsset(workspace),
      frozenHoldings: [frozenFundRow(1_000_00, "10")],
      operations: [
        buy("asset_fund", "op1", "2024-01-10", "10", "100"),
        buy("asset_fund", "op2", "2024-03-10", "5", "120"),
      ],
      snapshot: costBasisSnapshot(1_000_00),
      workspace,
    })!;

    const rippledRow = result.holdings.find((h) => h.holdingId === "asset_fund");
    // 15 units × captured price 100 = 1500.00 (NOT last-op price 120).
    expect(result.snapshot.grossAssets.amountMinor).toBe(1_500_00);
    expect(rippledRow?.unitPrice).toBe("100");
  });
});

describe("amortizationPaymentDatesUpTo", () => {
  const plan = {
    annualInterestRate: "0.03",
    initialCapitalMinor: 120_000_00,
    disbursementDate: "2024-01-15",
    firstPaymentDate: "2024-02-15",
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
      disbursementDate: "2024-01-31",
      firstPaymentDate: "2024-02-29",
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
      disbursementDate: "2024-01-01",
      firstPaymentDate: "2024-02-01",
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
        disbursementDate: "2020-01-01",
        firstPaymentDate: "2020-02-01",
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

  test("the historical path freezes securesHousing on every row (#180)", () => {
    const workspace = makeWorkspace();
    const piso = housing(workspace, "asset_piso", 200_000_00);
    const hipoteca = mortgage(workspace, "liab_h", 100_000_00);
    // A standalone debt that secures no asset at all.
    const loan = createLiability(workspace, {
      balanceMinor: 5_000_00,
      currency: "EUR",
      id: "liab_loan",
      name: "Préstamo",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "debt",
    });

    const built = buildSnapshotAtDate({
      ...BASE,
      assets: [piso],
      capturedAt: "2022-01-01T12:00:00.000Z",
      liabilities: [hipoteca, loan],
      manualValueHistory: new Map(),
      operationsByAsset: new Map(),
      targetDate: "2022-01-01",
      today: "2026-06-12",
      workspace,
    })!;

    // A debt associated to a housing asset freezes true; an unassociated debt
    // and the housing asset itself freeze false — the same all-assets
    // classification the live capture path uses, mirrored at historical capture.
    expect(built.holdings.find((h) => h.holdingId === "liab_h")?.securesHousing).toBe(
      true,
    );
    expect(built.holdings.find((h) => h.holdingId === "liab_loan")?.securesHousing).toBe(
      false,
    );
    expect(built.holdings.find((h) => h.holdingId === "asset_piso")?.securesHousing).toBe(
      false,
    );
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
      countsAsHousing: true, // piso is a housing asset
      holdingId: "asset_piso",
      kind: "asset",
      label: "Piso",
      liquidityTier: "illiquid",
      securesHousing: false,
      valueMinor,
    };
  }

  // A null-tier frozen mortgage row that nonetheless secures a housing asset:
  // the rung is null (liabilities net against their asset, not by their own
  // rung), but securesHousing is frozen true — the self-classifying signal (#180).
  function mortgageRow(valueMinor: number): SnapshotHoldingRow {
    return {
      countsAsHousing: false,
      holdingId: "liab_h",
      kind: "liability",
      label: "Hipoteca",
      liquidityTier: null,
      securesHousing: true,
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
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
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
      countsAsHousing: false,
      holdingId: "asset_cash",
      kind: "asset",
      label: "Cuenta",
      liquidityTier: "cash",
      securesHousing: false,
      valueMinor: 5_000_00,
    };
    const result = recalculateSnapshotForLiability({
      curve: amortizableCurve,
      frozenHoldings: [pisoRow(200_000_00), mortgageRow(120_000_00), cashRow],
      housingAssetIds: new Set(["asset_piso"]),
      liability: makeMortgage(workspace, 100_000_00),
      snapshot: {
        // grossAssets = piso 200k + cash 5k = 205k; housingEquity = piso 200k − mortgage 120k = 80k
        // (countsAsHousing); liquidNetWorth = cash 5k. Self-consistent with frozen rows.
        ...snapshotWithHousingDebt(200_000_00, 120_000_00),
        grossAssets: eur(205_000_00),
        housingEquity: eur(80_000_00),
        liquidNetWorth: eur(5_000_00),
        totalNetWorth: eur(85_000_00),
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
      countsAsHousing: false,
      holdingId: "liab_card",
      kind: "liability",
      label: "Tarjeta",
      liquidityTier: null,
      securesHousing: false,
      valueMinor: 1_000_00,
    };
    const cashRow: SnapshotHoldingRow = {
      countsAsHousing: false,
      holdingId: "asset_cash",
      kind: "asset",
      label: "Cuenta",
      liquidityTier: "cash",
      securesHousing: false,
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

  test("keeps a zero-balance debt row when the holding still has a scope stake (#181 parity)", () => {
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
    })!;

    // Balance recomputes to 0, but the holding still has a scope stake, so the
    // row is KEPT at value 0 — the same existence rule the capture path applies
    // (share>0 / value==0 rows survive), unified across all four ripples (#181).
    expect(result).not.toBeNull();
    const debtRow = result.holdings.find((h) => h.holdingId === "liab_h")!;
    expect(debtRow.valueMinor).toBe(0);
    expect(debtRow.securesHousing).toBe(true); // frozen signal preserved
    expect(result.snapshot.debts.amountMinor).toBe(0);
    expect(result.snapshot.housingEquity.amountMinor).toBe(0); // 0 assets − 0 debt
    expect(result.snapshot.totalNetWorth.amountMinor).toBe(0);
  });

  test("returns null when the holding has no stake in the scope", () => {
    const household = createWorkspace({
      baseCurrency: "EUR",
      members: [
        { id: "member_jose", name: "Jose" },
        { id: "member_ana", name: "Ana" },
      ],
      mode: "household",
    });
    // The mortgage is wholly Ana's; recomputed in Jose's scope it has no stake →
    // no row → nothing left → null.
    const anaMortgage = createLiability(household, {
      associatedAssetId: "asset_piso",
      balanceMinor: 0,
      currency: "EUR",
      id: "liab_h",
      name: "Hipoteca",
      ownership: [{ memberId: "member_ana", shareBps: 10_000 }],
      type: "mortgage",
    });
    const result = recalculateSnapshotForLiability({
      curve: { anchors: [], currentBalanceMinor: 0, debtModel: "revolving" },
      frozenHoldings: [mortgageRow(120_000_00)],
      housingAssetIds: new Set(["asset_piso"]),
      liability: anaMortgage,
      snapshot: { ...snapshotWithHousingDebt(0, 120_000_00), scopeId: "member_jose" },
      workspace: household,
    });

    expect(result).toBeNull();
  });
});

describe("row-derived ripple axes (#181)", () => {
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

  // A frozen mortgage row that secures the piso — securesHousing frozen TRUE at
  // capture, even if the piso is later reclassified away from housing.
  const frozenMortgageRow = (valueMinor: number): SnapshotHoldingRow => ({
    countsAsHousing: false,
    holdingId: "liab_h",
    kind: "liability",
    label: "Hipoteca",
    liquidityTier: null,
    securesHousing: true,
    valueMinor,
  });
  const pisoRow = (valueMinor: number): SnapshotHoldingRow => ({
    countsAsHousing: true, // piso is a housing asset, frozen at capture
    holdingId: "asset_piso",
    kind: "asset",
    label: "Piso",
    liquidityTier: "illiquid",
    securesHousing: false,
    valueMinor,
  });

  const amortizableCurve: DebtBalanceCurveInputs = {
    anchors: [],
    currentBalanceMinor: 100_000_00,
    debtModel: "amortizable",
    plan: {
      annualInterestRate: "0.03",
      initialCapitalMinor: 150_000_00,
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 240,
    },
    revisions: [],
  };

  test("a debt-curve ripple honours the FROZEN securesHousing, not the live reclassification", () => {
    const workspace = makeWorkspace();
    const snapshot: NetWorthSnapshot = {
      capturedAt: "2022-01-01T12:00:00.000Z",
      dateKey: "2022-01-01",
      debts: eur(120_000_00),
      grossAssets: eur(200_000_00),
      housingEquity: eur(80_000_00), // piso 200k − mortgage 120k (frozen housing debt)
      id: "snap_d",
      isMonthlyClose: false,
      liquidNetWorth: eur(0),
      monthKey: "2022-01",
      scopeId: "member_jose",
      scopeLabel: "Jose",
      totalNetWorth: eur(80_000_00),
      warnings: [],
    };

    // The piso has been reclassified away from housing AFTER capture: the live
    // housingAssetIds no longer contains it. The ripple must NOT re-impute the
    // debt to the liquid axis — the frozen row says it secures housing.
    const result = recalculateSnapshotForLiability({
      curve: amortizableCurve,
      frozenHoldings: [pisoRow(200_000_00), frozenMortgageRow(120_000_00)],
      housingAssetIds: new Set(), // live: piso no longer a housing asset
      liability: makeMortgage(workspace, 100_000_00),
      snapshot,
      workspace,
    })!;

    const balance = result.holdings.find((h) => h.holdingId === "liab_h")!.valueMinor;
    // The recomputed balance still nets HOUSING equity (frozen securesHousing),
    // never the liquid axis — no drift from the live reclassification.
    expect(result.snapshot.housingEquity.amountMinor).toBe(200_000_00 - balance);
    expect(result.snapshot.liquidNetWorth.amountMinor).toBe(0);
    expect(result.snapshot.debts.amountMinor).toBe(balance);
    // The frozen signal is preserved on the recomputed row.
    expect(result.holdings.find((h) => h.holdingId === "liab_h")!.securesHousing).toBe(
      true,
    );
  });

  test("ripple output equals calculateNetWorth over the recomputed rows on all five figures", () => {
    const workspace = makeWorkspace();
    // A portfolio whose frozen rows fully describe the breakdown: a piso (housing),
    // a fund (liquid market), a mortgage on the piso (housing debt), a card (liquid).
    const piso = housing(workspace, "asset_piso", 200_000_00);
    const fund = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "asset_fund",
      liquidityTier: "market",
      name: "Fondo",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "investment",
    });
    const card = createLiability(workspace, {
      balanceMinor: 1_000_00,
      currency: "EUR",
      id: "liab_card",
      name: "Tarjeta",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "debt",
    });

    const fundRow: SnapshotHoldingRow = {
      countsAsHousing: false,
      holdingId: "asset_fund",
      kind: "asset",
      label: "Fondo",
      liquidityTier: "market",
      securesHousing: false,
      valueMinor: 10_000_00,
    };
    const cardRow: SnapshotHoldingRow = {
      countsAsHousing: false,
      holdingId: "liab_card",
      kind: "liability",
      label: "Tarjeta",
      liquidityTier: null,
      securesHousing: false,
      valueMinor: 1_000_00,
    };

    const snapshot: NetWorthSnapshot = {
      capturedAt: "2022-01-01T12:00:00.000Z",
      dateKey: "2022-01-01",
      debts: eur(121_000_00),
      grossAssets: eur(210_000_00),
      housingEquity: eur(80_000_00),
      id: "snap_p",
      isMonthlyClose: false,
      liquidNetWorth: eur(9_000_00), // fund 10k − card 1k
      monthKey: "2022-01",
      scopeId: "member_jose",
      scopeLabel: "Jose",
      totalNetWorth: eur(89_000_00),
      warnings: [],
    };

    const result = recalculateSnapshotForLiability({
      curve: amortizableCurve,
      frozenHoldings: [
        pisoRow(200_000_00),
        fundRow,
        frozenMortgageRow(120_000_00),
        cardRow,
      ],
      housingAssetIds: new Set(["asset_piso"]),
      liability: makeMortgage(workspace, 100_000_00),
      snapshot,
      workspace,
    })!;

    // Reconstruct the live holdings FROM the recomputed rows, then compare the
    // ripple's five figures against calculateNetWorth over those same holdings.
    const balance = result.holdings.find((h) => h.holdingId === "liab_h")!.valueMinor;
    const recomputedMortgage = makeMortgage(workspace, balance);
    const reference = calculateNetWorth({
      assets: [
        { ...piso, currentValue: money(200_000_00, "EUR") },
        { ...fund, currentValue: money(10_000_00, "EUR") },
      ],
      liabilities: [
        recomputedMortgage,
        { ...card, currentBalance: money(1_000_00, "EUR") },
      ],
      scopeId: "member_jose",
      workspace,
    });

    expect(result.snapshot.grossAssets.amountMinor).toBe(
      reference.grossAssets.amountMinor,
    );
    expect(result.snapshot.debts.amountMinor).toBe(reference.debts.amountMinor);
    expect(result.snapshot.totalNetWorth.amountMinor).toBe(
      reference.totalNetWorth.amountMinor,
    );
    expect(result.snapshot.liquidNetWorth.amountMinor).toBe(
      reference.liquidNetWorth.amountMinor,
    );
    expect(result.snapshot.housingEquity.amountMinor).toBe(
      reference.housingEquity.amountMinor,
    );
  });

  test("an asset-ownership ripple on a housing asset re-derives housing equity from rows", () => {
    const household = createWorkspace({
      baseCurrency: "EUR",
      members: [
        { id: "mJ", name: "Jose" },
        { id: "mA", name: "Ana" },
      ],
      mode: "household",
    });
    // Jose's scope froze 50% of a 200k piso = 100k; the split is corrected to 70/30.
    const piso = createManualAsset(household, {
      currency: "EUR",
      currentValueMinor: 200_000_00,
      id: "asset_piso",
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: [
        { memberId: "mJ", shareBps: 7_000 },
        { memberId: "mA", shareBps: 3_000 },
      ],
      type: "real_estate",
    });
    const frozenPiso: SnapshotHoldingRow = {
      countsAsHousing: true, // piso is a housing asset, frozen at capture
      holdingId: "asset_piso",
      kind: "asset",
      label: "Piso",
      liquidityTier: "illiquid",
      securesHousing: false,
      valueMinor: 100_000_00,
    };

    const result = recalculateSnapshotForOwnership({
      frozenHoldings: [frozenPiso],
      globalValueMinor: 200_000_00,
      holding: { asset: piso, kind: "asset" },
      snapshot: {
        capturedAt: "2022-01-01T12:00:00.000Z",
        dateKey: "2022-01-01",
        debts: eur(0),
        grossAssets: eur(100_000_00),
        housingEquity: eur(100_000_00),
        id: "snap_o",
        isMonthlyClose: false,
        liquidNetWorth: eur(0),
        monthKey: "2022-01",
        scopeId: "mJ",
        scopeLabel: "Jose",
        totalNetWorth: eur(100_000_00),
        warnings: [],
      },
      workspace: household,
    })!;

    // Re-weighted to 70% of 200k = 140k; housing equity follows gross (no debt).
    expect(result.holdings.find((h) => h.holdingId === "asset_piso")!.valueMinor).toBe(
      140_000_00,
    );
    expect(result.snapshot.grossAssets.amountMinor).toBe(140_000_00);
    expect(result.snapshot.housingEquity.amountMinor).toBe(140_000_00);
    expect(result.snapshot.liquidNetWorth.amountMinor).toBe(0);
    expect(result.snapshot.totalNetWorth.amountMinor).toBe(140_000_00);
  });

  test("a wrong-axis snapshot fed to a ripple is rejected by the extended reconcile", () => {
    const workspace = makeWorkspace();
    // A snapshot whose frozen housingEquity wrongly imputes a non-housing card to
    // the housing axis (securesHousing=false on the card). Re-deriving from rows
    // exposes the contradiction: the helper's reconcile throws.
    const cardRow: SnapshotHoldingRow = {
      countsAsHousing: false,
      holdingId: "liab_card",
      kind: "liability",
      label: "Tarjeta",
      liquidityTier: null,
      securesHousing: false,
      valueMinor: 1_000_00,
    };
    const fundRow: SnapshotHoldingRow = {
      countsAsHousing: false,
      holdingId: "asset_fund",
      kind: "asset",
      label: "Fondo",
      liquidityTier: "market",
      securesHousing: false,
      valueMinor: 10_000_00,
    };
    // housingEquity claims −1000 (card netted against housing) — impossible given
    // the card's frozen securesHousing=false. liquid wrongly excludes the card.
    const corrupt: NetWorthSnapshot = {
      capturedAt: "2024-02-01T12:00:00.000Z",
      dateKey: "2024-02-01",
      debts: eur(1_000_00),
      grossAssets: eur(10_000_00),
      housingEquity: eur(-1_000_00),
      id: "snap_w",
      isMonthlyClose: false,
      liquidNetWorth: eur(10_000_00),
      monthKey: "2024-02",
      scopeId: "member_jose",
      scopeLabel: "Jose",
      totalNetWorth: eur(9_000_00),
      warnings: [],
    };
    const card = createLiability(workspace, {
      balanceMinor: 1_000_00,
      currency: "EUR",
      id: "liab_card",
      name: "Tarjeta",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "debt",
    });

    // A no-op ownership re-weight (split unchanged) still re-derives the figures
    // from rows and must reject the contradictory frozen housingEquity.
    expect(() =>
      recalculateSnapshotForOwnership({
        frozenHoldings: [fundRow, cardRow],
        globalValueMinor: 1_000_00,
        holding: { housingAssetIds: new Set(), kind: "liability", liability: card },
        snapshot: corrupt,
        workspace,
      }),
    ).toThrow(/housing equity|liquid net worth/i);
  });

  test("an ownership ripple on a reclassified housing asset honours the FROZEN countsAsHousing flag", () => {
    // Regression for the defect the adversarial review found: the asset was a housing
    // asset at capture (countsAsHousing=true frozen on the row). Between capture and
    // the ripple it was reclassified to a non-housing type. The live isHousingAsset
    // returns false → housingAssetDeltaMinor=0 → historical housingEquity stays stuck
    // while gross moved. After the fix the frozen flag drives the delta, not live identity.
    const household = createWorkspace({
      baseCurrency: "EUR",
      members: [
        { id: "mJ", name: "Jose" },
        { id: "mA", name: "Ana" },
      ],
      mode: "household",
    });
    // At capture: piso is housing. Jose owned 50% → 100k. We freeze countsAsHousing=true.
    const frozenPisoRow: SnapshotHoldingRow = {
      countsAsHousing: true, // frozen: it WAS housing at capture
      holdingId: "asset_piso",
      kind: "asset",
      label: "Piso",
      liquidityTier: "illiquid",
      securesHousing: false,
      valueMinor: 100_000_00,
    };
    // After capture, the piso is reclassified to type "manual" (non-housing). The
    // live asset no longer satisfies isHousingAsset — but the frozen row says true.
    const reclassifiedPiso = createManualAsset(household, {
      currency: "EUR",
      currentValueMinor: 200_000_00,
      id: "asset_piso",
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: [
        { memberId: "mJ", shareBps: 7_000 },
        { memberId: "mA", shareBps: 3_000 },
      ],
      type: "manual", // reclassified — isHousingAsset returns false now
    });
    const snapBefore: NetWorthSnapshot = {
      capturedAt: "2022-01-01T12:00:00.000Z",
      dateKey: "2022-01-01",
      debts: eur(0),
      grossAssets: eur(100_000_00),
      housingEquity: eur(100_000_00), // piso was housing at capture
      id: "snap_r",
      isMonthlyClose: false,
      liquidNetWorth: eur(0),
      monthKey: "2022-01",
      scopeId: "mJ",
      scopeLabel: "Jose",
      totalNetWorth: eur(100_000_00),
      warnings: [],
    };

    // An ownership re-weight fires the ownership ripple: Jose's split changes to 70%.
    // global value = 200k; Jose's new row = 140k. Housing delta = 140k − 100k = +40k.
    const result = recalculateSnapshotForOwnership({
      frozenHoldings: [frozenPisoRow],
      globalValueMinor: 200_000_00,
      holding: { asset: reclassifiedPiso, kind: "asset" },
      snapshot: snapBefore,
      workspace: household,
    })!;

    // The row value is re-weighted correctly.
    expect(result.holdings[0]!.valueMinor).toBe(140_000_00);
    // With frozen countsAsHousing=true the delta (+40k) hits the HOUSING axis.
    // housingEquity = 100k (before) + 40k (delta) = 140k. liquidNetWorth stays 0.
    expect(result.snapshot.grossAssets.amountMinor).toBe(140_000_00);
    expect(result.snapshot.housingEquity.amountMinor).toBe(140_000_00);
    expect(result.snapshot.liquidNetWorth.amountMinor).toBe(0);
    expect(result.snapshot.totalNetWorth.amountMinor).toBe(140_000_00);
    // The frozen flag is preserved on the output row.
    expect(result.holdings[0]!.countsAsHousing).toBe(true);
  });

  test("inverse: an ownership ripple on a reclassified NON-housing asset honours frozen countsAsHousing=false", () => {
    // Inverse: an asset was NOT housing at capture (countsAsHousing=false) but was
    // reclassified to housing afterwards. The ripple must NOT impute the delta to
    // the housing axis — frozen=false means it goes to gross+total only (illiquid).
    const workspace = makeWorkspace();
    const frozenNonHousingRow: SnapshotHoldingRow = {
      countsAsHousing: false, // frozen: was NOT housing at capture
      holdingId: "asset_garage",
      kind: "asset",
      label: "Garage",
      liquidityTier: "illiquid",
      securesHousing: false,
      valueMinor: 50_000_00,
    };
    // After capture, garage reclassified to real_estate (now isHousingAsset=true live).
    const nowHousingGarage = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 80_000_00,
      id: "asset_garage",
      liquidityTier: "illiquid",
      name: "Garage",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "real_estate", // live: isHousingAsset returns true
    });
    const snapBefore: NetWorthSnapshot = {
      capturedAt: "2022-01-01T12:00:00.000Z",
      dateKey: "2022-01-01",
      debts: eur(0),
      grossAssets: eur(50_000_00),
      housingEquity: eur(0), // was NOT housing at capture
      id: "snap_g",
      isMonthlyClose: false,
      liquidNetWorth: eur(0),
      monthKey: "2022-01",
      scopeId: "member_jose",
      scopeLabel: "Jose",
      totalNetWorth: eur(50_000_00),
      warnings: [],
    };

    // Ownership re-weight is a no-op (individual scope, same member). Global = 80k.
    const result = recalculateSnapshotForOwnership({
      frozenHoldings: [frozenNonHousingRow],
      globalValueMinor: 80_000_00,
      holding: { asset: nowHousingGarage, kind: "asset" },
      snapshot: snapBefore,
      workspace,
    })!;

    expect(result.holdings[0]!.valueMinor).toBe(80_000_00);
    // Frozen countsAsHousing=false → delta goes to gross+total only, not housing.
    // housingEquity stays 0 (was 0, delta=0 on housing axis).
    expect(result.snapshot.grossAssets.amountMinor).toBe(80_000_00);
    expect(result.snapshot.housingEquity.amountMinor).toBe(0);
    expect(result.snapshot.liquidNetWorth.amountMinor).toBe(0);
    expect(result.snapshot.totalNetWorth.amountMinor).toBe(80_000_00);
    expect(result.holdings[0]!.countsAsHousing).toBe(false);
  });

  test("capture and every ripple path produce the same row set for the same date (#181 parity)", () => {
    const workspace = makeWorkspace();
    // Capture a portfolio: a housing piso, a market fund, a mortgage on the piso,
    // and a standalone card. The capture defines the canonical row set.
    const piso = housing(workspace, "asset_piso", 200_000_00);
    const fund = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "asset_fund",
      liquidityTier: "market",
      name: "Fondo",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "investment",
    });
    const mortgage = createLiability(workspace, {
      associatedAssetId: "asset_piso",
      balanceMinor: 120_000_00,
      currency: "EUR",
      id: "liab_h",
      name: "Hipoteca",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "mortgage",
    });
    const card = createLiability(workspace, {
      balanceMinor: 0, // a zero-balance debt with a scope stake — the parity edge case
      currency: "EUR",
      id: "liab_card",
      name: "Tarjeta",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "debt",
    });

    const captured = captureValuedNetWorthSnapshot({
      assets: [piso, fund],
      capturedAt: "2024-06-01T12:00:00.000Z",
      id: "snap_cap",
      liabilities: [mortgage, card],
      scopeId: "member_jose",
      scopeLabel: "Jose",
      workspace,
    });
    const canonicalIds = captured.holdings.map((h) => `${h.kind}:${h.holdingId}`).sort();

    const rowSet = (v: { holdings: SnapshotHoldingRow[] } | null) =>
      v!.holdings.map((h) => `${h.kind}:${h.holdingId}`).sort();

    // Re-running the card's liability ripple (a no-op curve at balance 0) keeps
    // the zero-value card row — the same row set the capture produced.
    const liabilityRippled = recalculateSnapshotForLiability({
      curve: { anchors: [], currentBalanceMinor: 0, debtModel: "revolving" },
      frozenHoldings: captured.holdings,
      housingAssetIds: new Set(["asset_piso"]),
      liability: card,
      snapshot: captured.snapshot,
      workspace,
    });
    expect(rowSet(liabilityRippled)).toEqual(canonicalIds);

    // The fund's operation ripple (re-buying the same units at the same price).
    const assetRippled = recalculateSnapshotForAsset({
      asset: fund,
      frozenHoldings: captured.holdings,
      operations: [buy("asset_fund", "op1", "2024-01-10", "100", "100")],
      snapshot: captured.snapshot,
      workspace,
    });
    expect(rowSet(assetRippled)).toEqual(canonicalIds);

    // The card's ownership ripple (split unchanged) keeps the zero-value row too.
    const ownershipRippled = recalculateSnapshotForOwnership({
      frozenHoldings: captured.holdings,
      globalValueMinor: 0,
      holding: {
        housingAssetIds: new Set(["asset_piso"]),
        kind: "liability",
        liability: card,
      },
      snapshot: captured.snapshot,
      workspace,
    });
    expect(rowSet(ownershipRippled)).toEqual(canonicalIds);
  });
});

describe("recalculateSnapshotForOwnership (#172)", () => {
  const eur = (amountMinor: number) => ({ amountMinor, currency: "EUR" });

  function household(): Workspace {
    return createWorkspace({
      baseCurrency: "EUR",
      members: [
        { id: "mJ", name: "Jose" },
        { id: "mA", name: "Ana" },
      ],
      mode: "household",
    });
  }

  function mortgage(
    workspace: Workspace,
    ownership: { memberId: string; shareBps: number }[],
  ): Liability {
    return createLiability(workspace, {
      associatedAssetId: "asset_piso",
      balanceMinor: 100_000_00,
      currency: "EUR",
      id: "liab_h",
      name: "Hipoteca",
      ownership,
      type: "mortgage",
    });
  }

  const pisoRow = (valueMinor: number): SnapshotHoldingRow => ({
    countsAsHousing: true, // piso is a housing asset, frozen at capture
    holdingId: "asset_piso",
    kind: "asset",
    label: "Piso",
    liquidityTier: "illiquid",
    securesHousing: false,
    valueMinor,
  });
  const mortgageRow = (valueMinor: number): SnapshotHoldingRow => ({
    countsAsHousing: false,
    holdingId: "liab_h",
    kind: "liability",
    label: "Hipoteca",
    liquidityTier: null,
    securesHousing: true, // secures asset_piso (a housing asset) — frozen true (#180)
    valueMinor,
  });

  function snapshot(
    scopeId: string,
    pisoMinor: number,
    debtMinor: number,
  ): NetWorthSnapshot {
    return {
      capturedAt: "2022-01-01T12:00:00.000Z",
      dateKey: "2022-01-01",
      debts: eur(debtMinor),
      grossAssets: eur(pisoMinor),
      housingEquity: eur(pisoMinor - debtMinor),
      id: `snap_${scopeId}`,
      isMonthlyClose: false,
      liquidNetWorth: eur(0),
      monthKey: "2022-01",
      scopeId,
      scopeLabel: scopeId,
      totalNetWorth: eur(pisoMinor - debtMinor),
      warnings: [],
    };
  }

  test("re-weights a member-scope liability row by the new split, preserving reconciliation", () => {
    const workspace = household();
    // Jose's scope froze 50% of each: piso 100k, mortgage 50k (global piso 200k,
    // global mortgage 100k). The mortgage's split is corrected to 70/30.
    const result = recalculateSnapshotForOwnership({
      frozenHoldings: [pisoRow(100_000_00), mortgageRow(50_000_00)],
      globalValueMinor: 100_000_00,
      holding: {
        housingAssetIds: new Set(["asset_piso"]),
        kind: "liability",
        liability: mortgage(workspace, [
          { memberId: "mJ", shareBps: 7_000 },
          { memberId: "mA", shareBps: 3_000 },
        ]),
      },
      snapshot: snapshot("mJ", 100_000_00, 50_000_00),
      workspace,
    })!;

    const debtRow = result.holdings.find((h) => h.holdingId === "liab_h")!;
    expect(debtRow.valueMinor).toBe(70_000_00); // 70% of the 100k global balance
    expect(result.snapshot.debts.amountMinor).toBe(70_000_00);
    // Mortgage secures the piso → housing equity moves opposite to debt; gross unchanged.
    expect(result.snapshot.grossAssets.amountMinor).toBe(100_000_00);
    expect(result.snapshot.housingEquity.amountMinor).toBe(100_000_00 - 70_000_00);
    expect(result.snapshot.totalNetWorth.amountMinor).toBe(100_000_00 - 70_000_00);
    // Reconciliation: liability rows sum to debts; the piso row is untouched.
    expect(
      result.holdings
        .filter((h) => h.kind === "liability")
        .reduce((s, h) => s + h.valueMinor, 0),
    ).toBe(70_000_00);
    expect(result.holdings.find((h) => h.holdingId === "asset_piso")!.valueMinor).toBe(
      100_000_00,
    );
  });

  test("the household scope is a no-op — the split always sums to 100% there", () => {
    const workspace = household();
    const result = recalculateSnapshotForOwnership({
      frozenHoldings: [pisoRow(200_000_00), mortgageRow(100_000_00)],
      globalValueMinor: 100_000_00,
      holding: {
        housingAssetIds: new Set(["asset_piso"]),
        kind: "liability",
        liability: mortgage(workspace, [
          { memberId: "mJ", shareBps: 7_000 },
          { memberId: "mA", shareBps: 3_000 },
        ]),
      },
      snapshot: snapshot("household", 200_000_00, 100_000_00),
      workspace,
    })!;
    // Household sees the full balance regardless of how the split is cut.
    expect(result.holdings.find((h) => h.holdingId === "liab_h")!.valueMinor).toBe(
      100_000_00,
    );
    expect(result.snapshot.debts.amountMinor).toBe(100_000_00);
    expect(result.snapshot.housingEquity.amountMinor).toBe(100_000_00);
  });

  test("re-weights a member-scope cash asset row and moves gross + liquid net worth", () => {
    const workspace = household();
    const account = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [
        { memberId: "mJ", shareBps: 6_000 },
        { memberId: "mA", shareBps: 4_000 },
      ],
      type: "cash",
    });
    // Ana's scope froze 50% = 5_000_00; the split is corrected to 60/40.
    const cashRow: SnapshotHoldingRow = {
      countsAsHousing: false,
      holdingId: "asset_cash",
      kind: "asset",
      label: "Cuenta",
      liquidityTier: "cash",
      securesHousing: false,
      valueMinor: 5_000_00,
    };
    const result = recalculateSnapshotForOwnership({
      frozenHoldings: [cashRow],
      globalValueMinor: 10_000_00,
      holding: { asset: account, kind: "asset" },
      snapshot: {
        capturedAt: "2022-01-01T12:00:00.000Z",
        dateKey: "2022-01-01",
        debts: eur(0),
        grossAssets: eur(5_000_00),
        housingEquity: eur(0),
        id: "snap_mA",
        isMonthlyClose: false,
        liquidNetWorth: eur(5_000_00),
        monthKey: "2022-01",
        scopeId: "mA",
        scopeLabel: "Ana",
        totalNetWorth: eur(5_000_00),
        warnings: [],
      },
      workspace,
    })!;
    const row = result.holdings.find((h) => h.holdingId === "asset_cash")!;
    expect(row.valueMinor).toBe(4_000_00); // 40% of the 10k global value
    expect(result.snapshot.grossAssets.amountMinor).toBe(4_000_00);
    expect(result.snapshot.liquidNetWorth.amountMinor).toBe(4_000_00);
    expect(result.snapshot.totalNetWorth.amountMinor).toBe(4_000_00);
    expect(result.snapshot.housingEquity.amountMinor).toBe(0);
  });
});

describe("recalculateSnapshotForCoinAcquisition", () => {
  const eur = (amountMinor: number) => ({ amountMinor, currency: "EUR" });

  // The materialized coin-collection holding a Numista source projects into: a
  // manual, illiquid asset valued from its positions (ADR 0016/0017).
  function coinCollection(workspace: Workspace): ManualAsset {
    return createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 0,
      id: "asset_coins",
      instrument: "coin_collection",
      liquidityTier: "illiquid",
      name: "Colección Numista",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "manual",
    });
  }

  function cashRow(valueMinor: number): SnapshotHoldingRow {
    return {
      countsAsHousing: false,
      holdingId: "asset_cash",
      kind: "asset",
      label: "Cuenta",
      liquidityTier: "cash",
      securesHousing: false,
      valueMinor,
    };
  }

  // A snapshot holding only cash, self-consistent under the five-figure
  // invariant (#181): one liquid asset, no debts, no housing.
  function cashSnapshot(valueMinor: number): NetWorthSnapshot {
    return {
      capturedAt: "2024-06-01T12:00:00.000Z",
      dateKey: "2024-06-01",
      debts: eur(0),
      grossAssets: eur(valueMinor),
      housingEquity: eur(0),
      id: "snap_x",
      isMonthlyClose: false,
      liquidNetWorth: eur(valueMinor),
      monthKey: "2024-06",
      scopeId: "member_jose",
      scopeLabel: "Jose",
      totalNetWorth: eur(valueMinor),
      warnings: [],
    };
  }

  test("adds a newly-acquired coin's value as a fresh illiquid coin-collection row", () => {
    const workspace = makeWorkspace();
    const result = recalculateSnapshotForCoinAcquisition({
      asset: coinCollection(workspace),
      frozenHoldings: [cashRow(1_000_00)],
      globalDeltaMinor: 300_00, // a coin worth 300, frozen at ripple time
      snapshot: cashSnapshot(1_000_00),
      workspace,
    })!;

    const coinRow = result.holdings.find((h) => h.holdingId === "asset_coins")!;
    expect(coinRow.valueMinor).toBe(300_00);
    expect(coinRow.liquidityTier).toBe("illiquid");
    // Gross + total grow by the coin value; the coin is illiquid, not housing, so
    // liquid net worth and housing equity stay exactly where they were frozen.
    expect(result.snapshot.grossAssets.amountMinor).toBe(1_300_00);
    expect(result.snapshot.totalNetWorth.amountMinor).toBe(1_300_00);
    expect(result.snapshot.liquidNetWorth.amountMinor).toBe(1_000_00);
    expect(result.snapshot.housingEquity.amountMinor).toBe(0);
  });

  test("adds onto an existing coin-collection row without recomputing it", () => {
    const workspace = makeWorkspace();
    const coinRow: SnapshotHoldingRow = {
      countsAsHousing: false,
      holdingId: "asset_coins",
      kind: "asset",
      label: "Colección Numista",
      liquidityTier: "illiquid",
      securesHousing: false,
      valueMinor: 200_00, // a coin already frozen into this snapshot
    };
    const result = recalculateSnapshotForCoinAcquisition({
      asset: coinCollection(workspace),
      frozenHoldings: [cashRow(1_000_00), coinRow],
      globalDeltaMinor: 300_00, // a second coin acquired on/before this date
      snapshot: {
        ...cashSnapshot(1_000_00),
        grossAssets: eur(1_200_00),
        totalNetWorth: eur(1_200_00),
      },
      workspace,
    })!;

    // The already-frozen 200 stays put and the new 300 is added on top — never a
    // recompute from current prices.
    const row = result.holdings.find((h) => h.holdingId === "asset_coins")!;
    expect(row.valueMinor).toBe(500_00);
    expect(result.snapshot.grossAssets.amountMinor).toBe(1_500_00);
    expect(result.snapshot.liquidNetWorth.amountMinor).toBe(1_000_00);
  });
});
