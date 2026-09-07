/**
 * The keys by which a document row finds a holding, normalized once (#1366).
 *
 * Two surfaces route documents onto the portfolio — the assistant's reconcile
 * ({@link ./holding-matcher}) and the statement importer
 * ({@link ./statement-import-plan}) — and they must agree on what "the same key"
 * means, or the same file resolves differently depending on which door it came
 * through. They used to agree by having each written the rule out again; here it
 * is written once.
 *
 * Since #1748 (enmienda a ADR 0055) a key carries its **namespace**: `isin:…`,
 * `dgs:N####`, `sym:<símbolo>`. The type participates because a flat space by
 * value accepts a mistyped identifier without delating it and matches an identity
 * against a pricing handle — a plan's `N5394` would meet an `N5394` sitting in an
 * ISIN column, and the whole point of #1741 is that those are different registers.
 * The namespace makes both impossible: a key only ever meets a key of its own
 * lane, and a value that does not validate as its declared kind claims no key at
 * all, so it shows up as "sin match" instead of matching something else.
 */

import type { Instrument } from "./instrument-catalog";
import { classifySecurityId, type SecurityId, type SecurityIdKind } from "./security-id";

/** ISIN: two letters, nine alphanumerics, one check digit. */
const ISIN_SHAPE = /^[A-Za-z]{2}[A-Za-z0-9]{9}[0-9]$/;

/**
 * Which register a match key belongs to: one of the identifier kinds, or the
 * pricing lane. Derived from {@link SecurityIdKind} so a new national register
 * gains its lane by existing, not by being listed again here.
 */
export type MatchKeyNamespace = SecurityIdKind | "sym";

/** The `sym:` prefix, the only lane whose keys are compared case-insensitively. */
const SYMBOL_PREFIX = "sym:";

/**
 * The key a TYPED national identifier claims — `isin:…` or `dgs:N####`.
 *
 * Null when the value does not validate as the kind it declares: that pair is
 * mistyped, and giving it a key of the other lane (or a key of its own lane it
 * cannot legally hold) is precisely how a wrong instrument gets grafted onto a
 * holding. With no key it falls to "sin match", which is a question the user can
 * answer.
 */
export function securityIdMatchKey(id: SecurityId | null | undefined): string | null {
  if (!id) return null;
  const classified = classifySecurityId(id.value);
  return classified?.kind === id.kind ? `${id.kind}:${classified.value}` : null;
}

/**
 * The key a provider symbol claims — `sym:<símbolo>`, case preserved, because a
 * CoinGecko id is lowercase by contract (#695). {@link symbolMatchKeyVariant}
 * supplies the lowercased twin for the case-insensitive lookup.
 */
export function providerSymbolMatchKey(symbol: string | null | undefined): string | null {
  const normalized = normalizeMatchKey(symbol);
  return normalized === null ? null : `${SYMBOL_PREFIX}${normalized}`;
}

/**
 * The key a RAW identifier claims, classified **by shape at the seam** — the same
 * total classifier the schema and the extractor use (#1742): an ISIN with its
 * check digit, a normalized `N####` plan code, and everything else a symbol.
 *
 * This is how a plantilla's bare `N5394` reaches the holding that declares that
 * DGS code, while a finect slug that merely starts with one (`N5394-Myinvestor…`)
 * keeps routing as the pricing handle it is.
 */
export function classifiedMatchKey(raw: string | null | undefined): string | null {
  const classified = classifySecurityId(raw ?? null);
  return classified
    ? `${classified.kind}:${classified.value}`
    : providerSymbolMatchKey(raw);
}

/**
 * A row or a holding as this module reads it: a typed pair when the source has
 * one, and the raw identifier column every legacy reader still fills.
 */
export interface IdentifiedByMatchKey {
  isin?: string | null;
  securityId?: SecurityId | null;
}

/**
 * The key a source claims — its **typed pair** when it states one, else its raw
 * column classified by shape (#1748).
 *
 * The typed pair is trusted AS TYPED and never re-classified: a pair whose value
 * does not validate as its kind claims no key, which surfaces as «sin match»
 * rather than as a match against another register. There is no fallback from the
 * pair to the column — that chain is what the second invariant of PRD #1741
 * forbids.
 */
export function rowMatchKey(source: IdentifiedByMatchKey): string | null {
  if (source.securityId) return securityIdMatchKey(source.securityId);
  return classifiedMatchKey(source.isin);
}

/**
 * The typed identifier a namespaced key declares, or null for a `sym:` key — a
 * pricing handle is not an identity, so there is nothing to record or to fill.
 */
export function securityIdFromMatchKey(key: string): SecurityId | null {
  const namespace = matchKeyNamespace(key);
  if (namespace === null || namespace === "sym") return null;
  return { kind: namespace, value: matchKeyValue(key) };
}

/**
 * The identifier a key carries, without its namespace — what a screen prints and
 * what a refusal names. Written here because every reader of a key needs it, and
 * three private copies of one `slice` is how «the same key» starts meaning two
 * things again.
 */
export function matchKeyValue(key: string): string {
  return key.slice(key.indexOf(":") + 1);
}

/** The register a key belongs to, or null when the string is not a key. */
export function matchKeyNamespace(key: string): MatchKeyNamespace | null {
  if (key.startsWith("isin:")) return "isin";
  if (key.startsWith("dgs:")) return "dgs";
  if (key.startsWith(SYMBOL_PREFIX)) return "sym";
  return null;
}

/**
 * The lowercased twin of a `sym:` key, when it differs — so "Bitcoin" finds
 * "bitcoin" (#695). Null for anything else: an identifier is normalized to
 * uppercase or it claims no key, so its lane needs no case variant.
 */
export function symbolMatchKeyVariant(key: string): string | null {
  if (matchKeyNamespace(key) !== "sym") return null;
  const lowered = key.toLowerCase();
  return lowered === key ? null : lowered;
}

/**
 * Whether a document row and a holding declare compatible instruments — the other
 * half of the **weak** key, and the guard that stops a coincidental name from
 * rewriting the wrong holding. When both declare one and they differ they are NOT
 * a match; when either side omits its instrument, the name carries the weak match
 * alone.
 *
 * Shared by the two doors (#1366): the assistant's name proposal and the
 * statement importer's identifier-backfill offer (#1748) must accept exactly the
 * same pairs, or the same file offers to fill one door and refuses in the other.
 */
export function instrumentsCompatible(
  a: Instrument | null | undefined,
  b: Instrument | null | undefined,
): boolean {
  if (a == null || b == null) return true;
  return a === b;
}

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
