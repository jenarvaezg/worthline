/**
 * Category-weighted FIRE real return (PRD #507 N3, issue #515).
 *
 * Computes an EFFECTIVE real return by weighting each eligible tier's return
 * by its share of the eligible pool — so a portfolio 60 % market / 40 % cash
 * uses 0.60×0.05 + 0.40×0.00 = 0.03 instead of a fixed 5 % override.
 *
 * Housing is excluded from the FIRE-eligible pool (primary residence exclusion,
 * ADR 0042), so it carries no rate here.
 *
 * Crypto / Binance tokens land on whatever tier `tierOfAsset` assigns them
 * (typically "market" or "illiquid") — no separate crypto rate in v1.
 */

import type { LiquidityTier } from "./liquidity-ladder";

/**
 * The eligible tiers — housing is excluded because it is never in the
 * FIRE-eligible pool (primary residences are excluded, and all housing assets
 * are property instruments).
 */
export type EligibleTier = Exclude<LiquidityTier, "housing">;

/**
 * Conservative real (after-inflation) return defaults per eligible tier.
 * Each figure is an annual decimal (e.g. 0.05 = 5 %).
 *
 * - cash:        0 % — savings accounts track inflation at best.
 * - market:      5 % — global equity long-run real average (conservative).
 * - term-locked: 1.5 % — fixed deposits / bonds, above inflation but low.
 * - illiquid:    3 % — private equity / collectibles, illiquidity premium offset by higher risk.
 *
 * These are overridable per-config via `FireScopeConfig.tierRealReturns`.
 */
export const TIER_REAL_RETURN_DEFAULTS: Record<EligibleTier, number> = {
  cash: 0.0,
  market: 0.05,
  "term-locked": 0.015,
  illiquid: 0.03,
};

/**
 * Compute the effective real return for a FIRE-eligible pool, weighting each
 * tier's return by its share of the total.
 *
 * @param input.eligibleByTierMinor - Minor-unit balance per tier (only eligible tiers).
 * @param input.tierRealReturns     - Optional per-tier overrides (decimal fractions).
 * @returns Weighted real return as a decimal. Falls back to the market default when
 *          the total eligible pool is zero (avoids NaN / division by zero).
 */
export function effectiveRealReturn(input: {
  eligibleByTierMinor: Partial<Record<LiquidityTier, number>>;
  tierRealReturns?: Partial<Record<LiquidityTier, number>>;
}): number {
  const { eligibleByTierMinor, tierRealReturns } = input;

  const eligibleTiers: EligibleTier[] = ["cash", "market", "term-locked", "illiquid"];

  let totalMinor = 0;
  for (const tier of eligibleTiers) {
    totalMinor += eligibleByTierMinor[tier] ?? 0;
  }

  // ponytail: market default for empty pool keeps rate non-NaN; use 0 (cash)
  // here instead if you prefer unfunded plans to show zero growth.
  if (totalMinor <= 0) {
    return tierRealReturns?.["market"] ?? TIER_REAL_RETURN_DEFAULTS["market"];
  }

  let weighted = 0;
  for (const tier of eligibleTiers) {
    const tierMinor = eligibleByTierMinor[tier] ?? 0;
    const tierRate = tierRealReturns?.[tier] ?? TIER_REAL_RETURN_DEFAULTS[tier];
    weighted += (tierMinor / totalMinor) * tierRate;
  }

  return weighted;
}
