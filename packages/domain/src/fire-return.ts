/**
 * Category-weighted FIRE real return (PRD #507 N3, issue #515).
 *
 * Computes an EFFECTIVE real return by weighting each eligible tier's return
 * by its share of the eligible pool — so a portfolio 60 % market / 40 % cash
 * uses 0.60×0.05 + 0.40×0.00 = 0.03 instead of a fixed 5 % override.
 *
 * Primary residences are excluded from FIRE, but non-primary property is still
 * eligible (ADR 0022), so the housing rung carries a rate too.
 *
 * Crypto / Binance tokens land on whatever tier `tierOfAsset` assigns them
 * (typically "market" or "illiquid") — no separate crypto rate in v1.
 *
 * A single asset can carry its OWN rate instead of its tier's (#1448): a rented
 * property whose net rent is declared knows its yield, so the guess does not apply
 * to it. Those arrive as `assetRateOverrides` and SUBSTITUTE the tier rate for
 * their slice of the tier — they never add a slice, so the weights still sum to 1
 * and the eligible total is untouched.
 */

import type { LiquidityTier } from "./liquidity-ladder";

export type EligibleTier = LiquidityTier;

/**
 * Conservative real (after-inflation) return defaults per eligible tier.
 * Each figure is an annual decimal (e.g. 0.05 = 5 %).
 *
 * - cash:        0 % — savings accounts track inflation at best.
 * - market:      5 % — global equity long-run real average (conservative).
 * - term-locked: 1.5 % — fixed deposits / bonds, above inflation but low.
 * - illiquid:    3 % — private equity / collectibles, illiquidity premium offset by higher risk.
 * - housing:     3 % — non-primary property, preserving the pre-housing-rung illiquid treatment.
 *
 * These are overridable per-config via `FireScopeConfig.tierRealReturns`.
 */
export const TIER_REAL_RETURN_DEFAULTS: Record<EligibleTier, number> = {
  cash: 0.0,
  market: 0.05,
  "term-locked": 0.015,
  illiquid: 0.03,
  housing: 0.03,
};

/**
 * One asset's own real return, standing in for its tier's rate over its own slice
 * of the eligible pool (#1448). `amountMinor` is the SCOPED value the asset
 * contributes to `eligibleByTierMinor[tier]` — the pool builds these, so an
 * override is a subset of its tier by construction.
 */
export interface AssetRateOverride {
  assetId: string;
  tier: EligibleTier;
  /** The asset's scope-owned eligible value (minor units), gross of debt. */
  amountMinor: number;
  /** The asset's own real return (decimal). May be negative (costs above income). */
  rate: number;
}

/**
 * Compute the effective real return for a FIRE-eligible pool, weighting each
 * tier's return by its share of the total.
 *
 * @param input.eligibleByTierMinor - Minor-unit balance per tier (only eligible tiers).
 * @param input.tierRealReturns     - Optional per-tier overrides (decimal fractions).
 * @param input.assetRateOverrides  - Per-asset rates that substitute their tier's (#1448).
 * @returns Weighted real return as a decimal. Falls back to the market default when
 *          the total eligible pool is zero (avoids NaN / division by zero).
 */
export function effectiveRealReturn(input: {
  eligibleByTierMinor: Partial<Record<LiquidityTier, number>>;
  tierRealReturns?: Partial<Record<LiquidityTier, number>>;
  assetRateOverrides?: readonly AssetRateOverride[];
}): number {
  const { eligibleByTierMinor, tierRealReturns } = input;
  const assetRateOverrides = input.assetRateOverrides ?? [];

  const eligibleTiers = Object.keys(TIER_REAL_RETURN_DEFAULTS) as EligibleTier[];

  let totalMinor = 0;
  for (const tier of eligibleTiers) {
    totalMinor += eligibleByTierMinor[tier] ?? 0;
  }

  // ponytail: market default for empty pool keeps rate non-NaN; use 0 (cash)
  // here instead if you prefer unfunded plans to show zero growth.
  if (totalMinor <= 0) {
    return tierRealReturns?.["market"] ?? TIER_REAL_RETURN_DEFAULTS["market"];
  }

  // What each tier lends to its own overridden assets, so the tier rate is applied
  // to the REMAINDER instead of to the whole rung. The total never changes: this is
  // a substitution inside the tier, not an extra weight beside it.
  const overriddenByTier: Partial<Record<LiquidityTier, number>> = {};
  for (const override of assetRateOverrides) {
    overriddenByTier[override.tier] =
      (overriddenByTier[override.tier] ?? 0) + override.amountMinor;
  }

  // Normalized by the weight actually used, not by `totalMinor`: with consistent
  // inputs the two are the same number (the overrides are a subset of their tiers,
  // so remainder + overrides = total), and with inconsistent ones the result is
  // still a convex combination of rates some asset really holds — never a rate
  // nobody holds, which is what dividing by a total the weights no longer add up to
  // would produce.
  let weighted = 0;
  let weightMinor = 0;
  for (const tier of eligibleTiers) {
    const tierMinor = eligibleByTierMinor[tier] ?? 0;
    const tierRate = tierRealReturns?.[tier] ?? TIER_REAL_RETURN_DEFAULTS[tier];
    const remainderMinor = Math.max(0, tierMinor - (overriddenByTier[tier] ?? 0));
    weighted += remainderMinor * tierRate;
    weightMinor += remainderMinor;
  }
  for (const override of assetRateOverrides) {
    weighted += override.amountMinor * override.rate;
    weightMinor += override.amountMinor;
  }

  if (weightMinor <= 0) {
    return tierRealReturns?.["market"] ?? TIER_REAL_RETURN_DEFAULTS["market"];
  }

  return weighted / weightMinor;
}
