/**
 * The link a search candidate becomes (#597, extracted in #1746).
 *
 * Picking a candidate is a plain NAVIGATION, not a client-side write: the href
 * carries the typed state of the whole alta plus the candidate's own fields as
 * `pf*` params, which the form reads as defaults. Two searches now build that link
 * — the symbol box and the plan's «Buscar plan» (variante A de #1669) — so the rule
 * lives here rather than in whichever of them was written first.
 */

import type { AddHoldingSearchParams } from "./search-state";

/** What a picked candidate prefills. `provider` is the price source, not an id. */
export interface SymbolPrefillCandidate {
  symbol: string;
  name: string;
  provider: string;
  isin?: string | undefined;
}

export function symbolPrefillHref({
  basePath,
  candidate,
  preservedParams,
  query,
}: {
  basePath: string;
  candidate: SymbolPrefillCandidate;
  /** The alta's own state to carry across the navigation (typed values, drawer). */
  preservedParams: AddHoldingSearchParams;
  /**
   * The search box's query, when the box owns one (`symbolq`). The plan's search
   * has none: its query IS the identifier field, which travels as its own value.
   */
  query?: string | undefined;
}): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(preservedParams)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      value.forEach((item) => params.append(key, item));
    } else {
      params.set(key, value);
    }
  }

  if (query) params.set("symbolq", query);
  params.set("pfName", candidate.name);
  params.set("pfSymbol", candidate.symbol);
  params.set("pfProvider", candidate.provider);
  if (candidate.isin) params.set("pfIsin", candidate.isin);

  return `${basePath}?${params.toString()}`;
}
