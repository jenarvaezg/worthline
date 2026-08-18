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

export type FireCapitalSideKey = "sellable" | "immobilized";

/**
 * Which side of the split a rung falls on. Exhaustive on purpose: a sixth rung
 * on the ladder has to be placed by hand here, instead of defaulting into
 * "immobilized" because it fell through an `else`.
 */
export function sideOfTier(tier: LiquidityTier): FireCapitalSideKey {
  switch (tier) {
    case "cash":
    case "market":
    case "term-locked":
      // Sold in slices and rebalanced — what a SWR actually assumes.
      return "sellable";
    case "illiquid":
    case "housing":
      // Converts to cash as a whole, if at all.
      return "immobilized";
  }
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
  /**
   * Debt from the OTHER side that this side had to absorb because the collateral
   * did not cover it (an underwater mortgage). Without this the row would print
   * a figure its own gloss contradicts — the exact failure #1447 exists to kill.
   */
  absorbedDebtMinor: number;
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
  let sellableAbsorbed = 0;
  let immobilizedAbsorbed = 0;

  // An underwater side spills onto the other: a mortgage larger than its house
  // is still owed out of whatever else the scope holds. The absorbing side keeps
  // the amount so its gloss can name it.
  if (sellableNet < 0) {
    immobilizedAbsorbed = -sellableNet;
    immobilizedNet += sellableNet;
    sellableNet = 0;
  }
  if (immobilizedNet < 0) {
    sellableAbsorbed = -immobilizedNet;
    sellableNet += immobilizedNet;
    immobilizedNet = 0;
  }
  // Same clamp `netEligibleMinor` applies: an underwater scope reads as 0.
  // Both sides, so the order of the two spills above cannot leak a negative.
  sellableNet = Math.max(0, sellableNet);
  immobilizedNet = Math.max(0, immobilizedNet);

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
      absorbedDebtMinor: immobilizedAbsorbed,
      amountMinor: immobilizedNet - (reserved - reservedFromSellable),
      reservedMinor: reserved - reservedFromSellable,
    },
    sellable: {
      ...sellable,
      absorbedDebtMinor: sellableAbsorbed,
      amountMinor: sellableNet - reservedFromSellable,
      reservedMinor: reservedFromSellable,
    },
  };
}

function collectSide(
  input: SplitFireCapitalInput,
  side: FireCapitalSideKey,
): Omit<FireCapitalSide, "amountMinor" | "reservedMinor" | "absorbedDebtMinor"> {
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
    // `!== 0`: a rung carrying a negative eligible value still moves the total,
    // so leaving it unnamed would print a figure the gloss cannot explain.
    if (tierGross !== 0) {
      tiers.push(tier);
    }
  }

  return { debtMinor, grossMinor, tiers };
}
