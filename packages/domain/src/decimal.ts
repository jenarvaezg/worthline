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

/**
 * Normalize a decimal string through the seam: collapses trailing-zero and
 * leading-zero noise (`7.180` → `7.18`, `095.400` → `95.4`). Throws when the
 * input is not a valid decimal, so callers can use it to validate too.
 */
export function normalizeDecimal(value: DecimalString): DecimalString {
  return new Big(value).toString();
}

/**
 * Decimals the app can read a unit count back at — the precision of its units
 * VOICE, which is what {@link formatUnits} renders and therefore the only
 * precision a DERIVED unit count may be stored at (#1395).
 *
 * It lives here, next to the voice it names, because three callers need the same
 * answer: the saldo capture of the alta (`OPENING_UNITS_DECIMALS`), the assistant's
 * derived opening, and the traspaso gate (#1479), which divides an amount by a VL
 * twice. A second spelling of `6` is a second answer, and the one that drifts is
 * the one that stores participaciones no bank publishes.
 */
export const UNITS_READBACK_DECIMALS = 6;

/**
 * Decimals the app can read a unit price back at — the precision of its price
 * voice, which is what {@link formatPrice} renders and therefore the only
 * precision a DERIVED unit price may be stored at (#1467).
 *
 * Eight, matching what every provider quote is already rounded to (`PRICE_SCALE`
 * in `@worthline/pricing`). An 8-dp price is off by at most `units × 5e-9` euros
 * — a hundredth of a cent on a million units, well under the cent the fold
 * rounds to, unlike a 20-dp division whose precision the app cannot even read
 * back (#1395).
 */
export const PRICE_READBACK_DECIMALS = 8;

/**
 * Render a units decimal for display: es-ES separators, up to six decimals — the
 * reading voice for participaciones/tokens, as `formatMoneyMinor` is for money.
 * A malformed string comes back untouched rather than as `NaN`: a figure the app
 * cannot read is still better shown raw than replaced by a lie.
 */
export function formatUnits(units: DecimalString): string {
  return formatDecimal(units, UNITS_READBACK_DECIMALS);
}

/**
 * Render a unit price for display: es-ES separators, up to eight decimals — the
 * reading voice for a stored price, as {@link formatUnits} is for participaciones.
 * No padding zeros, so a quoted 65,045 stays 65,045 and a derived 20-dp leftover
 * still reads at the 8 the app can write back (#1467). A malformed string comes
 * back untouched rather than as `NaN`.
 */
export function formatPrice(price: DecimalString): string {
  return formatDecimal(price, PRICE_READBACK_DECIMALS);
}

function formatDecimal(value: DecimalString, maximumFractionDigits: number): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return value;
  }

  return new Intl.NumberFormat("es-ES", { maximumFractionDigits }).format(numeric);
}

/**
 * Integer minor units back to a decimal string, for the seam's division and
 * comparison primitives — the inverse of {@link multiplyToMinor} at price "1".
 *
 * Money is stored as integer cents (CONTEXT.md) but `divideUnits` speaks decimals,
 * so every «importe ÷ VL» has to cross this boundary. It goes through big.js rather
 * than `amountMinor / 100`: the float division is exact for the magnitudes involved,
 * but a division whose result feeds a stored unit count belongs behind the same seam
 * as the rest, not next to it.
 */
export function minorToDecimal(amountMinor: number): DecimalString {
  return new Big(amountMinor).div(100).toFixed(2);
}

/**
 * True when `value` parses as a decimal strictly greater than zero. A malformed
 * string answers false instead of throwing, so callers can use it as a guard on
 * stored data of unknown quality.
 */
export function isPositiveDecimal(value: DecimalString): boolean {
  try {
    return new Big(value).gt(0);
  } catch {
    return false;
  }
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
 * value × factor as a decimal string, rounded half up to `decimalPlaces` — the seam's
 * scale-by-a-rate primitive (#1401: a unit price re-expressed in another currency
 * through an FX rate).
 *
 * The factor may be a float, because an ECB rate IS one (`fx.ts` documents why), and
 * it still crosses big.js: the product picks up no binary drift beyond the explicit
 * rounding step, unlike `Number(price) * rate`.
 */
export function scaleDecimal(
  value: DecimalString,
  factor: number | DecimalString,
  decimalPlaces: number,
): DecimalString {
  return new Big(value)
    .times(new Big(factor))
    .round(decimalPlaces, Big.roundHalfUp)
    .toString();
}

/**
 * numerator ÷ denominator as a decimal string, rounded half up to `decimalPlaces`.
 * Used to reconstruct a unit price from a total amount and a unit count (ADR 0018:
 * a MyInvestor order carries the amount and the units but no price column, so the
 * NAV is recovered as amount ÷ units) and to derive participaciones from a saldo.
 * The scale is always the caller's: {@link PRICE_READBACK_DECIMALS} for a stored
 * price, {@link UNITS_READBACK_DECIMALS} for a stored unit count — there is no
 * 20-dp default, because that precision is one the app cannot read back (#1467).
 * Throws when the denominator is zero — a caller must guard against it.
 */
export function divideUnits(
  numerator: DecimalString,
  denominator: DecimalString,
  decimalPlaces: number,
): DecimalString {
  return new Big(numerator)
    .div(new Big(denominator))
    .round(decimalPlaces, Big.roundHalfUp)
    .toString();
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
