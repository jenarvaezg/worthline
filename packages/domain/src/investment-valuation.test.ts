/**
 * Tests for ADR 0006: investment value always derived, never edited by hand.
 *
 * Covers:
 * - Derived value flows correctly through net worth / liquidity / snapshot
 * - Manual valuation (`assertNotInvestmentAsset`) is rejected at domain level
 */
import { describe, expect, test } from "vitest";

import {
  buildLiquidityBreakdown,
  calculateNetWorth,
  captureNetWorthSnapshot,
  createManualAsset,
  createWorkspace,
} from "./index";
import { assertNotInvestmentAsset } from "./investment-valuation";

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
  test("net worth uses the derived figure, not any stale manual value", () => {
    const workspace = makeWorkspace();
    // Imagine the DB row has current_value_minor = 0 (old stale stored value)
    // but the store derives 15_000 from units × price and passes that in.
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

    expect(() => assertNotInvestmentAsset(inv)).toThrow(
      "investment",
    );
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
      liquidityTier: "housing",
      name: "Casa",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "real_estate",
    });

    expect(() => assertNotInvestmentAsset(home)).not.toThrow();
  });
});
