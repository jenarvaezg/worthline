import { normalizeDecimal } from "@worthline/domain";
import { z } from "zod";

import { ATTACHMENT_TYPES_V1 } from "./attachment-types";

/**
 * The vocabulary every document family of the extraction contract reads and writes:
 * the envelope's bounds, and the primitive schemas that make a figure, a day, an ISIN
 * or a decimal mean the same thing in all of them.
 *
 * It knows nothing about any single family, which is what lets a family module import
 * it without importing its siblings — the partition #1699 asked for.
 */

const MEBIBYTE = 1024 * 1024;

export const ATTACHMENT_LIMIT_REASONS = ["rows", "size", "type", "pages"] as const;
/**
 * Why nothing was extracted — the two facts `unrecognized` carries since #1243. It is
 * a closed field and not a comparison against the card's copy because #1246 BRANCHES
 * on the distinction: only `unidentified_document` (no document recognized at all) is
 * the drain a descriptive reading hangs off, while `empty_reading` means the document
 * was recognized and no row could be read. Optional on purpose — previews already
 * sitting in a client history predate it and must keep revalidating.
 */
export const UNRECOGNIZED_REASONS = ["unidentified_document", "empty_reading"] as const;
export const EXTRACTOR_FAILURE_KINDS = ["permanent", "transient"] as const;
export const EXTRACTOR_FAILURE_CODES = [
  "extractor_rejected",
  "extractor_unavailable",
  "invalid_output",
  "unsupported_document",
] as const;

/** The complete v1 attachment envelope, shared by every extractor route. */
export const ATTACHMENT_EXTRACTION_LIMITS_V1 = {
  acceptedTypes: ATTACHMENT_TYPES_V1,
  // Vercel Functions reject request bodies above 4.5 MB before the route runs.
  // Four MiB leaves room for multipart framing and the text conversation while
  // keeping every accepted upload inside the deployed transport boundary.
  maxBytes: 4 * MEBIBYTE,
  maxRows: 500,
  // Honesty text, not payload: enough room for a per-row caveat on a small reading
  // without letting an untrusted document push unbounded prose into chat context.
  maxWarnings: 20,
  // A dated statement or amortization schedule that reads cleanly fits well under
  // this bound; the cap keeps a pathological multi-hundred-page PDF from being
  // handed to the vision model inside the request boundary.
  maxPdfPages: 20,
} as const;

export type AttachmentLimitReason = (typeof ATTACHMENT_LIMIT_REASONS)[number];
export type UnrecognizedReason = (typeof UNRECOGNIZED_REASONS)[number];
export type ExtractorFailureKind = (typeof EXTRACTOR_FAILURE_KINDS)[number];
export type ExtractorFailureCode = (typeof EXTRACTOR_FAILURE_CODES)[number];

/**
 * Normalize a number emitted as JSON or read from a Spanish-formatted sheet.
 * Spanish grouping wins for ambiguous string values: `1.234` means 1234, while
 * a real JSON number remains unambiguous and is returned unchanged.
 */
export function normalizeExtractedNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;

  const compact = value.trim().replace(/[\s\u00a0\u202f]/g, "");
  if (!compact) return null;

  let normalized: string;
  if (/^[+-]?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(compact)) {
    normalized = compact.replace(/\./g, "").replace(",", ".");
  } else if (/^[+-]?\d+(?:,\d+)?$/.test(compact)) {
    normalized = compact.replace(",", ".");
  } else if (/^[+-]?\d+(?:\.\d+)?$/.test(compact)) {
    normalized = compact;
  } else if (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(compact)) {
    normalized = compact.replace(/,/g, "");
  } else {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export const extractedNumberSchema = z.preprocess(
  (value) => normalizeExtractedNumber(value) ?? value,
  z.number().finite(),
);
export const nonEmptyStringSchema = z.string().trim().min(1).max(300);
export const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/);

/**
 * True when `value` is `YYYY-MM-DD` AND a real day on the calendar. Exported so a
 * caller can ASK before handing a date to the contract — the vision seam uses it to
 * drop an unreadable optional date instead of failing an otherwise good reading.
 */
export function isIsoDay(value: string): boolean {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return false;
  const [year, month, day] = trimmed.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** An ISO calendar date (`YYYY-MM-DD`) that is also a real day. */
export const isoDateSchema = z
  .string()
  .trim()
  .refine(isIsoDay, "La fecha debe ser un día válido en formato YYYY-MM-DD.");

/**
 * The ISIN shape: two letters, nine alphanumerics and a check digit. Strict enough
 * that a provider symbol or free text can never masquerade as one.
 */
const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/** True when `value`, once uppercased and trimmed, is a well-formed ISIN. */
export function isValidIsin(value: string): boolean {
  return ISIN_PATTERN.test(value.trim().toUpperCase());
}

/**
 * An ISIN as it may appear in a portfolio sheet. Uppercased before validating so a
 * lowercase cell is accepted.
 */
export const isinSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z.string().regex(ISIN_PATTERN, "El ISIN debe tener 12 caracteres válidos."),
);

/** A positive magnitude with no sign, no separators and no exponent. */
const CANONICAL_DECIMAL = /^\d+(?:\.\d+)?$/;

/**
 * A decimal rendered in plain notation, through the domain's own seam (big.js, whose
 * exponent thresholds this app sets wide for exactly this). An unreadable value comes
 * back untouched so the schema below refuses it, rather than being turned into `NaN`.
 */
function plainDecimal(value: string): string {
  try {
    return normalizeDecimal(value);
  } catch {
    return value;
  }
}

/**
 * A magnitude carried as a DECIMAL STRING and not as a JSON number (#1487).
 *
 * Two reasons, and the second is the load-bearing one. A trade's units may carry eight
 * decimals (crypto) or six (participaciones) and its destination — the statement
 * contract's `DecimalString` — is a string all the way to the write, so a round trip
 * through a float is a precision loss with nothing to gain. And the vision lane must ask
 * for every printed figure as text anyway: asked for a number, the pool pads zeros until
 * it hits the token ceiling (#1316).
 *
 * A JSON number is still ACCEPTED and stringified, because a preview already sitting in
 * a client history must keep revalidating, and because a model that answers `3` instead
 * of `"3"` has said the right thing.
 *
 * Every conversion goes through {@link plainDecimal}, and a string that is ALREADY
 * canonical is left untouched: `String(0.00000001)` is `"1e-8"`, which this pattern
 * rightly refuses, so normalizing an exact reading «just in case» would be the one way
 * this schema could destroy the precision it exists to protect.
 */
export const positiveDecimalStringSchema = z.preprocess(
  (value) => {
    if (typeof value === "number") {
      return Number.isFinite(value) ? plainDecimal(String(value)) : value;
    }
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (CANONICAL_DECIMAL.test(trimmed)) return trimmed;
    const normalized = normalizeExtractedNumber(trimmed);
    return normalized === null ? value : plainDecimal(String(normalized));
  },
  z
    .string()
    .trim()
    .regex(CANONICAL_DECIMAL, "Debe ser un número positivo.")
    .refine((value) => Number(value) > 0, "Debe ser mayor que cero."),
);

/**
 * The length ONE warning may reach — the bound `nonEmptyStringSchema` enforces, named
 * here because {@link capExtractionWarnings} is what keeps callers inside it.
 */
const MAX_WARNING_CHARS = 300;

/**
 * Fit a reading's honesty text inside the envelope's warning bounds, in BOTH
 * directions. A messy sheet can drop more rows than the contract admits warnings, so
 * the last slot summarizes the overflow instead of losing it silently; and a warning
 * that quotes an untrusted cell can outgrow the per-warning cap, which would fail the
 * branded parse and turn the whole reading into `invalid_output` — strictly worse than
 * `unrecognized`, because only `unrecognized` keeps the unstructured lane (#865) that
 * lets the model still discuss the file. Clamping is the honest failure: the reading
 * survives and the warning says a little less.
 *
 * Shared by every deterministic extractor: both caps belong to the contract that
 * declares them, not to one reader.
 */
export function capExtractionWarnings(warnings: readonly string[]): string[] {
  const max = ATTACHMENT_EXTRACTION_LIMITS_V1.maxWarnings;
  const clamped = warnings.map((warning) =>
    warning.length > MAX_WARNING_CHARS
      ? `${warning.slice(0, MAX_WARNING_CHARS - 1)}…`
      : warning,
  );
  if (clamped.length <= max) return clamped;
  const kept = clamped.slice(0, max - 1);
  kept.push(`y ${clamped.length - (max - 1)} avisos más sin mostrar.`);
  return kept;
}
