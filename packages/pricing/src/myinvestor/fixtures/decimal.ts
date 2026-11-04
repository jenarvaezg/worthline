/**
 * What the MyInvestor fixture tooling (#1887) needs from decimal arithmetic beyond the
 * domain's seam (`@worthline/domain`, `decimal.ts`), which it uses for everything else:
 * `subtractUnits`, `compareUnits`, `divideUnits`. The fixtures rebuild positions and
 * balances from invented orders, and P8 (#1869) needs today's shares to come out EXACTLY
 * as the sum of the completed orders, so nothing here goes through binary floating
 * point.
 */
import { addUnits, normalizeDecimal, scaleDecimal } from "@worthline/domain";

const PLAIN_DECIMAL = /^-?\d+(?:\.\d+)?$/;

/** The decimals a canonical literal carries. */
function decimalsOf(canonical: string): number {
  return canonical.split(".")[1]?.length ?? 0;
}

/**
 * A JSON number literal without trailing zeros, leading zeros or a signed zero:
 * `318.4000` → `318.4`. It refuses an exponent or anything that is not a plain decimal:
 * the fixtures compare literals as text, and `1e-7` would never match `0.0000001`.
 */
export function canonicalDecimal(literal: string): string {
  const trimmed = literal.trim();
  if (!PLAIN_DECIMAL.test(trimmed))
    throw new Error(`No es un literal decimal: ${literal}`);
  const canonical = normalizeDecimal(trimmed);
  return canonical === "-0" ? "0" : canonical;
}

/** `a × b`, exact: a product never has more decimals than its two factors together. */
export function multiplyDecimal(a: string, b: string): string {
  const left = canonicalDecimal(a);
  const right = canonicalDecimal(b);
  return canonicalDecimal(
    scaleDecimal(left, right, decimalsOf(left) + decimalsOf(right)),
  );
}

/** The exact sum of the literals; `0` for none. */
export function addDecimals(values: readonly string[]): string {
  return canonicalDecimal(
    values.reduce<string>((sum, value) => addUnits(sum, value), "0"),
  );
}

/** The literal rounded half away from zero to `decimals` places. */
export function roundDecimal(literal: string, decimals: number): string {
  return canonicalDecimal(scaleDecimal(literal, "1", decimals));
}
