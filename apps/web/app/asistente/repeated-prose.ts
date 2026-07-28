/**
 * The prose a single turn writes twice, printed once (#1317).
 *
 * A turn that prepares a proposal ends up with TWO answers in it, and the reason is
 * structural rather than a bad day for the model: the prompt asks for
 * `suggest_actions` in a step of its OWN, after the answer, and the AI SDK's
 * tool-calling loop keeps going while a step finishes on `tool-calls` — so there is
 * always one more model step after the chips. A model with nothing left to add fills
 * it by restating what it already said, and the panel prints one markdown block per
 * text part, so the reader gets the same two paragraphs above and below the card.
 *
 * The prompt route was already spent on exactly this: «No repitas la misma guía en
 * otro párrafo ni cierres recapitulando lo ya dicho» entered the contract in #1245
 * because a real run repeated its guidance three times over, it is pinned by
 * `system-prompt.test.ts`, and this issue is that rule being broken anyway. So the
 * panel takes it deterministically — the same move #1304 made on the follow-up
 * actions the model insists on writing next to its own tool call: what the reader
 * has already read is not printed again.
 *
 * Only ever REMOVES a repeat, and only when the earlier block says everything the
 * later one does: a block is dropped when an earlier one equals it or STARTS with it.
 * Both directions matter —
 *  - equal covers the verbatim recap this issue is about;
 *  - prefix covers that recap while it is still streaming in, so the duplicate is
 *    never typed out on screen only to vanish once it completes. A block that is a
 *    strict prefix of one already printed carries no word the reader has not read, so
 *    hiding it cannot lose information.
 * Anything the later block ADDS makes it a longer, non-matching block that survives
 * whole: «this was a repeat» must never end up looking like «the assistant had
 * nothing else to say».
 */

/** Blocks are separated by a blank line, the unit markdown itself groups by. */
const BLANK_LINE = /\n[ \t]*\n/;

/**
 * A fenced block may legitimately contain a blank line, so block surgery inside one
 * could separate a fence from its close. Such a text is left exactly as it arrived.
 */
const FENCE = "```";

/** Case- and whitespace-insensitive, so a re-wrapped recap still matches. */
function normalized(block: string): string {
  return block.replace(/\s+/gu, " ").trim().toLocaleLowerCase("es");
}

/**
 * The text parts of ONE assistant turn, in order, with every block that repeats an
 * earlier one taken out. Same length as the input; an entry becomes `""` when the
 * whole part was a repeat, which is the case the reader was seeing twice.
 */
export function withoutRepeatedProse(texts: readonly string[]): string[] {
  const printed: string[] = [];
  return texts.map((text) => {
    if (text.includes(FENCE)) return text;
    const kept = text.split(BLANK_LINE).filter((block) => {
      const candidate = normalized(block);
      if (candidate === "") return false;
      if (printed.some((earlier) => earlier.startsWith(candidate))) return false;
      printed.push(candidate);
      return true;
    });
    return kept.join("\n\n");
  });
}
