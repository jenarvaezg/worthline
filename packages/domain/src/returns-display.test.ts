import { describe, expect, test } from "vitest";

import type { InvestmentOperation, OperationKind } from "./index";
import { money } from "./money";
import type { IrrResult, SimpleGain } from "./returns";
import {
  APPRECIATING_CAVEAT,
  MARKET_CAVEAT,
  TWR_PROVISIONAL_CAVEAT,
  buildHoldingReturnsView,
  buildPortfolioReturnsView,
  investmentReturnsById,
  portfolioReturnsView,
  provisionalTwr,
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

describe("provisionalTwr", () => {
  test("derives a documented fraction of the IRR (stub pending #549)", () => {
    expect(provisionalTwr(okIrr)).toEqual({ rate: 0.082 * 0.9, provisional: true });
  });

  test("a null IRR yields a null TWR — never a fabricated rate", () => {
    expect(provisionalTwr(failedIrr)).toEqual({ rate: null, provisional: true });
  });
});

describe("buildHoldingReturnsView", () => {
  test("market: simple gain + IRR + provisional TWR + realized/unrealized split", () => {
    const view = buildHoldingReturnsView({
      instrument: "fund",
      simpleGain: gain(),
      irr: okIrr,
      realizedPnl: money(200_00, "EUR"),
      unrealizedPnl: money(4_839_00, "EUR"),
    });

    expect(view).not.toBeNull();
    expect(view!.kind).toBe("market");
    expect(view!.totalReturnRatio).toBe(0.299);
    expect(view!.irr).toEqual(okIrr);
    expect(view!.twr).toEqual({ rate: 0.082 * 0.9, provisional: true });
    expect(view!.realizedPnl).toEqual(money(200_00, "EUR"));
    expect(view!.unrealizedPnl).toEqual(money(4_839_00, "EUR"));
    expect(view!.caveats).toContain(MARKET_CAVEAT);
    expect(view!.caveats).toContain(TWR_PROVISIONAL_CAVEAT);
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
    expect(view!.twr).toEqual({ rate: null, provisional: true });
  });
});

describe("buildPortfolioReturnsView", () => {
  test("is a market view (three measures) regardless of instrument mix", () => {
    const view = buildPortfolioReturnsView(gain(), okIrr);
    expect(view.kind).toBe("market");
    expect(view.irr).toEqual(okIrr);
    expect(view.twr).toEqual({ rate: 0.082 * 0.9, provisional: true });
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
      currency: "EUR",
      valuationDate: "2026-07-04",
    });

    expect(view).not.toBeNull();
    expect(view!.kind).toBe("market");
    // invested 1000 + 1000 = 2000; value 1500 + 1000 = 2500 → +25%.
    expect(view!.totalReturnRatio).toBeCloseTo(0.25, 6);
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
