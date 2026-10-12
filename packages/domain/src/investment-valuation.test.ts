/**
 * Tests for ADR 0006: investment value always derived, never edited by hand.
 *
 * Covers:
 * - selectInvestmentPrice: price-selection rule (cached beats manual quote)
 * - deriveInvestmentValuation: derived value, oversell warnings, missing-price behaviour
 * - Derived value flows correctly through net worth / liquidity / snapshot
 * - Manual valuation (`assertNotInvestmentAsset`) is rejected at domain level
 */
import { describe, expect, test } from "vitest";

import type { InvestmentOperation } from "./index";
import {
  buildLiquidityBreakdown,
  calculateNetWorth,
  captureNetWorthSnapshot,
  createManualAsset,
  createWorkspace,
} from "./index";
import {
  assertNotConnectedValuation,
  assertNotInvestmentAsset,
  checkManualValuationViolation,
  deriveInvestmentValuation,
  selectInvestmentPrice,
} from "./investment-valuation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkspace() {
  return createWorkspace({
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
}

function makeInvestmentAsset(
  workspace: ReturnType<typeof makeWorkspace>,
  derivedValueMinor: number,
) {
  // createManualAsset accepts type:"investment" — currentValueMinor is the
  // derived figure provided by the store's investmentValueMinor helper.
  return createManualAsset(workspace, {
    currency: "EUR",
    currentValueMinor: derivedValueMinor,
    id: "asset_inv",
    liquidityTier: "market",
    name: "Fondo indexado",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "investment",
  });
}

// ---------------------------------------------------------------------------
// Derived value in net worth
// ---------------------------------------------------------------------------

describe("investment — derived value in net worth", () => {
  test("net worth consumes the investment figure already derived by persistence", () => {
    const workspace = makeWorkspace();
    const inv = makeInvestmentAsset(workspace, 15_000);

    const summary = calculateNetWorth({
      assets: [inv],
      scopeId: "household",
      workspace,
    });

    expect(summary.grossAssets.amountMinor).toBe(15_000);
    expect(summary.totalNetWorth.amountMinor).toBe(15_000);
    expect(summary.liquidNetWorth.amountMinor).toBe(15_000);
  });

  test("investment at zero units (no operations yet) contributes zero to net worth", () => {
    const workspace = makeWorkspace();
    const inv = makeInvestmentAsset(workspace, 0);

    const summary = calculateNetWorth({
      assets: [inv],
      scopeId: "household",
      workspace,
    });

    expect(summary.grossAssets.amountMinor).toBe(0);
    expect(summary.liquidNetWorth.amountMinor).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Derived value in liquidity breakdown
// ---------------------------------------------------------------------------

describe("investment — derived value in liquidity breakdown", () => {
  test("liquidity tier shows derived market value for investment asset", () => {
    const workspace = makeWorkspace();
    const inv = makeInvestmentAsset(workspace, 20_000);

    const breakdown = buildLiquidityBreakdown({
      assets: [inv],
      liabilities: [],
      scopeId: "household",
      workspace,
    });

    const marketTier = breakdown.find((t) => t.tier === "market");
    expect(marketTier?.grossAssets.amountMinor).toBe(20_000);
    expect(marketTier?.netValue.amountMinor).toBe(20_000);
    expect(marketTier?.assets).toEqual([
      { id: "asset_inv", name: "Fondo indexado", valueMinor: 20_000 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Derived value in snapshot capture
// ---------------------------------------------------------------------------

describe("investment — derived value in snapshot capture", () => {
  test("snapshot captures the derived value, not a stale stored figure", () => {
    const workspace = makeWorkspace();
    const inv = makeInvestmentAsset(workspace, 30_000);

    const snapshot = captureNetWorthSnapshot({
      assets: [inv],
      capturedAt: "2026-06-09T12:00:00.000Z",
      id: "snap_1",
      scopeId: "household",
      scopeLabel: "Household",
      workspace,
    });

    expect(snapshot.grossAssets.amountMinor).toBe(30_000);
    expect(snapshot.totalNetWorth.amountMinor).toBe(30_000);
    expect(snapshot.liquidNetWorth.amountMinor).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// Domain-level rejection of manual valuation for investments
// ---------------------------------------------------------------------------

describe("assertNotInvestmentAsset — rejects manual valuation for investments", () => {
  test("throws when called for an investment-type asset", () => {
    const workspace = makeWorkspace();
    const inv = makeInvestmentAsset(workspace, 10_000);

    expect(() => assertNotInvestmentAsset(inv)).toThrow("investment");
  });

  test("does not throw for a manual (non-investment) asset", () => {
    const workspace = makeWorkspace();
    const manualAsset = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 5_000,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Cuenta corriente",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });

    expect(() => assertNotInvestmentAsset(manualAsset)).not.toThrow();
  });

  test("does not throw for a real_estate asset", () => {
    const workspace = makeWorkspace();
    const home = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 200_000_00,
      id: "asset_home",
      liquidityTier: "illiquid",
      name: "Casa",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "real_estate",
    });

    expect(() => assertNotInvestmentAsset(home)).not.toThrow();
  });
});

describe("assertNotConnectedValuation — rejects manual valuation for connected holdings", () => {
  test("throws when the asset is materialized from a connected source", () => {
    const workspace = makeWorkspace();
    const connected = createManualAsset(workspace, {
      connectedSourceId: "source_binance",
      currency: "EUR",
      currentValueMinor: 10_000,
      id: "asset_crypto",
      instrument: "crypto",
      liquidityTier: "market",
      name: "Binance",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "manual",
    });

    expect(() => assertNotConnectedValuation(connected)).toThrow("connected");
  });

  test("does not throw for a hand-maintained asset", () => {
    const workspace = makeWorkspace();
    const manualAsset = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 5_000,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Cuenta corriente",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });

    expect(() => assertNotConnectedValuation(manualAsset)).not.toThrow();
  });
});

describe("checkManualValuationViolation — stable domain codes", () => {
  test("returns investment code before connected code when both would apply", () => {
    const workspace = makeWorkspace();
    const both = createManualAsset(workspace, {
      connectedSourceId: "source_1",
      currency: "EUR",
      currentValueMinor: 1_000,
      id: "asset_both",
      liquidityTier: "market",
      name: "Weird",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "investment",
    });

    expect(checkManualValuationViolation(both)).toEqual({
      code: "investment_manual_valuation_rejected",
    });
  });

  test("returns connected code for a connected manual holding", () => {
    const workspace = makeWorkspace();
    const connected = createManualAsset(workspace, {
      connectedSourceId: "source_numista",
      currency: "EUR",
      currentValueMinor: 1_000,
      id: "asset_coins",
      instrument: "coin_collection",
      liquidityTier: "illiquid",
      name: "Numista",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "manual",
    });

    expect(checkManualValuationViolation(connected)).toEqual({
      code: "connected_manual_valuation_rejected",
    });
  });

  test("returns null for an eligible manual holding", () => {
    const workspace = makeWorkspace();
    const cash = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 1_000,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Cash",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });

    expect(checkManualValuationViolation(cash)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// selectInvestmentPrice — price-selection rule
// ---------------------------------------------------------------------------

describe("selectInvestmentPrice — price-selection rule", () => {
  test("returns cachedPrice when both cached and manual are present", () => {
    const result = selectInvestmentPrice({
      cachedPrice: "150.00",
      manualPrice: "120.00",
    });

    expect(result).toEqual({ pricePerUnit: "150.00", source: "cached" });
  });

  test("returns manualPrice when only manual quote is present", () => {
    const result = selectInvestmentPrice({
      cachedPrice: undefined,
      manualPrice: "120.00",
    });

    expect(result).toEqual({ pricePerUnit: "120.00", source: "manual" });
  });

  test("returns cachedPrice when only cached price is present", () => {
    const result = selectInvestmentPrice({
      cachedPrice: "200.00",
      manualPrice: undefined,
    });

    expect(result).toEqual({ pricePerUnit: "200.00", source: "cached" });
  });

  test("returns undefined when no price is available", () => {
    const result = selectInvestmentPrice({
      cachedPrice: undefined,
      manualPrice: undefined,
    });

    expect(result).toBeUndefined();
  });

  // A `failed` cache row carries price "0" as a marker for "no price known"
  // (#1330). Zero is not a price: consuming it valued live holdings at 0 €.
  test("ignores a zero cached price — the failed-row marker is not a price", () => {
    const result = selectInvestmentPrice({
      cachedPrice: "0",
      manualPrice: undefined,
    });

    expect(result).toBeUndefined();
  });

  test("falls back to the manual quote when the cached price is zero", () => {
    const result = selectInvestmentPrice({
      cachedPrice: "0.00",
      manualPrice: "120.00",
    });

    expect(result).toEqual({ pricePerUnit: "120.00", source: "manual" });
  });

  test("ignores a non-positive manual quote", () => {
    const result = selectInvestmentPrice({
      cachedPrice: undefined,
      manualPrice: "-3",
    });

    expect(result).toBeUndefined();
  });

  test("ignores a malformed cached price instead of throwing", () => {
    const result = selectInvestmentPrice({
      cachedPrice: "n/a",
      manualPrice: "120.00",
    });

    expect(result).toEqual({ pricePerUnit: "120.00", source: "manual" });
  });
});

// ---------------------------------------------------------------------------
// deriveInvestmentValuation — derived value, warnings, missing price
// ---------------------------------------------------------------------------

function buyOp(units: string, pricePerUnit: string, id: string): InvestmentOperation {
  return {
    assetId: "asset_inv",
    currency: "EUR",
    executedAt: "2026-01-01",
    feesMinor: 0,
    id,
    kind: "buy",
    pricePerUnit,
    units,
  };
}

function sellOp(units: string, pricePerUnit: string, id: string): InvestmentOperation {
  return {
    assetId: "asset_inv",
    currency: "EUR",
    executedAt: "2026-02-01",
    feesMinor: 0,
    id,
    kind: "sell",
    pricePerUnit,
    units,
  };
}

describe("deriveInvestmentValuation — derived value", () => {
  test("returns market value when a price is known (cached)", () => {
    const ops = [buyOp("10", "100", "op1")];
    const result = deriveInvestmentValuation({
      assetId: "asset_inv",
      currency: "EUR",
      operations: ops,
      cachedPrice: "130",
      manualPrice: undefined,
    });

    expect(result.valueMinor).toBe(130_000); // 10 units × 130.00 = 1300.00 EUR
    expect(result.pricePerUnit).toBe("130");
    expect(result.priceSource).toBe("cached");
    expect(result.warnings).toEqual([]);
  });

  test("cached price beats manual quote when both present", () => {
    const ops = [buyOp("10", "100", "op1")];
    const result = deriveInvestmentValuation({
      assetId: "asset_inv",
      currency: "EUR",
      operations: ops,
      cachedPrice: "130",
      manualPrice: "90",
    });

    expect(result.valueMinor).toBe(130_000);
    expect(result.pricePerUnit).toBe("130");
    expect(result.priceSource).toBe("cached");
  });

  test("falls back to manual quote when no cached price", () => {
    const ops = [buyOp("10", "100", "op1")];
    const result = deriveInvestmentValuation({
      assetId: "asset_inv",
      currency: "EUR",
      operations: ops,
      cachedPrice: undefined,
      manualPrice: "90",
    });

    expect(result.valueMinor).toBe(90_000); // 10 × 90.00
    expect(result.pricePerUnit).toBe("90");
    expect(result.priceSource).toBe("manual");
  });

  test("returns cost basis when no price is available", () => {
    const ops = [buyOp("10", "100", "op1")];
    const result = deriveInvestmentValuation({
      assetId: "asset_inv",
      currency: "EUR",
      operations: ops,
      cachedPrice: undefined,
      manualPrice: undefined,
    });

    expect(result.valueMinor).toBe(100_000); // cost basis: 10 × 100.00
    expect(result.pricePerUnit).toBeUndefined();
    expect(result.priceSource).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  test("returns cost basis when the cached price is the failed-row zero (#1330)", () => {
    const ops = [buyOp("10", "100", "op1")];
    const result = deriveInvestmentValuation({
      assetId: "asset_inv",
      currency: "EUR",
      operations: ops,
      cachedPrice: "0",
      manualPrice: undefined,
    });

    expect(result.valueMinor).toBe(100_000); // cost basis, never 0 €
    expect(result.pricePerUnit).toBeUndefined();
    expect(result.priceSource).toBeUndefined();
  });

  test("returns zero value for empty operations with no price", () => {
    const result = deriveInvestmentValuation({
      assetId: "asset_inv",
      currency: "EUR",
      operations: [],
      cachedPrice: undefined,
      manualPrice: undefined,
    });

    expect(result.valueMinor).toBe(0);
    expect(result.pricePerUnit).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  test("includes oversell warning from position derivation", () => {
    const ops = [buyOp("5", "100", "op1"), sellOp("8", "120", "op2")];
    const result = deriveInvestmentValuation({
      assetId: "asset_inv",
      currency: "EUR",
      operations: ops,
      cachedPrice: "100",
      manualPrice: undefined,
    });

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "OVERSELL",
        message: expect.stringContaining("unidades"),
      }),
    ]);
    expect(result.valueMinor).toBe(0); // 0 units after oversell clamp
  });
});

// ---------------------------------------------------------------------------
// deriveInvestmentValuation — where the price comes from, and of when (#1828)
// ---------------------------------------------------------------------------

describe("deriveInvestmentValuation — the price says where it comes from and of when (#1828)", () => {
  const ops = [buyOp("10", "100", "op1")];
  const base = {
    assetId: "asset_inv",
    currency: "EUR",
    operations: ops,
  };
  const yahooQuote = {
    fetchedAt: "2026-10-12T06:00:00.000Z",
    freshnessState: "fresh" as const,
    priceDate: "2026-10-11",
    source: "yahoo" as const,
  };

  test("a cached quote is the provider's, dated by the market day it closed", () => {
    const result = deriveInvestmentValuation({
      ...base,
      cachedPrice: "118.75",
      cachedQuote: yahooQuote,
      manualPrice: undefined,
    });

    expect(result.valueMinor).toBe(1_187_50);
    expect(result.priceOrigin).toEqual({
      asOf: "2026-10-11",
      kind: "quote",
      provider: "yahoo",
    });
  });

  test("a fresh quote with no market day is dated by the fetch that brought it", () => {
    const result = deriveInvestmentValuation({
      ...base,
      cachedPrice: "118.75",
      cachedQuote: {
        fetchedAt: "2026-10-12T06:00:00.000Z",
        freshnessState: "fresh",
        source: "coingecko",
      },
      manualPrice: undefined,
    });

    expect(result.priceOrigin).toEqual({
      asOf: "2026-10-12",
      kind: "quote",
      provider: "coingecko",
    });
  });

  test("a quote kept after a failed refresh claims no date its fetch did not bring", () => {
    // The pool keeps the last good price and stamps the FAILED attempt's time on
    // the row: that time is when it tried, not when the price is from.
    const result = deriveInvestmentValuation({
      ...base,
      cachedPrice: "118.75",
      cachedQuote: {
        fetchedAt: "2026-10-12T06:00:00.000Z",
        freshnessState: "stale",
        source: "yahoo",
      },
      manualPrice: undefined,
    });

    expect(result.priceOrigin).toEqual({ asOf: null, kind: "quote", provider: "yahoo" });
  });

  test("a hand-set price is said as such, dated by when it was set", () => {
    const result = deriveInvestmentValuation({
      ...base,
      cachedPrice: undefined,
      manualPrice: "118.75",
      manualPricedAt: "2026-10-03T09:15:00.000Z",
    });

    expect(result.valueMinor).toBe(1_187_50);
    expect(result.priceOrigin).toEqual({ asOf: "2026-10-03", kind: "manual" });
  });

  test("a hand-set price that equals the last operation's is still a hand-set price", () => {
    // The trap the prototype fell in (#1731): comparing figures afterwards called
    // this «precio de la última operación». The live rule never reads the ledger's
    // prices (ADR 0006), so the origin is the one the rule picked.
    const result = deriveInvestmentValuation({
      ...base,
      cachedPrice: undefined,
      manualPrice: "100",
    });

    expect(result.priceOrigin).toEqual({ asOf: null, kind: "manual" });
  });

  test("a quote beats a hand-set price, and the origin follows the price it picked", () => {
    const result = deriveInvestmentValuation({
      ...base,
      cachedPrice: "118.75",
      cachedQuote: yahooQuote,
      manualPrice: "90",
      manualPricedAt: "2026-10-03T09:15:00.000Z",
    });

    expect(result.pricePerUnit).toBe("118.75");
    expect(result.priceOrigin.kind).toBe("quote");
  });

  test("with no price the value is what it cost, and the origin says so", () => {
    const result = deriveInvestmentValuation({
      ...base,
      cachedPrice: undefined,
      manualPrice: undefined,
    });

    expect(result.valueMinor).toBe(1_000_00);
    expect(result.priceOrigin).toEqual({ kind: "cost" });
  });

  test("a failed fetch's zero is not a quote: the provider is not credited with it (#1330)", () => {
    const result = deriveInvestmentValuation({
      ...base,
      cachedPrice: "0",
      cachedQuote: {
        fetchedAt: "2026-10-12T06:00:00.000Z",
        freshnessState: "failed",
        source: "yahoo",
      },
      manualPrice: undefined,
    });

    expect(result.valueMinor).toBe(1_000_00);
    expect(result.priceOrigin).toEqual({ kind: "cost" });
  });
});
