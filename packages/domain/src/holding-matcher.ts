/**
 * Multi-key editable holding matcher (PRD #1103 S1, decision #1090).
 *
 * The domain core of the assistant reconcile: given a set of **candidate rows**
 * (extracted from a document or typed) and the **current portfolio**, it decides
 * per row whether to `create` a new holding, `update` an existing one, or `leave`
 * it alone — with the candidates it considered and how confident the match is.
 *
 * It generalizes the ISIN `matched`/`new` bucketing of `propose_statement_import`
 * (see {@link ./statement-import-plan}) to two match keys with distinct strength:
 *
 * - **Strong key** — ISIN (or the provider symbol that plays ISIN's role for
 *   pension plans and crypto, #695): globally unique *as an instrument id*, so an
 *   exact hit resolves the row on its own — **as long as one holding claims it**.
 *   The same instrument held at two brokers is a legitimate, real portfolio (#1331),
 *   and then the key identifies the instrument but not *which* holding: the match is
 *   degraded to review with every claimant offered, never silently resolved.
 * - **Weak key** — normalized name **plus** instrument: two real holdings can
 *   share a name, so an exact hit only *proposes* the best candidate. The
 *   instrument must be compatible (a "fund" row never matches a "current_account"
 *   holding), which is what keeps a coincidental name from silently rewriting the
 *   wrong holding.
 *
 * A weak proposal never blocks: the surface shows it and the user can **reassign**
 * any row (match → new, new → another candidate, discard) through the pure
 * reassignment API below. This diverges on purpose from the anchor gate of #1048,
 * where ambiguity blocks; here it is corrected by hand.
 *
 * Pure and I/O-free (`docs/interaction-patterns.md`): no UI, no persistence, no
 * clock. The caller feeds plain shapes and renders / applies the result.
 */

import type { Instrument } from "./instrument-catalog";
import { normalizeMatchKey, normalizeMatchName } from "./matching-keys";

/** Which key produced a match. `none` is a row that matched nothing. */
export type MatchKey = "isin" | "provider_symbol" | "name" | "none";

/** What the row does to the portfolio. */
export type MatchDecision = "create" | "update" | "leave";

/**
 * How sure the match is. `strong` = a unique key hit (ISIN / provider symbol);
 * `weak` = a name+instrument hit that only proposes; `none` = no candidate.
 */
export type MatchConfidence = "strong" | "weak" | "none";

/**
 * A row the user is reconciling — one extracted document line or one typed
 * holding. Ids are the caller's; the matcher only reads the keys.
 */
export interface MatchCandidateRow {
  /** Stable id for this row within the batch; decisions and edits key on it. */
  rowId: string;
  /** ISIN or another strong identifier the row carries, when it has one. */
  isin?: string | null;
  /**
   * A second strong key: the provider symbol (Finect code / CoinGecko id) that
   * identifies pension plans and crypto, which never carry an ISIN (#695).
   */
  providerSymbol?: string | null;
  /** Display name — the weak-key basis. */
  name?: string | null;
  /** The instrument the row declares — the other half of the weak key. */
  instrument?: Instrument | null;
}

/**
 * A holding in the current portfolio a row can match against. A plain shape (as
 * {@link ./statement-import-plan}'s `StatementPortfolioInvestment`) so the matcher
 * stays decoupled from the agent-view read contract; the caller projects it.
 */
export interface MatchPortfolioHolding {
  /** The holding's id — the `update` target and the candidate identity. */
  holdingId: string;
  /** Display name, used for the weak key and to label candidates in the preview. */
  name: string;
  isin?: string | null;
  providerSymbol?: string | null;
  instrument?: Instrument | null;
  /**
   * The position holds nothing today — fully sold, zero balance (the caller's cheap
   * liveness signal; omit it when unknown). Read ONLY to **rank** the claimants of an
   * ambiguous key (#1331): new movements almost never belong to a holding that was
   * emptied, so a closed position ranks last. Never a gate — a closed holding that
   * uniquely claims the key is still a legitimate, `strong` match target.
   */
  closed?: boolean;
}

/** One existing holding a row could resolve to, ranked best-first. */
export interface MatchCandidate {
  holdingId: string;
  name: string;
  /** The strongest key by which this candidate matched the row. */
  key: MatchKey;
  confidence: MatchConfidence;
}

/**
 * The per-row decision — enough to paint the preview and to tell the apply where
 * to write. `target` is set only when `decision === "update"`.
 */
export interface RowMatch {
  rowId: string;
  /**
   * What the row does to the portfolio. A `weak` `update` is a **proposal**, not a
   * verdict: the apply MUST gate on {@link confidence} and never auto-apply a weak
   * update without user confirmation, or a coincidental name would silently rewrite
   * the wrong holding (the invariant the whole module exists to protect). Only a
   * `strong` update is safe to apply unattended — and a strong key claimed by two
   * holdings is never one: see {@link ambiguous}.
   */
  decision: MatchDecision;
  /** The holding an `update` writes to; absent for `create` / `leave`. */
  target?: string;
  /** Every candidate the matcher found for this row, best-first. */
  candidates: MatchCandidate[];
  /** Confidence of the current decision (a reassignment can lower it). */
  confidence: MatchConfidence;
  /** The key backing the current decision. */
  key: MatchKey;
  /**
   * Set when the row will `create` yet a candidate exists — the informative
   * duplicate warning that underpins the S2 alta ("this looks like one you have").
   * It carries the **best** candidate (strong before weak), so an exact-ISIN
   * duplicate the user chose to create anyway still warns. Never present on an
   * `update` (there the candidate is the target) or a `leave`.
   *
   * {@link matchHoldings} never populates it directly: a fresh match with a
   * candidate defaults to `update`, so the S2 alta derives its create intent by
   * running the row through {@link reassignToNew} and reading this field.
   */
  possibleDuplicate?: MatchCandidate;
  /**
   * The key backing this match hit **more than one** holding, so it identifies the
   * instrument but not the holding (#1331): the same fund at two brokers, or two
   * holdings sharing a name. The decision is a ranked proposal pending review — the
   * surface must say so and the apply must never treat it as resolved. Set only by
   * {@link matchHoldings}; the reassignment API drops it, because picking a candidate
   * by hand *is* the review.
   */
  ambiguous?: boolean;
}

/**
 * Whether a row and a holding declare compatible instruments for a weak match.
 * When both declare one and they differ, they are NOT a match — this is the guard
 * that stops a coincidental name from rewriting the wrong holding. When either
 * side omits its instrument, name alone carries the weak match.
 */
function instrumentsCompatible(
  a: Instrument | null | undefined,
  b: Instrument | null | undefined,
): boolean {
  if (a == null || b == null) return true;
  return a === b;
}

interface StrongIndex {
  byKey: Map<string, MatchPortfolioHolding[]>;
  /** Lowercased provider-symbol index so "Bitcoin" finds "bitcoin" (#695). */
  bySymbolLower: Map<string, MatchPortfolioHolding[]>;
}

/** Append to a multi-map bucket, keeping portfolio order within the key. */
function claim(
  index: Map<string, MatchPortfolioHolding[]>,
  key: string,
  holding: MatchPortfolioHolding,
): void {
  const bucket = index.get(key);
  if (bucket) bucket.push(holding);
  else index.set(key, [holding]);
}

/**
 * Index the portfolio by strong key. **Every** claimant of a key is kept, in
 * portfolio order: a key claimed twice is real (#1331) and the matcher must be able
 * to see it, which first-wins made structurally impossible.
 */
function buildStrongIndex(holdings: MatchPortfolioHolding[]): StrongIndex {
  const byKey = new Map<string, MatchPortfolioHolding[]>();
  const bySymbolLower = new Map<string, MatchPortfolioHolding[]>();
  for (const holding of holdings) {
    const isin = normalizeMatchKey(holding.isin);
    if (isin) claim(byKey, isin, holding);
    const symbol = normalizeMatchKey(holding.providerSymbol);
    if (symbol) {
      claim(byKey, symbol, holding);
      claim(bySymbolLower, symbol.toLowerCase(), holding);
    }
  }
  return { byKey, bySymbolLower };
}

/** Concatenate holding lists, dropping the ids already seen. */
function dedupeById(...lists: MatchPortfolioHolding[][]): MatchPortfolioHolding[] {
  const seen = new Set<string>();
  const merged: MatchPortfolioHolding[] = [];
  for (const holding of lists.flat()) {
    if (seen.has(holding.holdingId)) continue;
    seen.add(holding.holdingId);
    merged.push(holding);
  }
  return merged;
}

/**
 * Every holding a row's strong keys hit, with the key that produced them, or null.
 * ISIN resolves before the provider symbol (an ISIN is the more specific claim); a
 * symbol hit merges the exact-case and lowercased indexes, so "N5115" and "n5115" in
 * the same portfolio are seen as the two claimants they are rather than one.
 */
function findStrongMatches(
  row: MatchCandidateRow,
  index: StrongIndex,
): { holdings: MatchPortfolioHolding[]; key: MatchKey } | null {
  const isin = normalizeMatchKey(row.isin);
  if (isin) {
    const byIsin = index.byKey.get(isin);
    if (byIsin && byIsin.length > 0) return { holdings: byIsin, key: "isin" };
  }
  const symbol = normalizeMatchKey(row.providerSymbol);
  if (symbol) {
    const bySymbol = dedupeById(
      index.byKey.get(symbol) ?? [],
      index.bySymbolLower.get(symbol.toLowerCase()) ?? [],
    );
    if (bySymbol.length > 0) return { holdings: bySymbol, key: "provider_symbol" };
  }
  return null;
}

/**
 * Rank the claimants of an ambiguous strong key, best-first (#1331). Two cheap,
 * honest disambiguators — never a resolution, only an order:
 *
 * 1. the holding whose **name** the row also matches (a document that names the
 *    Cartera Indexada's fund means that one, not the old broker's closed copy) —
 *    deliberately the stronger signal, so a document that names the closed position
 *    resolves to it rather than to a live namesake;
 * 2. among holdings the name cannot tell apart, a **live** position before a `closed`
 *    one (new movements do not belong to a holding that was emptied).
 *
 * Ties keep portfolio order, so the default target is deterministic. `sort` is
 * stable per spec and the input is never mutated.
 */
function rankStrongClaimants(
  row: MatchCandidateRow,
  holdings: MatchPortfolioHolding[],
): MatchPortfolioHolding[] {
  if (holdings.length < 2) return holdings;
  const rowName = normalizeMatchName(row.name);
  const score = (holding: MatchPortfolioHolding): number => {
    const nameMatches =
      rowName !== null &&
      normalizeMatchName(holding.name) === rowName &&
      instrumentsCompatible(row.instrument, holding.instrument);
    return (nameMatches ? 2 : 0) + (holding.closed === true ? 0 : 1);
  };
  return [...holdings].sort((a, b) => score(b) - score(a));
}

/**
 * The weak (name + instrument) hits for a row, in portfolio order. A hit needs an
 * exact normalized-name equality — never a fuzzy/substring match, which is what
 * would resurrect the wrong-holding false positive — and a compatible instrument.
 */
function findWeakMatches(
  row: MatchCandidateRow,
  holdings: MatchPortfolioHolding[],
): MatchPortfolioHolding[] {
  const rowName = normalizeMatchName(row.name);
  if (!rowName) return [];
  return holdings.filter(
    (holding) =>
      normalizeMatchName(holding.name) === rowName &&
      instrumentsCompatible(row.instrument, holding.instrument),
  );
}

function toCandidate(
  holding: MatchPortfolioHolding,
  key: MatchKey,
  confidence: MatchConfidence,
): MatchCandidate {
  return { holdingId: holding.holdingId, name: holding.name, key, confidence };
}

/**
 * Match candidate rows against the current portfolio (PRD #1103 S1).
 *
 * Default decision per row:
 * - a **strong** key hit on exactly one holding → `update` that holding, `strong`;
 * - a strong key hit on **several** holdings → `update` the best-ranked one but
 *   `weak` and `ambiguous`: the key names the instrument, not the holding (#1331);
 * - otherwise a **weak** name+instrument hit → `update` the best candidate,
 *   `weak` (proposed, editable — never blocking), `ambiguous` when several share it;
 * - otherwise → `create`.
 *
 * All candidates found are returned ranked best-first so the surface can offer a
 * reassignment even for a resolved row. A `create` row that still has a weak
 * candidate carries `possibleDuplicate` for the informative alta warning (S2).
 */
export function matchHoldings(
  rows: MatchCandidateRow[],
  holdings: MatchPortfolioHolding[],
): RowMatch[] {
  const index = buildStrongIndex(holdings);

  return rows.map((row) => {
    const strongHit = findStrongMatches(row, index);
    const strong = strongHit
      ? { holdings: rankStrongClaimants(row, strongHit.holdings), key: strongHit.key }
      : null;
    const weak = findWeakMatches(row, holdings);

    // Candidates are ranked strong-first; a strong claimant is deduped out of the
    // weak list so it is not listed twice. Each strong claimant keeps its own key
    // strength — the ISIN really did match it — while the ROW below records that the
    // key did not resolve which one, which is what gates the apply.
    const candidates: MatchCandidate[] = [];
    const strongIds = new Set<string>();
    if (strong) {
      for (const holding of strong.holdings) {
        strongIds.add(holding.holdingId);
        candidates.push(toCandidate(holding, strong.key, "strong"));
      }
    }
    for (const holding of weak) {
      if (strongIds.has(holding.holdingId)) continue;
      candidates.push(toCandidate(holding, "name", "weak"));
    }

    if (strong) {
      const ambiguous = strong.holdings.length > 1;
      return {
        rowId: row.rowId,
        decision: "update",
        target: strong.holdings[0]!.holdingId,
        candidates,
        confidence: ambiguous ? "weak" : "strong",
        key: strong.key,
        ...(ambiguous ? { ambiguous: true } : {}),
      };
    }

    if (weak.length > 0) {
      const best = weak[0]!;
      return {
        rowId: row.rowId,
        decision: "update",
        target: best.holdingId,
        candidates,
        confidence: "weak",
        key: "name",
        ...(weak.length > 1 ? { ambiguous: true } : {}),
      };
    }

    return {
      rowId: row.rowId,
      decision: "create",
      candidates,
      confidence: "none",
      key: "none",
    };
  });
}

/**
 * How many holdings claim the key backing this match — more than one exactly when
 * the match is {@link RowMatch.ambiguous}. The surface reads it to say *how many* the
 * user is choosing between; 0 for a row that matched nothing.
 */
export function countKeyClaimants(match: RowMatch): number {
  return match.candidates.filter((candidate) => candidate.key === match.key).length;
}

/**
 * The best candidate on a match, if any — the duplicate-warning source. Candidates
 * are ranked strong-before-weak, so this is the strongest duplicate: creating over
 * an exact-ISIN hit warns just as loudly as over a name coincidence.
 */
function bestDuplicateOf(match: RowMatch): MatchCandidate | undefined {
  return match.candidates[0];
}

/**
 * Reassign a row to `create` a new holding (match → new). The candidates are kept
 * so the user can change their mind; a surviving candidate becomes the informative
 * `possibleDuplicate`. Returns a new object — never mutates.
 */
export function reassignToNew(match: RowMatch): RowMatch {
  const duplicate = bestDuplicateOf(match);
  return {
    rowId: match.rowId,
    decision: "create",
    candidates: match.candidates,
    confidence: "none",
    key: "none",
    ...(duplicate ? { possibleDuplicate: duplicate } : {}),
  };
}

/**
 * Reassign a row to `update` a specific candidate (new → match, or match → a
 * different candidate). Throws when the holding is not among the row's candidates
 * — a reassignment must name a candidate the matcher actually surfaced, so a typo
 * can never silently target an unrelated holding. Returns a new object.
 */
export function reassignToCandidate(match: RowMatch, holdingId: string): RowMatch {
  const candidate = match.candidates.find((entry) => entry.holdingId === holdingId);
  if (!candidate) {
    throw new Error(
      `Cannot reassign row ${match.rowId} to holding ${holdingId}: not a candidate.`,
    );
  }
  return {
    rowId: match.rowId,
    decision: "update",
    target: candidate.holdingId,
    candidates: match.candidates,
    confidence: candidate.confidence,
    key: candidate.key,
  };
}

/**
 * Discard a row (`leave`) — it does nothing to the portfolio. Candidates are kept
 * so the user can bring it back. Returns a new object.
 */
export function discardRow(match: RowMatch): RowMatch {
  return {
    rowId: match.rowId,
    decision: "leave",
    candidates: match.candidates,
    confidence: "none",
    key: "none",
  };
}
