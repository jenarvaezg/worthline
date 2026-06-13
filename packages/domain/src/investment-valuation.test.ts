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
  assertNotInvestmentAsset,
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

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("unidades");
    expect(result.valueMinor).toBe(0); // 0 units after oversell clamp
  });
});
