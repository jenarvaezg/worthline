/**
 * Exact decimal arithmetic on JSON number literals, for the MyInvestor fixture tooling
 * (#1887). The fixtures rebuild positions and balances from invented orders, and P8
 * (#1869) needs today's shares to come out EXACTLY as the sum of the completed orders:
 * binary floating point would drift. So the literals are read as text and handled as
 * integers scaled by a power of ten.
 */

interface Scaled {
  readonly units: bigint;
  readonly scale: number;
}

const PLAIN_DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

function parse(literal: string): Scaled {
  const match = PLAIN_DECIMAL.exec(literal.trim());
  if (!match) throw new Error(`No es un literal decimal: ${literal}`);
  const [, sign, whole = "0", fraction = ""] = match;
  const units = BigInt(`${whole}${fraction}`);
  return { units: sign ? -units : units, scale: fraction.length };
}

function format({ units, scale }: Scaled): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  const body = fraction ? `${whole}.${fraction}` : whole;
  return negative && body !== "0" ? `-${body}` : body;
}

function align(value: Scaled, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

/** The literal without trailing zeros, leading zeros or a signed zero: `318.4000` → `318.4`. */
export function canonicalDecimal(literal: string): string {
  return format(parse(literal));
}

/** `a × b`, exact. */
export function multiplyDecimal(a: string, b: string): string {
  const left = parse(a);
  const right = parse(b);
  return format({ units: left.units * right.units, scale: left.scale + right.scale });
}

/** The exact sum of the literals; `0` for none. */
export function addDecimals(values: readonly string[]): string {
  const parsed = values.map(parse);
  const scale = Math.max(0, ...parsed.map((value) => value.scale));
  const units = parsed.reduce((sum, value) => sum + align(value, scale), 0n);
  return format({ units, scale });
}

/** `a − b`, exact. */
export function subtractDecimal(a: string, b: string): string {
  const right = parse(b);
  return addDecimals([a, format({ units: -right.units, scale: right.scale })]);
}

/** -1, 0 or 1 as `a` is below, equal to or above `b`. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const difference = parse(subtractDecimal(a, b)).units;
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}

/** `units / 10^drop`, rounded half away from zero. */
function shrink(units: bigint, drop: number): bigint {
  if (drop <= 0) return units * 10n ** BigInt(-drop);
  const divisor = 10n ** BigInt(drop);
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const rounded = (magnitude + divisor / 2n) / divisor;
  return negative ? -rounded : rounded;
}

/** The literal rounded half away from zero to `decimals` places. */
export function roundDecimal(literal: string, decimals: number): string {
  const value = parse(literal);
  if (value.scale <= decimals) return format(value);
  return format({ units: shrink(value.units, value.scale - decimals), scale: decimals });
}

/** `a / b` to `decimals` places, rounded half away from zero. */
export function divideDecimal(a: string, b: string, decimals: number): string {
  const left = parse(a);
  const right = parse(b);
  if (right.units === 0n) throw new Error("División por cero");
  // a/b = (la / 10^ls) / (rb / 10^rs): scale the numerator for decimals + 1 guard digit.
  const guard = decimals + 1;
  const numerator = left.units * 10n ** BigInt(guard + right.scale);
  const quotient = numerator / (right.units * 10n ** BigInt(left.scale));
  return format({ units: shrink(quotient, 1), scale: decimals });
}
