/**
 * The FIRE capital split (#1447): the partition of the eligible pool into what can
 * be *sold in slices* and what cannot.
 *
 * A safe-withdrawal rate assumes a portfolio you sell down and rebalance. A flat
 * in Plasencia is not that. When two thirds of the eligible pool is brick, a
 * single "68,5 % funded" promises capital that cannot be spent in instalments —
 * so the two natures are shown apart instead of summed into one figure.
 *
 * Nothing here changes eligibility: the sides are groupings over the liquidity
 * rungs the pool already accumulates (ADR 0013/0022). There is no fifth tier —
 * `sellable` is cash + market + term-locked, `immobilized` is illiquid + housing.
 *
 * Debt nets INSIDE its own side: a mortgage rides the rung of the house it
 * secures (`rungForLiability`), so it can never eat the market cash in the
 * presentation. Only when a side is genuinely underwater does the excess spill
 * onto the other — the debt is real even when its collateral does not cover it.
 *
 * And since #1460 the split is no longer only presentation: not everyone plans to
 * sell their flat, so the user can DECLARE that the immobilized side is not FIRE
 * capital (ADR 0078). `countsImmobilized` carries that declaration, and
 * `drawableMinor` is the answer to "what does FIRE measure here" — both sides when
 * the brick counts, the sellable one alone when it does not. The partition itself
 * is unchanged either way: the immobilized row keeps its figure so a screen can
 * grey it out instead of hiding patrimonio the user still owns.
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
  /**
   * `grossMinor` broken down by the rung it came from — the same rungs `tiers`
   * names, in ladder order. It exists so a screen can say *how much* of a side is
   * one particular rung without re-deriving it from the pool (#1523): the sellable
   * side is allowed to carry term-locked capital, but a reader cannot see how much
   * of «vendible» is actually locked unless the split says so.
   */
  grossByTierMinor: Partial<Record<LiquidityTier, number>>;
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
  /**
   * The eligible capital FIRE actually measures (minor units), net of debt and of
   * the goal reservation: both sides added up when the immobilized side counts,
   * and `sellable.amountMinor` alone when the user declared it out (#1460).
   * `calculateFireForScope` feeds THIS into the FIRE math, so the figure on screen
   * and the rows under it can never tell different stories.
   */
  drawableMinor: number;
  /** Whether `immobilized` is part of `drawableMinor` — the user's declaration (#1460). */
  countsImmobilized: boolean;
}

export interface SplitFireCapitalInput {
  /** Eligible minor per rung, gross of debt (`FireEligiblePool.eligibleByTierMinor`). */
  eligibleByTierMinor: Partial<Record<LiquidityTier, number>>;
  /** Scoped debt per rung (`FireEligiblePool.scopedDebtByTierMinor`). */
  debtByTierMinor: Partial<Record<LiquidityTier, number>>;
  /** Capital reserved for dated goals, already subtracted from the figure on screen. */
  reservedForGoalsMinor?: number;
  /**
   * The user's declaration (#1460): does the immobilized side count as FIRE
   * capital? Defaults to `true` — the behaviour every stored config had before the
   * field existed. When `false` the reservation can only come off the sellable side,
   * because that is the only capital FIRE is drawing from.
   */
  countsImmobilized?: boolean;
}

/**
 * Partition the eligible pool. `sellable.amountMinor + immobilized.amountMinor`
 * is the whole pool net of debt and reservation (clamped at 0) by construction,
 * and `drawableMinor` is the part of it FIRE measures — the same number when the
 * immobilized side counts. The split is a lens on the FIRE figure, never a second
 * opinion about it.
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
  // side first and only spills when there is not enough to sell — and it can only
  // ever eat capital FIRE is drawing from: with the brick declared out (#1460) a
  // reservation bigger than the sellable side cannot start consuming a side that is
  // no longer in the figure.
  const countsImmobilized = input.countsImmobilized ?? true;
  const drawableNetMinor = countsImmobilized ? sellableNet + immobilizedNet : sellableNet;
  const reserved = Math.min(
    Math.max(0, input.reservedForGoalsMinor ?? 0),
    drawableNetMinor,
  );
  const reservedFromSellable = Math.min(reserved, sellableNet);

  const immobilizedSide: FireCapitalSide = {
    ...immobilized,
    absorbedDebtMinor: immobilizedAbsorbed,
    amountMinor: immobilizedNet - (reserved - reservedFromSellable),
    reservedMinor: reserved - reservedFromSellable,
  };
  const sellableSide: FireCapitalSide = {
    ...sellable,
    absorbedDebtMinor: sellableAbsorbed,
    amountMinor: sellableNet - reservedFromSellable,
    reservedMinor: reservedFromSellable,
  };

  return {
    countsImmobilized,
    // Read off the sides themselves, not recomputed from the nets above: the figure
    // FIRE measures is by construction the sum of the rows printed under it.
    drawableMinor: countsImmobilized
      ? sellableSide.amountMinor + immobilizedSide.amountMinor
      : sellableSide.amountMinor,
    immobilized: immobilizedSide,
    sellable: sellableSide,
  };
}

/**
 * Does FIRE draw from this rung, given the declaration (#1460)? The ONE predicate
 * behind both halves of the answer — the capital the pool contributes and the weight
 * it lends to the expected return — because a rung dropped from the total but kept in
 * the weighting would produce a rate nobody's money holds.
 */
export function fireDrawsFromTier(
  tier: LiquidityTier,
  countsImmobilized: boolean,
): boolean {
  return countsImmobilized || sideOfTier(tier) === "sellable";
}

/**
 * How much of the sellable side is **term-locked** capital — locked until a date or
 * an age (ADR 0013): the pension plan, the deposit, the savings insurance.
 *
 * `term-locked` stays on the sellable side (#1523's verdict), and for a perpetual
 * SWR that is the right call: a plazo does mature, and a withdrawal rate is a
 * thirty-to-forty-year rule. What was NOT right was the silence — the «vendible» row
 * answered "this can be sold in slices" over capital the app itself classifies as
 * locked. This figure is what makes the nuance sayable, and it lives here rather
 * than on a screen because it is a cut of the very partition that produced the row,
 * never a second opinion about it.
 *
 * Capped at the side's **net**, which is what the row prints. Debt and the goal
 * reservation are paid with what can be touched, so an indebted scope can never read
 * more term-locked capital than its whole sellable side (ADR 0077 — the exact defect
 * #1528 had to fix by printing two figures of one card off different bases).
 *
 * None of this speaks about *when* it unlocks: that is declared per holding and
 * resolved by `fire-capital-availability` (#1528, ADR 0100). Here there is only "how
 * much".
 */
export function termLockedWithinSellableMinor(split: FireCapitalSplit): number {
  const gross = split.sellable.grossByTierMinor["term-locked"] ?? 0;
  return Math.max(0, Math.min(gross, split.sellable.amountMinor));
}

function collectSide(
  input: SplitFireCapitalInput,
  side: FireCapitalSideKey,
): Omit<FireCapitalSide, "amountMinor" | "reservedMinor" | "absorbedDebtMinor"> {
  let grossMinor = 0;
  let debtMinor = 0;
  const tiers: LiquidityTier[] = [];
  const grossByTierMinor: Partial<Record<LiquidityTier, number>> = {};

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
      grossByTierMinor[tier] = tierGross;
    }
  }

  return { debtMinor, grossByTierMinor, grossMinor, tiers };
}
