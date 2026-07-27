/**
 * The turn where the model FAKES the proposal ceremony (#1262).
 *
 * Observed in production: without calling a single tool, the assistant wrote «He
 * preparado la propuesta de corrección para actualizar el saldo a 5.511,96 €»,
 * painted a bulleted list that looks like a card, and asked for confirmation. No
 * card was ever rendered. The user answered «Confirmo» twice and nothing was
 * written — while believing the opposite, with a figure in their head that came
 * from nowhere.
 *
 * The whole safety model of assistant writes rests on ONE thing: the confirmation
 * lives in the card, and the card is emitted by the server (PRD #1241, decision 2).
 * A believable prose imitation of it is therefore not a cosmetic problem.
 *
 * Why this is code and not a prompt rule: the PRD's principle is that no guarantee
 * depends on the prompt, and its sibling case proves the point — the
 * `propose_reconstruction` instruction was narrowed in #1243 and the model kept
 * offering it anyway. What the app knows for certain is which tools the turn
 * called, so «do not claim a proposal you never asked for» is checkable.
 *
 * Where it runs, in two places, because the lie has two audiences:
 *
 *  - At RENDER, the same seam #1246 used to close the image-exfiltration sink. The
 *    harm is a belief in the user's head, so the place to intervene is the moment
 *    the belief forms — and rendering also covers a fabrication read back from
 *    history, which a check on the live stream would not.
 *  - In the HISTORY the model gets back, via {@link FABRICATED_PROPOSAL_MODEL_NOTE}.
 *    Without it the fabricated sentence is the model's own context next turn, and
 *    the observed failure mode is doubling down: «como te decía, la propuesta está
 *    preparada». Contradicting the user's screen while leaving the model's memory
 *    intact fixes half the problem.
 */

import type { UIMessage } from "ai";

import { isProposalToolPart } from "./tool-parts";

/**
 * What the app says next to a faked ceremony.
 *
 * Written so it is TRUE whenever it appears, even on a false positive: it speaks
 * about THIS message, never about whether some proposal exists somewhere. A real
 * card from an earlier turn is still on screen with its own button, so «here there
 * is nothing to confirm» stays accurate.
 */
export const FABRICATED_PROPOSAL_NOTE =
  "Este mensaje no lleva ninguna propuesta. En worthline un cambio solo se aplica " +
  "desde la tarjeta de su propuesta, con su botón: escribir «confirmo» en el chat " +
  "no aplica nada. Si no ves ninguna tarjeta, no hay nada preparado y tendrás que " +
  "volver a pedírselo.";

/**
 * What the model is told about its own previous turn, in the history it gets back.
 *
 * A statement of fact and NOTHING else, framed like the other history repairs
 * (#1260). It used to end with «si hace falta, llama a la tool ahora», and review
 * was right that this was the worst line in the change: an instruction on the write
 * path, fired by a text heuristic, is how a regex match turns into a duplicate
 * proposal. The prompt is where behaviour rules go — and this file exists because
 * those did not hold.
 */
export const FABRICATED_PROPOSAL_MODEL_NOTE =
  "(En ese turno no llamaste a ninguna tool propose_*, así que no se preparó ninguna " +
  "propuesta nueva y el usuario no vio ninguna tarjeta nueva.)";

/**
 * Assertions that the proposal ALREADY exists. Deliberately only the perfect and
 * preterite forms: Spanish uses the present to OFFER («te preparo la propuesta»,
 * «puedo preparar una»), which is the honest turn and by far the more common one.
 * Flagging those would put a note on the path that works.
 */
const CLAIM_PATTERNS = [
  // «he preparado», «te he creado», «hemos dejado preparada», «preparé».
  /\b(he|hemos)\b[^.!?]{0,30}\b(preparado|creado|generado|elaborado|montado|dejado)\b/i,
  // No trailing \b: JS word boundaries do not see «é» as a word character, so
  // «preparé» would never close one. And only the ACCENTED forms — unaccented
  // «prepare» is the subjunctive of an offer («¿quieres que prepare una?»).
  /\b(preparé|creé|dejé)/i,
  // Handing it over — «aquí tienes la propuesta», «ya tienes la propuesta». The
  // proposal has to be WHAT is handed over: «aquí tienes las opciones antes de
  // montar una propuesta» is an offer, and review caught it being flagged.
  /\b(aqu[íi]|ya) tienes\b[^.!?]{0,25}\bpropuestas?\b/i,
  // «La propuesta está lista» — the same assertion without the first person.
  /\bpropuestas?\b[^.!?]{0,40}\b(est[áa]|queda)\s+(lista|preparada|creada|hecha)\b/i,
];

/**
 * A claim the model NEGATES is not a claim. Review found the case that matters:
 * «Tienes razón: no he preparado la propuesta» is precisely the turn the model
 * produces after reading {@link FABRICATED_PROPOSAL_MODEL_NOTE}, so without this
 * the two seams feed each other — the history note provokes the sentence that
 * trips the screen note, on every turn, for the rest of the conversation.
 */
const NEGATION = /\b(no|nunca|tampoco)\b/i;

const PROPOSAL_WORD = /\bpropuestas?\b/i;

/**
 * Splits into sentences so a claim and the word «propuesta» must occur TOGETHER.
 * Without that, «He creado el holding» in one sentence plus «¿quieres que prepare
 * una propuesta?» in the next would read as a fabrication.
 *
 * Decimals are masked first: a figure like «5.511,96» would otherwise cut the very
 * sentence this exists to read.
 */
function sentences(text: string): string[] {
  return text.replace(/(\d)\.(\d)/g, "$1·$2").split(/[.!?\n]+/);
}

/**
 * Does this text assert that a proposal has been prepared?
 *
 * Scope, stated plainly: it reads the ceremony's own vocabulary («propuesta»). A
 * model that claimed «he dejado listo el registro de la amortización» without ever
 * naming a proposal would slip through. Widening it is a decision to take with
 * measured cases (#1254), not by guessing at synonyms — the cost of guessing is
 * notes on honest turns, and those are what teach a user to ignore notes.
 */
export function claimsPreparedProposal(text: string): boolean {
  return sentences(text).some((sentence) => {
    if (!PROPOSAL_WORD.test(sentence)) return false;
    return CLAIM_PATTERNS.some((pattern) => {
      const match = pattern.exec(sentence);
      return match !== null && !NEGATION.test(sentence.slice(0, match.index));
    });
  });
}

/**
 * THE decision, in one place: an assistant turn that claims a prepared proposal
 * and carries no proposal part.
 *
 * Exported because both audiences ask the same question — the panel to print the
 * warning, the route to correct the model's history — and a second copy of this
 * rule would let the two drift apart in silence the day it is widened (#1254).
 */
export function isFabricatedProposalTurn(message: UIMessage): boolean {
  if (message.role !== "assistant") return false;
  if (message.parts.some(isProposalToolPart)) return false;
  return claimsPreparedProposal(
    message.parts
      .filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text)
      .join("\n"),
  );
}

/**
 * The ids of the assistant turns that claim a proposal they never asked for.
 *
 * The in-flight message is left alone while the turn streams: prose can land
 * before the tool call within one turn, so judging it early would flash an
 * accusation and then withdraw it — worse than being one moment late. That rule
 * belongs to the screen only; the history the model gets back is never in flight.
 */
export function messagesWithFabricatedProposal(
  messages: UIMessage[],
  streaming: boolean,
): ReadonlySet<string> {
  return new Set(
    messages
      .filter(
        (message, index) =>
          !(streaming && index === messages.length - 1) &&
          isFabricatedProposalTurn(message),
      )
      .map((message) => message.id),
  );
}
