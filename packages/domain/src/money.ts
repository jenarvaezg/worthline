import type { CurrencyCode, MoneyMinor } from "@worthline/contracts";

/**
 * The single home for every `MoneyMinor` operation. Money is stored as integer
 * minor units in a base currency; this module owns construction, currency-guarded
 * arithmetic, ownership allocation, and the es-ES localized parse/format rules so
 * that the domain calculations and the web layer cross one seam instead of
 * re-deriving these rules in place.
 */

export function money(amountMinor: number, currency: CurrencyCode): MoneyMinor {
  return { amountMinor, currency };
}

export function assertMinorInteger(amountMinor: number): void {
  if (!Number.isInteger(amountMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }
}

export function addMoney(left: MoneyMinor, right: MoneyMinor): MoneyMinor {
  if (left.currency !== right.currency) {
    throw new Error("Cannot add money with different currencies.");
  }

  return {
    amountMinor: left.amountMinor + right.amountMinor,
    currency: left.currency,
  };
}

export function subtractMoney(left: MoneyMinor, right: MoneyMinor): MoneyMinor {
  if (left.currency !== right.currency) {
    throw new Error("Cannot subtract money with different currencies.");
  }

  return {
    amountMinor: left.amountMinor - right.amountMinor,
    currency: left.currency,
  };
}

/**
 * Allocate a minor amount by an ownership share in basis points, rounding half
 * up toward positive infinity. Uses floor division (not BigInt's truncation
 * toward zero) so the rounding is sign-correct and a full 10000 bps share always
 * round-trips the whole amount, including negative amounts.
 */
export function allocateByBps(amountMinor: number, shareBps: number): number {
  const numerator = BigInt(amountMinor) * BigInt(shareBps) + 5_000n;

  return Number(floorDiv(numerator, 10_000n));
}

/** Floor division for BigInt (truncates toward negative infinity), divisor > 0. */
function floorDiv(dividend: bigint, divisor: bigint): bigint {
  const quotient = dividend / divisor;
  const remainder = dividend % divisor;

  return remainder < 0n ? quotient - 1n : quotient;
}

/** Render a money value for display: es-ES currency, no decimal cents. */
export function formatMoneyMinor(value: MoneyMinor): string {
  const formatter = new Intl.NumberFormat("es-ES", {
    currency: value.currency,
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
    style: "currency",
  });

  return formatter.format(value.amountMinor / 100);
}

/** Render a money value for an editable input field: two decimals, comma separator. */
export function formatMoneyInput(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2).replace(".", ",");
}

/** Parse an es-ES localized decimal string (e.g. "1.234,56") into a number. */
export function parseDecimal(raw: string): number {
  const trimmed = raw.trim();

  if (!trimmed) {
    return 0;
  }

  const normalized = trimmed.includes(",")
    ? trimmed.replace(/\./g, "").replace(",", ".")
    : trimmed;
  const parsed = Number(normalized);

  return Number.isFinite(parsed) ? parsed : 0;
}

/** Parse an es-ES localized money string into integer minor units. */
export function parseDecimalToMinor(raw: string): number {
  return Math.round(parseDecimal(raw) * 100);
}
