/**
 * The keys by which a document row finds a holding, normalized once (#1366).
 *
 * Two surfaces route documents onto the portfolio — the assistant's reconcile
 * ({@link ./holding-matcher}) and the statement importer
 * ({@link ./statement-import-plan}) — and they must agree on what "the same key"
 * means, or the same file resolves differently depending on which door it came
 * through. They used to agree by having each written the rule out again; here it
 * is written once.
 */

/** ISIN: two letters, nine alphanumerics, one check digit. */
const ISIN_SHAPE = /^[A-Za-z]{2}[A-Za-z0-9]{9}[0-9]$/;

/** Whether an identifier can be persisted as an asset's ISIN. */
export function isIsinShaped(identifier: string): boolean {
  return ISIN_SHAPE.test(identifier.trim());
}

/**
 * Normalize a strong identifier (ISIN or provider symbol): uppercase **only**
 * when it has ISIN shape. Plantilla identifiers (#695) include CoinGecko ids,
 * lowercase by contract — uppercasing "bitcoin" would break both the grouping and
 * the matching. Empty → null.
 */
export function normalizeMatchKey(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  return ISIN_SHAPE.test(trimmed) ? trimmed.toUpperCase() : trimmed;
}

/**
 * Lowercase, strip diacritics, collapse whitespace — the name comparison basis.
 * A name is only ever a **weak** key: it proposes and it breaks ties, it never
 * resolves on its own. Empty → null.
 */
export function normalizeMatchName(value: string | null | undefined): string | null {
  const normalized = (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}
