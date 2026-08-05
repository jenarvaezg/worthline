/**
 * What sending a holding to the Papelera takes with it (#1365) — pure domain rule.
 *
 * The trash is a soft delete, and the app frames it as reversible ("podrás
 * recuperarlo"). For a CLOSED position that framing is complete: nothing leaves
 * the patrimonio, so the gesture really is the cosmetic cleanup the user reads it
 * as. For a position that still holds units it is not: the next capture stops
 * counting the holding, the curve drops by its value, and the histórico records no
 * sale, no traspaso, and no deposit into any account — the money evaporates.
 *
 * That asymmetry is the rule this module owns. The confirmation dialog (before)
 * and the data-quality engine (after) both read it here, so neither can grow its
 * own notion of "the trash would move a figure on this holding".
 *
 * Scope: a `derived` holding, whose units live in an operations ledger and whose
 * correct exit is a recorded sell. A `stored`/`appreciating` holding has the same
 * hole with a different repair (there is no sale to record — its value is what the
 * user typed), deliberately left out of this rule rather than answered wrongly.
 */

import type { DecimalString } from "./decimal";
import type { PositionSummary } from "./investment-types";
import type { MoneyMinor } from "./money";
import { unitsReadAsClosed } from "./warnings";

/** The value a trashed holding would withdraw from the patrimonio, and why. */
export interface HoldingTrashImpact {
  /** Units still recorded on the position — the evidence it is not closed. */
  netUnits: DecimalString;
  /** The value today's patrimonio counts, and would stop counting. */
  value: MoneyMinor;
  /**
   * Which figure that value IS: the market valuation, or the cost basis when no
   * quote is known. Named rather than smoothed over, so a dialog can say what it
   * is showing instead of implying a market value it does not have.
   */
  basis: "market" | "cost";
}

/**
 * The impact of trashing this position, or null when trashing it moves nothing —
 * a fully-sold position, or a holding with no position at all. Null is the signal
 * "the reassuring copy is the whole truth here": friction goes only where there is
 * money inside.
 */
export function holdingTrashImpact(
  position: PositionSummary | null | undefined,
): HoldingTrashImpact | null {
  if (!position || unitsReadAsClosed(position.currentUnits)) {
    return null;
  }

  // The same fallback the returns panel uses (#1314): an unpriced position enters
  // at its cost basis rather than at zero, because a zero here would tell the
  // user the trash costs nothing precisely when it costs the most.
  const marketValue = position.marketValue;

  return {
    basis: marketValue ? "market" : "cost",
    netUnits: position.currentUnits,
    value: marketValue ?? position.costBasis,
  };
}
