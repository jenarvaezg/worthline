/**
 * Map an extracted holding's **verbatim** `type` label (PRD #1103 S4/S5) to a
 * domain {@link Instrument}. ADR 0048 forbids the extractor from classifying, so
 * the label reaches the reconcile as free text ("Fondo de inversión", "ETF",
 * "cuenta", "hipoteca"); this pure, deterministic table turns it into the
 * instrument the S1 matcher and the family dispatch need — or `null` when it
 * cannot be recognized, which the reconcile surfaces as an "uncertain" row rather
 * than guessing a wrong family (a mis-classified holding would silently write to
 * the wrong seam).
 *
 * Pure and I/O-free: keyword matching over a normalized label, no model, no
 * clock. The vocabulary mirrors the es-ES labels of {@link ./instrument-labels}
 * and the extractor's own header aliases, plus the plain words a user's own
 * spreadsheet is likely to carry.
 */

import type { Instrument } from "@worthline/domain";

/** Lowercase, strip diacritics, collapse whitespace — the label comparison basis. */
function normalizeLabel(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Keyword → instrument table, checked in order. Each entry lists substrings that,
 * when present in the normalized label, resolve the instrument. Ordering matters
 * only where one keyword is a substring of another; the more specific entries
 * ("plan de pensiones") are listed before the generic ones ("plan").
 */
const INSTRUMENT_KEYWORDS: ReadonlyArray<readonly [Instrument, readonly string[]]> = [
  [
    "pension_plan",
    ["plan de pensiones", "plan pensiones", "pension plan", "pension", "epsv"],
  ],
  ["etf", ["etf", "fondo cotizado", "exchange traded"]],
  ["fund", ["fondo", "fund", "fondo de inversion", "sicav", "monetario"]],
  ["index", ["indice", "index", "indexado"]],
  ["crypto", ["cripto", "crypto", "bitcoin", "ethereum", "moneda digital", "token"]],
  [
    "stock",
    ["accion", "acciones", "stock", "equity", "shares", "titulo", "valor cotizado"],
  ],
  [
    "term_deposit",
    ["deposito a plazo", "deposito", "plazo fijo", "term deposit", "imposicion"],
  ],
  [
    "current_account",
    [
      "cuenta corriente",
      "cuenta",
      "current account",
      "efectivo",
      "cash",
      "liquidez",
      "checking",
      "savings",
      "ahorro",
    ],
  ],
  [
    "precious_metal",
    ["metal precioso", "metal", "oro", "plata", "gold", "silver", "lingote"],
  ],
  [
    "property",
    ["inmueble", "vivienda", "piso", "property", "real estate", "casa", "local"],
  ],
  ["vehicle", ["vehiculo", "coche", "vehicle", "car", "moto"]],
  ["mortgage", ["hipoteca", "mortgage"]],
  ["loan", ["prestamo", "loan", "credito personal", "financiacion"]],
  ["credit_card", ["tarjeta de credito", "tarjeta", "credit card"]],
];

/**
 * The instrument an extracted `type` label denotes, or `null` when unrecognized.
 * A `null` is NOT `"other"`: the reconcile keeps the row but marks it uncertain and
 * matches it by name alone, so an unrecognized label never masquerades as a
 * concrete family (ADR 0048).
 */
export function mapReconcileTypeToInstrument(type: string): Instrument | null {
  const normalized = normalizeLabel(type);
  if (!normalized) return null;
  for (const [instrument, keywords] of INSTRUMENT_KEYWORDS) {
    if (keywords.some((keyword) => normalized.includes(keyword))) return instrument;
  }
  return null;
}
