import { describe, expect, test } from "vitest";

import type { InvestmentOperation, OperationKind } from "./index";
import { money } from "./money";
import type { IrrResult, SimpleGain, TwrResult } from "./returns";
import {
  APPRECIATING_CAVEAT,
  MARKET_CAVEAT,
  buildHoldingReturnsView,
  buildPortfolioReturnsView,
  CLASS_ATTRIBUTION_CAVEAT,
  investmentReturnsById,
  portfolioReturnsView,
  returnsByAssetClassView,
  returnsKindForInstrument,
} from "./returns-display";

function gain(overrides: Partial<SimpleGain> = {}): SimpleGain {
  return {
    annualized: true,
    cagr: 0.1,
    spanDays: 800,
    totalGain: money(5_039_00, "EUR"),
    totalInvestedMinor: 16_850_00,
    totalReturnRatio: 0.299,
    ...overrides,
  };
}

const okIrr: IrrResult = { rate: 0.082, reason: null };
const failedIrr: IrrResult = { rate: null, reason: "single_sign" };
const okTwr: TwrResult = {
  annualized: false,
  annualizedRate: null,
  endDate: "2024-03-31",
  rate: 0.071,
  reason: null,
  spanDays: 60,
  startDate: "2024-01-31",
};

function op(
  kind: OperationKind,
  units: string,
  pricePerUnit: string,
  executedAt: string,
  assetId = "asset_inv",
): InvestmentOperation {
  return {
    assetId,
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id: `op_${assetId}_${kind}_${executedAt}`,
    kind,
    pricePerUnit,
    units,
  };
}

describe("returnsKindForInstrument", () => {
  test("market instruments (fund/etf/stock/index/pension_plan/crypto/precious_metal)", () => {
    for (const instrument of [
      "fund",
      "etf",
      "stock",
      "index",
      "pension_plan",
      "crypto",
      "precious_metal",
    ] as const) {
      expect(returnsKindForInstrument(instrument)).toBe("market");
    }
  });

  test("appreciating non-market instruments (property/vehicle/coin_collection)", () => {
    for (const instrument of ["property", "vehicle", "coin_collection"] as const) {
      expect(returnsKindForInstrument(instrument)).toBe("appreciating");
    }
  });

  test("cash, deposits and debts have no returns", () => {
    for (const instrument of [
      "current_account",
      "term_deposit",
      "mortgage",
      "loan",
      "credit_card",
      "other",
    ] as const) {
      expect(returnsKindForInstrument(instrument)).toBeNull();
    }
  });
});

describe("buildHoldingReturnsView", () => {
  test("market: simple gain + IRR + TWR + realized/unrealized split", () => {
    const view = buildHoldingReturnsView({
      instrument: "fund",
      simpleGain: gain(),
      irr: okIrr,
      twr: okTwr,
      realizedPnl: money(200_00, "EUR"),
      unrealizedPnl: money(4_839_00, "EUR"),
    });

    expect(view).not.toBeNull();
    expect(view!.kind).toBe("market");
    expect(view!.totalReturnRatio).toBe(0.299);
    expect(view!.irr).toEqual(okIrr);
    expect(view!.twr).toEqual(okTwr);
    expect(view!.realizedPnl).toEqual(money(200_00, "EUR"));
    expect(view!.unrealizedPnl).toEqual(money(4_839_00, "EUR"));
    expect(view!.caveats).toContain(MARKET_CAVEAT);
  });

  test("appreciating: simple gain only — IRR/TWR forced there are null, not bogus", () => {
    const view = buildHoldingReturnsView({
      instrument: "property",
      simpleGain: gain(),
      irr: okIrr,
    });

    expect(view!.kind).toBe("appreciating");
    expect(view!.irr).toBeNull();
    expect(view!.twr).toBeNull();
    expect(view!.realizedPnl).toBeNull();
    expect(view!.unrealizedPnl).toBeNull();
    expect(view!.caveats).toEqual([APPRECIATING_CAVEAT]);
  });

  test("no-returns instruments produce no view", () => {
    expect(
      buildHoldingReturnsView({
        instrument: "current_account",
        simpleGain: gain(),
        irr: okIrr,
      }),
    ).toBeNull();
  });

  test("sub-year span is total, never annualized", () => {
    const view = buildHoldingReturnsView({
      instrument: "etf",
      simpleGain: gain({ annualized: false, cagr: null, spanDays: 120 }),
      irr: okIrr,
    });

    expect(view!.annualized).toBe(false);
    expect(view!.cagr).toBeNull();
  });

  test("a failed IRR is carried through with its reason (renders as a dash upstream)", () => {
    const view = buildHoldingReturnsView({
      instrument: "stock",
      simpleGain: gain(),
      irr: failedIrr,
    });

    expect(view!.irr).toEqual(failedIrr);
    expect(view!.twr).toBeNull();
  });
});

describe("buildPortfolioReturnsView", () => {
  test("is a market view (three measures) regardless of instrument mix", () => {
    const view = buildPortfolioReturnsView(gain(), okIrr, okTwr);
    expect(view.kind).toBe("market");
    expect(view.irr).toEqual(okIrr);
    expect(view.twr).toEqual(okTwr);
    expect(view.caveats).toContain(MARKET_CAVEAT);
  });
});

describe("investmentReturnsById", () => {
  const currency = "EUR";
  const valuationDate = "2026-07-04";

  test("computes a view per operation-bearing holding, keyed by asset id", () => {
    const views = investmentReturnsById({
      operationsByAsset: new Map([["a1", [op("buy", "10", "100", "2024-01-01", "a1")]]]),
      instrumentByAsset: new Map([["a1", "fund"]]),
      cachedPriceByAsset: new Map([["a1", "150"]]),
      manualPriceByAsset: new Map(),
      monthlyClosesByAsset: new Map([
        [
          "a1",
          [
            { date: "2024-01-31", valueMinor: 100_000 },
            { date: "2026-07-04", valueMinor: 150_000 },
          ],
        ],
      ]),
      currency,
      valuationDate,
    });

    const view = views.get("a1");
    expect(view).toBeDefined();
    expect(view!.kind).toBe("market");
    // 10 units bought at 100 (cost 1000.00), now worth 10×150 = 1500.00 → +50%.
    expect(view!.totalReturnRatio).toBeCloseTo(0.5, 6);
    expect(view!.totalGain).toEqual(money(500_00, "EUR"));
    expect(view!.irr!.rate).not.toBeNull();
    expect(view!.twr!.rate).toBeCloseTo(0.5, 6);
    expect(view!.twr!.startDate).toBe("2024-01-31");
  });

  test("skips holdings without operations", () => {
    const views = investmentReturnsById({
      operationsByAsset: new Map([["a1", []]]),
      instrumentByAsset: new Map([["a1", "fund"]]),
      cachedPriceByAsset: new Map(),
      manualPriceByAsset: new Map(),
      currency,
      valuationDate,
    });
    expect(views.has("a1")).toBe(false);
  });
});

describe("portfolioReturnsView", () => {
  test("merges every holding's cashflows into one portfolio view", () => {
    const view = portfolioReturnsView({
      operationsByAsset: new Map([
        ["a1", [op("buy", "10", "100", "2024-01-01", "a1")]],
        ["a2", [op("buy", "5", "200", "2024-01-01", "a2")]],
      ]),
      cachedPriceByAsset: new Map([
        ["a1", "150"],
        ["a2", "200"],
      ]),
      manualPriceByAsset: new Map(),
      portfolioMonthlyCloses: [
        { date: "2024-01-31", valueMinor: 200_000 },
        { date: "2026-07-04", valueMinor: 250_000 },
      ],
      currency: "EUR",
      valuationDate: "2026-07-04",
    });

    expect(view).not.toBeNull();
    expect(view!.kind).toBe("market");
    // invested 1000 + 1000 = 2000; value 1500 + 1000 = 2500 → +25%.
    expect(view!.totalReturnRatio).toBeCloseTo(0.25, 6);
    expect(view!.twr!.rate).toBeCloseTo(0.25, 6);
  });

  test("is null when there are no operation-bearing holdings", () => {
    expect(
      portfolioReturnsView({
        operationsByAsset: new Map(),
        cachedPriceByAsset: new Map(),
        manualPriceByAsset: new Map(),
        currency: "EUR",
        valuationDate: "2026-07-04",
      }),
    ).toBeNull();
  });
});

describe("returnsByAssetClassView", () => {
  test("frames each class as a market view carrying the class-attribution caveat", () => {
    const result = returnsByAssetClassView({
      assetClassByAsset: new Map([
        ["a1", { breakdown: { equity: "1" }, kind: "classified" }],
        ["a2", { breakdown: { bond: "1" }, kind: "classified" }],
      ]),
      cachedPriceByAsset: new Map([
        ["a1", "150"],
        ["a2", "200"],
      ]),
      currency: "EUR",
      instrumentByAsset: new Map([
        ["a1", "fund"],
        ["a2", "fund"],
      ]),
      manualPriceByAsset: new Map(),
      operationsByAsset: new Map([
        ["a1", [op("buy", "10", "100", "2024-01-01", "a1")]],
        ["a2", [op("buy", "5", "200", "2024-01-01", "a2")]],
      ]),
      valuationDate: "2026-07-04",
    });

    expect(result).not.toBeNull();
    expect(result!.classes.map((c) => c.key).sort()).toEqual(["bond", "equity"]);
    const equity = result!.classes.find((c) => c.key === "equity")!;
    expect(equity.view.kind).toBe("market");
    // a1: invested 1000, value 1500 → +50%.
    expect(equity.view.totalReturnRatio).toBeCloseTo(0.5, 6);
    expect(equity.view.caveats).toContain(CLASS_ATTRIBUTION_CAVEAT);
    expect(equity.value.amountMinor).toBe(150_000);
    expect(result!.coverage.unknown.amountMinor).toBe(0);
  });

  test("a holding whose class is unknown lands in the unclassified bucket", () => {
    const result = returnsByAssetClassView({
      assetClassByAsset: new Map([["a1", { kind: "unknown" }]]),
      cachedPriceByAsset: new Map([["a1", "150"]]),
      currency: "EUR",
      instrumentByAsset: new Map([["a1", "fund"]]),
      manualPriceByAsset: new Map(),
      operationsByAsset: new Map([["a1", [op("buy", "10", "100", "2024-01-01", "a1")]]]),
      valuationDate: "2026-07-04",
    });

    expect(result!.classes.map((c) => c.key)).toEqual(["unclassified"]);
    expect(result!.coverage.unknown.amountMinor).toBe(150_000);
    expect(result!.coverage.classified.amountMinor).toBe(0);
  });

  test("is null when no operation-bearing market holding resolves", () => {
    expect(
      returnsByAssetClassView({
        assetClassByAsset: new Map(),
        cachedPriceByAsset: new Map(),
        currency: "EUR",
        instrumentByAsset: new Map(),
        manualPriceByAsset: new Map(),
        operationsByAsset: new Map(),
        valuationDate: "2026-07-04",
      }),
    ).toBeNull();
  });
});
