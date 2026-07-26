/**
 * Bounding the headline a model writes on a proposal card (#1246 security review).
 *
 * The `summary` of a proposal is the one field on a confirmation card that comes
 * straight from the model — every other line is assembled from figures the store
 * already holds. It renders as the card's bold title, right next to the button that
 * applies the write, and it is persisted with the proposal. That makes it the most
 * valuable sentence in the product for a successful prompt injection to own: the copy
 * that convinces a person to press confirm.
 *
 * Bounding it does not make the sentence trustworthy — nothing here can — but it
 * stops the two things length alone buys an attacker: a wall of text that pushes the
 * real, deterministic detail of the card off the screen, and an unbounded string
 * persisted per proposal. A summary is a headline; a headline fits in one line.
 *
 * Its own tiny module because the bound belongs to the FIELD, not to any one
 * proposal: correction and reconstruction consume it today, and the next builder that
 * accepts a model-written summary should reach for this instead of re-deciding.
 * `chat-tools.ts` also declares the cap in the tool JSON schema, but that is a hint
 * to the model — `jsonSchema()` is created without a `validate`, so nothing enforces
 * it at the tool boundary. This is where it is enforced.
 */

/**
 * One line on a card. Long enough for a real headline in Spanish («Corrección del
 * saldo de la hipoteca de Casarrubios a 1 de julio»), short enough that it cannot
 * become the card.
 */
export const PROPOSAL_SUMMARY_MAX_CHARS = 140;

/** Marker left where the cap cut, so a truncated headline does not read as finished. */
const TRUNCATION_MARK = "…";

/**
 * The headline to store for a proposal: the model's `summary` when it wrote a usable
 * one, bounded; otherwise the caller's deterministic fallback, which is built from
 * store facts and therefore needs no bound of its own.
 */
export function boundProposalSummary(
  summary: string | undefined,
  fallback: string,
): string {
  const trimmed = summary?.trim();
  if (!trimmed) return fallback;
  return trimmed.length > PROPOSAL_SUMMARY_MAX_CHARS
    ? `${trimmed.slice(0, PROPOSAL_SUMMARY_MAX_CHARS - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`
    : trimmed;
}
