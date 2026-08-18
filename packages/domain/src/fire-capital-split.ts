/**
 * The FIRE capital split (#1447): a presentation-only partition of the eligible
 * pool into what can be *sold in slices* and what cannot.
 *
 * A safe-withdrawal rate assumes a portfolio you sell down and rebalance. A flat
 * in Plasencia is not that. When two thirds of the eligible pool is brick, a
 * single "68,5 % funded" promises capital that cannot be spent in instalments —
 * so the two natures are shown apart instead of summed into one figure.
 *
 * Nothing here changes eligibility or any rate: the sides are groupings over the
 * liquidity rungs the pool already accumulates (ADR 0013/0022). There is no
 * fifth tier — `sellable` is cash + market + term-locked, `immobilized` is
 * illiquid + housing.
 *
 * Debt nets INSIDE its own side: a mortgage rides the rung of the house it
 * secures (`rungForLiability`), so it can never eat the market cash in the
 * presentation. Only when a side is genuinely underwater does the excess spill
 * onto the other — the debt is real even when its collateral does not cover it.
 */

import type { LiquidityTier } from "./liquidity-ladder";
import { LIQUIDITY_LADDER } from "./liquidity-ladder";

/** Rungs you can sell in slices and rebalance — what a SWR actually assumes. */
export const SELLABLE_TIERS: readonly LiquidityTier[] = ["cash", "market", "term-locked"];

/** Rungs that only convert to cash as a whole, if at all. */
export const IMMOBILIZED_TIERS: readonly LiquidityTier[] = ["illiquid", "housing"];

/** Which side of the split a rung falls on. */
export function sideOfTier(tier: LiquidityTier): "sellable" | "immobilized" {
  return SELLABLE_TIERS.includes(tier) ? "sellable" : "immobilized";
}

export interface FireCapitalSide {
  /** What this side is worth after its own debt and its share of the goal reservation. */
  amountMinor: number;
  /** The side's eligible assets before debt and reservation. */
  grossMinor: number;
  /** Debt attributed to this side's rungs (as declared, even if it exceeds `grossMinor`). */
  debtMinor: number;
  /** Goal reservation taken off this side (sellable first). */
  reservedMinor: number;
  /** The rungs carrying capital on this side, ladder-ordered — the copy's glossary. */
  tiers: LiquidityTier[];
}

export interface FireCapitalSplit {
  sellable: FireCapitalSide;
  immobilized: FireCapitalSide;
}

export interface SplitFireCapitalInput {
  /** Eligible minor per rung, gross of debt (`FireEligiblePool.eligibleByTierMinor`). */
  eligibleByTierMinor: Partial<Record<LiquidityTier, number>>;
  /** Scoped debt per rung (`FireEligiblePool.scopedDebtByTierMinor`). */
  debtByTierMinor: Partial<Record<LiquidityTier, number>>;
  /** Capital reserved for dated goals, already subtracted from the figure on screen. */
  reservedForGoalsMinor?: number;
}

/**
 * Partition the eligible pool. `sellable.amountMinor + immobilized.amountMinor`
 * equals the eligible total the FIRE screen shows (net of debt and reservation,
 * clamped at 0) by construction — the split is a lens on that number, never a
 * second opinion about it.
 */
export function splitFireCapital(input: SplitFireCapitalInput): FireCapitalSplit {
  const sellable = collectSide(input, "sellable");
  const immobilized = collectSide(input, "immobilized");

  let sellableNet = sellable.grossMinor - sellable.debtMinor;
  let immobilizedNet = immobilized.grossMinor - immobilized.debtMinor;

  // An underwater side spills onto the other: a mortgage larger than its house
  // is still owed out of whatever else the scope holds.
  if (sellableNet < 0) {
    immobilizedNet += sellableNet;
    sellableNet = 0;
  }
  if (immobilizedNet < 0) {
    sellableNet += immobilizedNet;
    immobilizedNet = 0;
  }
  // Same clamp `netEligibleMinor` applies: an underwater scope reads as 0.
  sellableNet = Math.max(0, sellableNet);

  // A dated goal is funded by selling, so its reservation comes off the sellable
  // side first and only spills when there is not enough to sell.
  const reserved = Math.min(
    Math.max(0, input.reservedForGoalsMinor ?? 0),
    sellableNet + immobilizedNet,
  );
  const reservedFromSellable = Math.min(reserved, sellableNet);

  return {
    immobilized: {
      ...immobilized,
      amountMinor: immobilizedNet - (reserved - reservedFromSellable),
      reservedMinor: reserved - reservedFromSellable,
    },
    sellable: {
      ...sellable,
      amountMinor: sellableNet - reservedFromSellable,
      reservedMinor: reservedFromSellable,
    },
  };
}

function collectSide(
  input: SplitFireCapitalInput,
  side: "sellable" | "immobilized",
): Omit<FireCapitalSide, "amountMinor" | "reservedMinor"> {
  let grossMinor = 0;
  let debtMinor = 0;
  const tiers: LiquidityTier[] = [];

  for (const tier of LIQUIDITY_LADDER) {
    if (sideOfTier(tier) !== side) {
      continue;
    }
    const tierGross = input.eligibleByTierMinor[tier] ?? 0;
    grossMinor += tierGross;
    debtMinor += input.debtByTierMinor[tier] ?? 0;
    if (tierGross > 0) {
      tiers.push(tier);
    }
  }

  return { debtMinor, grossMinor, tiers };
}
