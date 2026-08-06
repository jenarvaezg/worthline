import { normalizeSearchText } from "@web/agent-view/holding-search";

/**
 * The holding a chip's `holding` field NAMES, when it is a name and not an id (#1375).
 *
 * `suggest_actions` documents a `wl_hld_…`, and the model keeps sending the holding's
 * label instead — `holding: «N5396 - Myinvestor Indexado Global PP»`. That was dropped
 * in silence, which left the turn with zero chips and its prose block with nothing to
 * match against. Naming the holding is what the model is actually trying to do, so the
 * app does the lookup rather than the model doing bookkeeping.
 *
 * The frontier of #1289 does not move: this resolves a name to a holding that EXISTS,
 * and the href is still built by `sourceHref` from a public id. Nothing here can point
 * at a surface the typed chip channel could not already reach.
 *
 * Unambiguous or nothing. A chip is a link the user will click, so «probably this one»
 * is not good enough, and the lookup it runs on (`find_holdings`) is an UNANCHORED
 * substring match: left as «one match wins», `holding: "e"` opens whichever holding
 * happens to have an e in it, under a label the model wrote. So a name that is not the
 * label itself has to be a word of it, and long enough to be a word at all.
 */

/** Longest `holding` reference worth looking up; also bounds the tool's own schema. */
export const MAX_HOLDING_REFERENCE = 120;

/**
 * Shortest fragment that may stand for a name it is not equal to. Two characters
 * match half a portfolio by accident; «oro», «pp2» or «BTC» are real names.
 */
const MIN_FRAGMENT = 3;

/** Quotes the model wraps a name in; never part of a stored label. */
const WRAPPING_QUOTES = /^[\s«"'`“”‘’]+|[\s»"'`“”‘’.,;:]+$/g;

/** A whole name inside square brackets: the model writes markdown all day. */
const BRACKETED = /^\[([^[\]]+)\]$/;

/** One holding the lookup returned, narrowed to what picking one needs. */
export interface NamedHoldingCandidate {
  /** The public `wl_hld_…` id. */
  id: string;
  label: string;
  /**
   * Which field the query hit. A hit on the ISIN or the price symbol is an
   * identifier, not a fragment of prose, so it is not held to the word rule.
   */
  matchedOn?: "label" | "providerSymbol" | "isin";
}

/**
 * The text to search for, or null when the reference carries no name worth looking
 * up. The guillemets the model copies from its own prose («…») are stripped: they are
 * part of how it quotes a label, never part of the label, and a substring search
 * keeps them. So is a BALANCED pair of square brackets, which is how the same model
 * quotes anything. Stray punctuation is not — «Cartera Metal (2024)» is a name
 * someone typed, and eating its closer turns a hit into a miss.
 */
export function holdingLookupQuery(reference: string): string | null {
  if (reference.length > MAX_HOLDING_REFERENCE) return null;
  const unquoted = reference.replace(/[\t\n\r]+/g, " ").replace(WRAPPING_QUOTES, "");
  const cleaned = (BRACKETED.exec(unquoted)?.[1] ?? unquoted).replace(
    WRAPPING_QUOTES,
    "",
  );
  return normalizeSearchText(cleaned).length === 0 ? null : cleaned.trim();
}

/**
 * The one holding these candidates identify, or null when the name is ambiguous.
 *
 * An exact label wins over the substring matches around it — «Fondo» is ambiguous
 * between «Fondo A» and «Fondo B», but a holding literally called «Fondo» is the one
 * meant, at any length. Two holdings sharing that exact label are ambiguous again:
 * worthline does not forbid the repeated name, so the tie is real and unbreakable
 * from a label alone.
 */
export function pickNamedHolding(
  query: string,
  candidates: readonly NamedHoldingCandidate[],
  options: { truncated: boolean } = { truncated: false },
): string | null {
  // A capped page is not the whole set, so «only one holding is called this» is a
  // claim it cannot support: the twin that would make it ambiguous may have fallen
  // off the cut. Checked BEFORE the exact pass for that reason.
  if (options.truncated) return null;

  const wanted = normalizeSearchText(query);
  const exact = candidates.filter(
    (candidate) => normalizeSearchText(candidate.label) === wanted,
  );
  if (exact.length === 1) return exact[0]?.id ?? null;
  if (exact.length > 1) return null;

  if (wanted.length < MIN_FRAGMENT) return null;

  const named = candidates.filter((candidate) => namesHolding(wanted, candidate));
  return named.length === 1 ? (named[0]?.id ?? null) : null;
}

/**
 * Does this query name the holding, rather than merely occur inside it? A word of the
 * label counts («Myinvestor» for «N5396 - Myinvestor Indexado Global PP»); a fragment
 * of a word does not («vest» for the same holding, «ond» for «Fondo A»).
 */
function namesHolding(wanted: string, candidate: NamedHoldingCandidate): boolean {
  if (candidate.matchedOn !== undefined && candidate.matchedOn !== "label") return true;
  const label = normalizeSearchText(candidate.label);
  let at = label.indexOf(wanted);
  while (at !== -1) {
    if (at === 0 || /[^\p{L}\p{N}]/u.test(label[at - 1] ?? "")) return true;
    at = label.indexOf(wanted, at + 1);
  }
  return false;
}
