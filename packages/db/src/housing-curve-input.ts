/**
 * One property's curve input, assembled from its rows (#1847, #1824 review) — the
 * ONE place the rows of a housing asset become what `valueHousingAtDate` walks.
 *
 * The sibling of `debtBalanceCurveInput`. Two readers need it: the board's batch
 * read (`readHousingCurveInputs`, every live property in one pass) and the ficha,
 * which already holds the rows of ONE property because it renders them. A second
 * copy of «what the curve reads» is how the ficha's header and the board's row end
 * up quoting different values for the same flat, so both come through here.
 *
 * Pure: it takes rows already read and maps only the fields the curve reads, so a
 * record's plumbing (its id, its asset id, its kind) never travels into the engine's
 * input.
 */

import type {
  DecimalString,
  HousingCurveInputs,
  HousingValuationAnchor,
  ValuationCadence,
} from "@worthline/domain";

/** The rows of one property that shape its curve, as the stores hand them out. */
export interface HousingCurveRows {
  /** Its valuation anchors — appraisals, improvements, the acquisition — any order. */
  anchors: readonly HousingValuationAnchor[];
  /** The stored annual appreciation rate; null draws no drift between anchors. */
  annualAppreciationRate: DecimalString | null;
  /** Stored valuation cadence (ADR 0031, #394); null reads as the default `step`. */
  cadence: ValuationCadence | null;
  /** The stored current value: the curve's fallback basis. */
  currentValueMinor: number;
}

/** The curve input of one property. */
export function housingCurveInput(rows: HousingCurveRows): HousingCurveInputs {
  const { cadence } = rows;
  return {
    anchors: rows.anchors.map((anchor) => ({
      adjustsPriorCurve: anchor.adjustsPriorCurve,
      valuationDate: anchor.valuationDate,
      valueMinor: anchor.valueMinor,
    })),
    annualAppreciationRate: rows.annualAppreciationRate,
    currentValueMinor: rows.currentValueMinor,
    ...(cadence != null ? { cadence } : {}),
  };
}
