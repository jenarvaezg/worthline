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
 *
 * The weighting keeps its weights (#1426): `fireReturnMix` is the engine and
 * `effectiveRealReturn` is its `.rate`. Jorge's 3,50 % is 26,6 % market at 5 %
 * plus 68,7 % brick at 3 % plus two small rungs, and read that way it says what
 * the scalar only insinuates — his expected return is governed by the flat, not
 * by the stock market. One engine, so the table under the chart and the rate in
 * the footer cannot drift apart.
 */

import type { LiquidityTier } from "./liquidity-ladder";
import { LIQUIDITY_TIER_LABELS } from "./liquidity-ladder";

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

/** One slice of the eligible pool that carries a single real return (#1426). */
export interface FireReturnMixRow {
  /** Stable identity: the tier key, or `asset:<id>` for a per-asset rate. */
  key: string;
  kind: "tier" | "asset";
  /** The rung's name, or the asset's — what the row is called on paper. */
  label: string;
  /** Which rung this slice belongs to (an asset row rides its own rung's). */
  tier: LiquidityTier;
  /** The slice's eligible value in minor units, gross of debt. */
  weightMinor: number;
  /** `weightMinor / totalMinor` — a fraction in [0, 1]. */
  weightFraction: number;
  /** The real return applied to this slice (decimal). */
  rate: number;
  /** `weightFraction × rate` — what this slice lends to the total rate. */
  contribution: number;
}

/** The weighted real return together with the slices it is made of (#1426). */
export interface FireReturnMix {
  /** The weighted real return — what `effectiveRealReturn` returns for these inputs. */
  rate: number;
  /** The eligible weight the rate was computed over (minor units). */
  totalMinor: number;
  /**
   * The slices behind `rate`, in ladder order, each rung followed by its own-rate
   * assets. Empty when there is no weight to explain — a rate with no provenance
   * is better shown as no table than as an invented one.
   */
  rows: FireReturnMixRow[];
}

export interface FireReturnMixInput {
  eligibleByTierMinor: Partial<Record<LiquidityTier, number>>;
  tierRealReturns?: Partial<Record<LiquidityTier, number>>;
  /** Per-asset rates that substitute their tier's over their own slice (#1448). */
  assetRateOverrides?: readonly AssetRateOverride[];
  /** Asset names for the per-asset rows; an unnamed asset falls back to its id. */
  assetLabelById?: Record<string, string>;
}

const ELIGIBLE_TIERS = Object.keys(TIER_REAL_RETURN_DEFAULTS) as EligibleTier[];

/**
 * Compute the weighted real return for a FIRE-eligible pool AND the slices behind
 * it, weighting each tier's return by its share of the total.
 *
 * @param input.eligibleByTierMinor - Minor-unit balance per tier (only eligible tiers).
 * @param input.tierRealReturns     - Optional per-tier overrides (decimal fractions).
 * @param input.assetRateOverrides  - Per-asset rates that substitute their tier's (#1448).
 * @param input.assetLabelById      - Names for the per-asset rows (display only).
 * @returns The rate and its rows. Falls back to the market default when the pool is
 *          empty (avoids NaN / division by zero) — with no rows, since there is no
 *          weight any of it came from.
 */
export function fireReturnMix(input: FireReturnMixInput): FireReturnMix {
  const { eligibleByTierMinor, tierRealReturns } = input;
  const assetRateOverrides = input.assetRateOverrides ?? [];
  const assetLabelById = input.assetLabelById ?? {};

  let totalMinor = 0;
  for (const tier of ELIGIBLE_TIERS) {
    totalMinor += eligibleByTierMinor[tier] ?? 0;
  }

  const rateOf = (tier: EligibleTier) =>
    tierRealReturns?.[tier] ?? TIER_REAL_RETURN_DEFAULTS[tier];

  // ponytail: market default for empty pool keeps rate non-NaN; use 0 (cash)
  // here instead if you prefer unfunded plans to show zero growth.
  if (totalMinor <= 0) {
    return { rate: rateOf("market"), rows: [], totalMinor: 0 };
  }

  // What each tier lends to its own overridden assets, so the tier rate is applied
  // to the REMAINDER instead of to the whole rung. The total never changes: this is
  // a substitution inside the tier, not an extra weight beside it.
  const overriddenByTier = new Map<EligibleTier, number>();
  for (const override of assetRateOverrides) {
    overriddenByTier.set(
      override.tier,
      (overriddenByTier.get(override.tier) ?? 0) + override.amountMinor,
    );
  }

  interface Slice {
    key: string;
    kind: FireReturnMixRow["kind"];
    label: string;
    minor: number;
    rate: number;
    tier: EligibleTier;
  }
  const slices: Slice[] = [];
  for (const tier of ELIGIBLE_TIERS) {
    const tierMinor = eligibleByTierMinor[tier] ?? 0;
    const remainderMinor = Math.max(0, tierMinor - (overriddenByTier.get(tier) ?? 0));
    // A 0 % weight explains nothing, so an empty rung gets no row — but it is
    // still counted in `totalMinor` above, which is what the weights divide by.
    if (remainderMinor > 0) {
      slices.push({
        key: tier,
        kind: "tier",
        label: LIQUIDITY_TIER_LABELS[tier],
        minor: remainderMinor,
        rate: rateOf(tier),
        tier,
      });
    }
    for (const override of assetRateOverrides) {
      if (override.tier !== tier || override.amountMinor <= 0) {
        continue;
      }
      slices.push({
        key: `asset:${override.assetId}`,
        kind: "asset",
        label: assetLabelById[override.assetId] ?? override.assetId,
        minor: override.amountMinor,
        rate: override.rate,
        tier,
      });
    }
  }

  // Normalized by the weight actually used, not by `totalMinor`: with consistent
  // inputs the two are the same number (the overrides are a subset of their tiers,
  // so remainder + overrides = total), and with inconsistent ones the result is
  // still a convex combination of rates some asset really holds — never a rate
  // nobody holds, which is what dividing by a total the weights no longer add up to
  // would produce.
  const weightMinor = slices.reduce((sum, slice) => sum + slice.minor, 0);
  if (weightMinor <= 0) {
    return { rate: rateOf("market"), rows: [], totalMinor };
  }

  const rows = slices.map((slice): FireReturnMixRow => {
    const weightFraction = slice.minor / weightMinor;
    return {
      contribution: weightFraction * slice.rate,
      key: slice.key,
      kind: slice.kind,
      label: slice.label,
      rate: slice.rate,
      tier: slice.tier,
      weightFraction,
      weightMinor: slice.minor,
    };
  });

  return {
    rate: rows.reduce((sum, row) => sum + row.weightMinor * row.rate, 0) / weightMinor,
    rows,
    totalMinor,
  };
}

/**
 * The weighted real return for a FIRE-eligible pool — `fireReturnMix(...).rate`
 * and nothing else, so a caller that only needs the scalar cannot end up on a
 * second, disagreeing computation of it.
 */
export function effectiveRealReturn(input: FireReturnMixInput): number {
  return fireReturnMix(input).rate;
}
