import Big from "big.js";

export type DecimalString = string;

/**
 * The decimal seam. Units and prices are decimal strings (CONTEXT.md), money is
 * integer minor units — so every units/price calculation and the decimal→minor
 * boundary crosses this one module (backed by big.js) instead of being re-derived
 * with lossy float math. Keeping big.js behind this seam keeps it swappable.
 */

// Render small (e.g. 8-dp crypto units) and large values in plain decimal notation
// rather than exponential, so DecimalString stays human- and storage-friendly.
Big.NE = -30;
Big.PE = 30;

export function addUnits(left: DecimalString, right: DecimalString): DecimalString {
  return new Big(left).plus(right).toString();
}

export function subtractUnits(left: DecimalString, right: DecimalString): DecimalString {
  return new Big(left).minus(right).toString();
}

/** Sign of (left - right): -1, 0, or 1. */
export function compareUnits(left: DecimalString, right: DecimalString): number {
  return new Big(left).cmp(right);
}

/** units × pricePerUnit (a currency amount) → integer minor units, rounded half up. */
export function multiplyToMinor(
  units: DecimalString,
  pricePerUnit: DecimalString,
): number {
  return Number(
    new Big(units).times(pricePerUnit).times(100).round(0, Big.roundHalfUp).toString(),
  );
}

/**
 * Remove a proportional slice of a minor total: totalMinor × part / whole, rounded
 * half up. Returns 0 when whole is 0 (used to remove cost basis on a sell at the
 * running weighted average).
 */
export function proportionMinor(
  totalMinor: number,
  part: DecimalString,
  whole: DecimalString,
): number {
  const wholeBig = new Big(whole);

  if (wholeBig.eq(0)) {
    return 0;
  }

  return Number(
    new Big(totalMinor).times(part).div(wholeBig).round(0, Big.roundHalfUp).toString(),
  );
}

/** Cost basis per unit as a currency decimal string (0 when units is 0). */
export function averageUnitCost(
  costBasisMinor: number,
  units: DecimalString,
  decimalPlaces = 4,
): DecimalString {
  const unitsBig = new Big(units);

  if (unitsBig.eq(0)) {
    return "0";
  }

  return new Big(costBasisMinor)
    .div(100)
    .div(unitsBig)
    .round(decimalPlaces, Big.roundHalfUp)
    .toString();
}
