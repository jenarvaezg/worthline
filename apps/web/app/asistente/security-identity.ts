/**
 * The identity check of the lanes that write from a bank's paper (#1800): the
 * identifier the paper PRINTS against the one the holding has REGISTERED. It was born
 * inside the operation lane (#1374, #1747, the typed pair of #1743) and moved here when
 * the traspaso needed the very same comparison: two doors that write from a document
 * must not differ in what they compare, and two copies of «same instrument» are how
 * they would start to.
 *
 * Compared as the TYPED pair, never as bare strings: a plan de pensiones is identified
 * by its DGS code and never by an ISIN, and `N5394` in an ISIN slot is a category error,
 * not a match. Two different kinds therefore contradict too — an ISIN paper does not
 * belong on a plan.
 *
 * A holding with no identifier registered contradicts nothing: the card prints the
 * holding and the user sees the match. What each lane does BEYOND the contradiction
 * (the traspaso also looks for the holding that does carry the paper's identifier) is
 * the lane's business; what «contradicts» means is decided only here.
 */

import {
  declaredSecurityId,
  SECURITY_ID_KIND_LABEL_INLINE,
  type SecurityId,
  type StoredSecurityId,
} from "@worthline/domain";

/** Two typed identifiers name the same instrument: same register, same value. */
export function sameSecurityId(a: SecurityId, b: SecurityId): boolean {
  return a.kind === b.kind && a.value === b.value;
}

/**
 * The identifier a holding has registered that CONTRADICTS the one the paper prints,
 * or null when nothing does — no printed identifier, none registered (or only a
 * preserved one with no kind, which declares nothing), or the same one.
 */
export function contradictingSecurityId(
  printed: SecurityId | null | undefined,
  registered: StoredSecurityId | null | undefined,
): SecurityId | null {
  const declared = declaredSecurityId(registered);
  if (!printed || !declared) return null;
  return sameSecurityId(printed, declared) ? null : declared;
}

/** The identifier as a sentence names it: «ISIN IE00B4L5Y983», «código DGS N5394». */
export function securityIdLabel(id: SecurityId): string {
  return `${SECURITY_ID_KIND_LABEL_INLINE[id.kind]} ${id.value}`;
}

/** Of these holdings, the ones that have exactly this identifier registered. */
export function holdingsRegistering<T extends { securityId?: StoredSecurityId }>(
  printed: SecurityId,
  holdings: readonly T[],
): T[] {
  return holdings.filter((holding) => {
    const declared = declaredSecurityId(holding.securityId);
    return declared !== null && sameSecurityId(declared, printed);
  });
}
