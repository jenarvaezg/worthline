import { normalizeNonNegativeDecimalString } from "@web/intake-primitives";
import { type DecimalString, divideUnits } from "@worthline/domain";

/**
 * The "saldo de hoy" → participaciones derivation (#597, PRD #593 S2): a user who
 * only knows what an investment is *worth today* enters a euro balance + the unit
 * price; the units are `saldo ÷ precio`. The single source of this math, shared by
 * the server action (which records the opening BUY from it) and the client `≈
 * participaciones` hint — so the preview can never drift from what gets persisted.
 *
 * Pure and es-ES aware (reuses the intake money normalization). Returns a typed
 * failure naming the missing/zero field so the action can attach the right
 * Spanish guidance (also the manual-fallback message when no price was found).
 */

export interface OpeningUnitsInput {
  saldoRaw: string;
  priceRaw: string;
}

export type OpeningUnitsResult =
  | { ok: true; units: DecimalString; price: DecimalString }
  | { ok: false; reason: "saldo" | "price" };

function positiveDecimal(raw: string): DecimalString | null {
  const normalized = normalizeNonNegativeDecimalString(raw);
  if (normalized === null || Number.parseFloat(normalized) === 0) {
    return null;
  }
  return normalized as DecimalString;
}

export function deriveOpeningUnits({
  priceRaw,
  saldoRaw,
}: OpeningUnitsInput): OpeningUnitsResult {
  const price = positiveDecimal(priceRaw);
  if (price === null) {
    return { ok: false, reason: "price" };
  }

  const saldo = positiveDecimal(saldoRaw);
  if (saldo === null) {
    return { ok: false, reason: "saldo" };
  }

  return { ok: true, price, units: divideUnits(saldo, price) as DecimalString };
}

/** Units to show in the live `≈ participaciones` hint, or null when not derivable yet. */
export function previewOpeningUnits(
  saldoRaw: string,
  priceRaw: string,
): DecimalString | null {
  const result = deriveOpeningUnits({ priceRaw, saldoRaw });
  return result.ok ? result.units : null;
}
