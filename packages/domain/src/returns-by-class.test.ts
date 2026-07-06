import { describe, expect, test } from "vitest";

import type { AssetClassResolution } from "./exposure-lookthrough";
import type { InvestmentOperation, OperationKind } from "./investment-types";
import type { MonthlyCloseValue } from "./returns";
import { portfolioIrr, portfolioSimpleGain } from "./returns";
import { UNCLASSIFIED_ASSET_CLASS_KEY, returnsByAssetClass } from "./returns-by-class";

function op(
  kind: OperationKind,
  units: string,
  pricePerUnit: string,
  executedAt: string,
  extra: Partial<InvestmentOperation> = {},
): InvestmentOperation {
  return {
    assetId: "asset_inv",
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id: `op_${kind}_${executedAt}_${units}`,
    kind,
    pricePerUnit,
    units,
    ...extra,
  };
}

const buy = (units: string, price: string, at: string) => op("buy", units, price, at);

const classified = (breakdown: Record<string, string>): AssetClassResolution => ({
  breakdown,
  kind: "classified",
});
const unknown: AssetClassResolution = { kind: "unknown" };

describe("returnsByAssetClass", () => {
  test("a single holding fully in one class reports that class alone, matching the portfolio measures", () => {
    const operations = [buy("10", "100", "2023-01-01")];
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 130_000,
          monthlyCloses: [],
          operations,
        },
      ],
      valuationDate: "2024-01-01",
    });

    expect(result.classes).toHaveLength(1);
    const equity = result.classes[0]!;
    expect(equity.key).toBe("equity");
    expect(equity.value).toEqual({ amountMinor: 130_000, currency: "EUR" });

    // Reconciles with the portfolio engine over the same holding.
    const portfolio = { currency: "EUR" as const, valuationDate: "2024-01-01" };
    expect(equity.simpleGain.totalGain).toEqual(
      portfolioSimpleGain({
        ...portfolio,
        holdings: [{ marketValueMinor: 130_000, operations }],
      }).totalGain,
    );
    expect(equity.irr.rate).toBeCloseTo(
      portfolioIrr({
        ...portfolio,
        holdings: [{ marketValueMinor: 130_000, operations }],
      }).rate!,
      6,
    );
    expect(result.coverage.unknown.amountMinor).toBe(0);
    expect(result.coverage.classified.amountMinor).toBe(130_000);
  });

  test("a 60/40 fund splits its value, cost and flows fractionally across the two classes", () => {
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ bond: "0.4", equity: "0.6" }),
          marketValueMinor: 100_000,
          monthlyCloses: [],
          operations: [buy("10", "100", "2024-01-01")], // invested 100_000
        },
      ],
      valuationDate: "2024-06-01",
    });

    const equity = result.classes.find((c) => c.key === "equity")!;
    const bond = result.classes.find((c) => c.key === "bond")!;
    expect(equity.value.amountMinor).toBe(60_000);
    expect(bond.value.amountMinor).toBe(40_000);
    expect(equity.simpleGain.totalInvestedMinor).toBe(60_000);
    expect(bond.simpleGain.totalInvestedMinor).toBe(40_000);
    // Both slices are break-even (value == cost), so ratio is 0 for each.
    expect(equity.simpleGain.totalReturnRatio).toBe(0);
    expect(bond.simpleGain.totalReturnRatio).toBe(0);
    // Attribution is exhaustive: the class values sum back to the holding value.
    expect(equity.value.amountMinor + bond.value.amountMinor).toBe(100_000);
  });

  test("a breakdown declaring under 100% sends the remainder to `other`", () => {
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ equity: "0.7" }),
          marketValueMinor: 100_000,
          monthlyCloses: [],
          operations: [buy("1", "1000", "2024-01-01")],
        },
      ],
      valuationDate: "2024-06-01",
    });

    expect(result.classes.map((c) => c.key).sort()).toEqual(["equity", "other"]);
    expect(result.classes.find((c) => c.key === "equity")!.value.amountMinor).toBe(
      70_000,
    );
    expect(result.classes.find((c) => c.key === "other")!.value.amountMinor).toBe(30_000);
    // `other` is a declared remainder, not a coverage gap.
    expect(result.coverage.unknown.amountMinor).toBe(0);
    expect(result.coverage.classified.amountMinor).toBe(100_000);
  });

  test("a holding with no resolvable class falls whole into `unclassified` and counts as unknown coverage", () => {
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 60_000,
          monthlyCloses: [],
          operations: [buy("1", "500", "2024-01-01")],
        },
        {
          assetClass: unknown,
          marketValueMinor: 40_000,
          monthlyCloses: [],
          operations: [buy("1", "300", "2024-01-01")],
        },
      ],
      valuationDate: "2024-06-01",
    });

    const unclassified = result.classes.find(
      (c) => c.key === UNCLASSIFIED_ASSET_CLASS_KEY,
    )!;
    expect(unclassified.value.amountMinor).toBe(40_000);
    expect(unclassified.simpleGain.totalInvestedMinor).toBe(30_000);
    expect(result.coverage.classified.amountMinor).toBe(60_000);
    expect(result.coverage.unknown.amountMinor).toBe(40_000);
  });

  test("classes are sorted by attributed value descending, then key", () => {
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ bond: "0.3", equity: "0.7" }),
          marketValueMinor: 100_000,
          monthlyCloses: [],
          operations: [buy("1", "1000", "2024-01-01")],
        },
      ],
      valuationDate: "2024-06-01",
    });

    expect(result.classes.map((c) => c.key)).toEqual(["equity", "bond"]);
  });

  test("ownershipBps scales only the operation cashflows, so a co-owned holding's slice is coherent with its scoped value", () => {
    // 50%-owned: caller passes the scoped value (50k of a 100k gross holding) and
    // ownershipBps=5000. Operations (gross 100k invested) must be scaled to 50k so
    // simple gain reads break-even, not a fabricated −50%.
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 50_000, // scoped ownedMinor
          monthlyCloses: [],
          operations: [buy("10", "100", "2024-01-01")], // gross invested 100_000
          ownershipBps: 5_000,
        },
      ],
      valuationDate: "2024-06-01",
    });

    const equity = result.classes.find((c) => c.key === "equity")!;
    expect(equity.simpleGain.totalInvestedMinor).toBe(50_000);
    expect(equity.simpleGain.totalGain.amountMinor).toBe(0);
    expect(equity.simpleGain.totalReturnRatio).toBe(0);
  });

  test("per-class TWR chains the class-weighted monthly closes with no cashflows", () => {
    const monthlyCloses: MonthlyCloseValue[] = [
      { date: "2023-01-31", valueMinor: 100_000 },
      { date: "2023-12-31", valueMinor: 110_000 },
    ];
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          // fully equity, but only 50% of its value is measured on the equity slice
          assetClass: classified({ equity: "0.5" }),
          marketValueMinor: 110_000,
          monthlyCloses,
          operations: [buy("1", "1000", "2023-01-15")],
        },
      ],
      valuationDate: "2024-01-15",
    });

    const equity = result.classes.find((c) => c.key === "equity")!;
    // Scaling every close by the same weight leaves the pure price move unchanged:
    // (55_000 − 50_000) / 50_000 = +10%.
    expect(equity.twr.reason).toBeNull();
    expect(equity.twr.rate).toBeCloseTo(0.1, 6);
  });

  test("a payout folds into the class simple gain, reconciling with the portfolio", () => {
    const operations = [buy("10", "100", "2023-01-01")]; // invested 100_000
    const payouts = [{ amountMinor: 50_000, date: "2023-06-01" }];
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 100_000, // flat: value == cost
          monthlyCloses: [],
          operations,
          payouts,
        },
      ],
      valuationDate: "2024-01-01",
    });

    const equity = result.classes.find((c) => c.key === "equity")!;
    // Flat holding: the whole gain is the recorded distribution.
    expect(equity.simpleGain.totalGain.amountMinor).toBe(50_000);
    expect(equity.simpleGain).toEqual(
      portfolioSimpleGain({
        currency: "EUR",
        holdings: [{ marketValueMinor: 100_000, operations, payouts }],
        valuationDate: "2024-01-01",
      }),
    );
  });

  test("a payout is scaled by ownership then class weight", () => {
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ bond: "0.4", equity: "0.6" }),
          marketValueMinor: 50_000, // owned slice, flat
          monthlyCloses: [],
          operations: [buy("10", "100", "2024-01-01")], // gross invested 100_000
          ownershipBps: 5_000, // owner holds half
          payouts: [{ amountMinor: 100_000, date: "2024-06-01" }],
        },
      ],
      valuationDate: "2024-12-01",
    });

    // 100_000 × 50% ownership × 60% equity = 30_000 attributed to equity.
    const equity = result.classes.find((c) => c.key === "equity")!;
    expect(equity.simpleGain.totalGain.amountMinor).toBe(30_000);
    // 100_000 × 50% × 40% bond = 20_000.
    const bond = result.classes.find((c) => c.key === "bond")!;
    expect(bond.simpleGain.totalGain.amountMinor).toBe(20_000);
  });
});
