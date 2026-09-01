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
 * What it knows even better — and what this file asks since #1468 — is whether a CARD
 * was painted. Asking about the call instead switched the guard off precisely when the
 * call failed: a rejected `propose_operation` counted as a proposal, so the turn that
 * tried, was refused, and narrated success anyway got no warning at all. The question
 * now comes from {@link rendersProposalCard}, off the same table the render reads.
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

import { assertedInAnySentence, PAYMENT_CARD_READING } from "./claim-sentences";
import {
  fabricatedCeremonyGuard,
  messagesWithFabricatedCeremony,
} from "./fabricated-ceremony";
import { rendersProposalCard } from "./proposal-card-presence";
import { isProposalToolName, toolPartName } from "./tool-parts";

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
 * The same note when the turn DID ask worthline for the proposal and got nothing back
 * (#1468, point 4).
 *
 * Until now a rejection was context for the model and nothing else: if it chose to
 * narrate another story, the user never learnt that worthline had said no, and reading
 * «vuelve a pedírselo» they would ask for the very same thing again. So the note says
 * that much — and deliberately NOT what the rejection said: several of those messages
 * are written at the model («y tú pasas 6 participaciones») and reading them on screen
 * confuses more than it explains. Telling those apart from the ones that route the user
 * is a separate job.
 *
 * True in every case it can appear, like its sibling — and NOTHING about what worthline
 * stored: the `propose_*` tools persist before returning, so «no recibió ninguna
 * tarjeta» is the most the screen can honestly assert about a call that was cut off
 * (ADR 0048).
 */
export const NO_PROPOSAL_RETURNED_NOTE =
  "Este mensaje no lleva ninguna propuesta: el asistente pidió una a worthline y no " +
  "recibió ninguna tarjeta que mostrarte. Un cambio solo se aplica desde la tarjeta de " +
  "su propuesta, con su botón: escribir «confirmo» en el chat no aplica nada. Tendrás " +
  "que volver a pedírselo, quizá de otra forma.";

/**
 * What the model is told about its own previous turn, in the history it gets back.
 *
 * A statement of fact and NOTHING else, framed like the other history repairs
 * (#1260). It used to end with «si hace falta, llama a la tool ahora», and review
 * was right that this was the worst line in the change: an instruction on the write
 * path, fired by a text heuristic, is how a regex match turns into a duplicate
 * proposal. The prompt is where behaviour rules go — and this file exists because
 * those did not hold.
 *
 * It used to open «no llamaste a ninguna tool propose_*», which stopped being true when
 * #1468 widened the guard to the turn that DID call one and was rejected. The fact that
 * holds for both — and the only one the user's screen agrees with — is that no lane
 * returned a proposal, so that is what it says now.
 */
export const FABRICATED_PROPOSAL_MODEL_NOTE =
  "(En ese turno ninguna tool propose_* devolvió una propuesta, así que no se preparó " +
  "ninguna propuesta nueva y el usuario no vio ninguna tarjeta nueva.)";

/**
 * Assertions that the proposal ALREADY exists. Deliberately only the perfect and
 * preterite forms: Spanish uses the present to OFFER («te preparo la propuesta»,
 * «puedo preparar una»), which is the honest turn and by far the more common one.
 * Flagging those would put a note on the path that works.
 */
const CLAIM_PATTERNS = [
  // «he preparado», «te he creado», «hemos dejado preparada», «preparé». The
  // second alternation gained ajustado/corregido/actualizado/rectificado from a
  // measured run (#1327): «estas son las propuestas … que hemos ajustado» looped
  // for five turns without a card and without tripping this. In the turn that
  // DOES carry the corrected card, the proposal-part check skips it anyway.
  /\b(he|hemos)\b[^.!?]{0,30}\b(preparado|creado|generado|elaborado|montado|dejado|ajustado|corregido|actualizado|rectificado)\b/i,
  // No trailing \b: JS word boundaries do not see «é» as a word character, so
  // «preparé» would never close one. And only the ACCENTED forms — unaccented
  // «prepare» is the subjunctive of an offer («¿quieres que prepare una?»).
  /\b(preparé|creé|dejé)/i,
  // Handing it over — «aquí tienes la propuesta», «ya tienes la propuesta», and
  // «a continuación tienes las tarjetas», the delivery form Jorge's turn used
  // (#1468). The proposal has to be WHAT is handed over: «aquí tienes las opciones
  // antes de montar una propuesta» is an offer, and review caught it being flagged.
  /\b(a continuaci[óo]n|aqu[íi]|ya) tienes\b[^.!?]{0,25}\b(propuestas?|tarjetas?)\b/i,
  // «La propuesta está lista» — the same assertion without the first person.
  /\bpropuestas?\b[^.!?]{0,40}\b(est[áa]|queda)\s+(lista|preparada|creada|hecha)\b/i,
];

/**
 * The ceremony faked WITHOUT the word «propuesta» — the widening the scope note
 * below reserved for measured cases, and #1327 measured them: a real run painted
 * card-shaped prose fichas («ISIN: … · Valor a registrar: … · Estado: Preparado
 * para alta.») and claimed «el segundo registro está listo», turn after turn,
 * with no card in sight. These carry their own noun, so they skip the
 * {@link PROPOSAL_WORD} gate; the negation guard still applies. The vocabulary
 * stays deliberately narrow — a status label and «registro listo/preparado» —
 * because the note's cost model (true even on a false positive) buys width, not
 * a blank cheque.
 */
const SELF_CONTAINED_CLAIM_PATTERNS = [
  // «Estado: Preparado para alta» — the status line of a prose-imitated card.
  /\bestado\s*:\s*preparad/i,
  // «el segundo registro está listo», «el registro queda preparado».
  /\bregistros?\b[^.!?]{0,40}\b(est[áa]|queda)\s+(list[oa]s?|preparad[oa]s?)\b/i,
];

/**
 * The ceremony's own nouns. «tarjeta» joined «propuesta» from a measured case (#1468):
 * Jorge's turn used it as the noun of delivery — «A continuación tienes las tarjetas
 * para confirmar cada uno de estos movimientos» — which is the app's own word for the
 * one place a change can be confirmed, so a claim about one is a claim about the
 * ceremony. Still the module's rule: widened with cases that happened, never by
 * guessing at synonyms.
 */
const PROPOSAL_WORD = /\b(propuestas?|tarjetas?)\b/i;

/**
 * Does this text assert that a proposal has been prepared?
 *
 * Scope, stated plainly: it reads the ceremony's own vocabulary — «propuesta» and
 * «tarjeta» for the gated patterns, plus the two prose-ficha shapes a measured run
 * used to dodge it (#1327: «Estado: Preparado para alta», «el registro está listo»).
 * Widening further remains a decision to take with measured cases, not by
 * guessing at synonyms — the cost of guessing is notes on honest turns, and
 * those are what teach a user to ignore notes.
 */
export function claimsPreparedProposal(text: string): boolean {
  return assertedInAnySentence(
    text.replace(PAYMENT_CARD_READING, "medio de pago"),
    (sentence) =>
      PROPOSAL_WORD.test(sentence)
        ? [...CLAIM_PATTERNS, ...SELF_CONTAINED_CLAIM_PATTERNS]
        : SELF_CONTAINED_CLAIM_PATTERNS,
  );
}

/**
 * How a turn came to claim a proposal nobody can confirm (#1468). The screen shows the
 * same emptiness in all three, but they are not the same fact:
 *
 *  - `no-call`: the ceremony was invented outright, no lane was ever asked — the
 *    original case (#1262).
 *  - `rejected`: a `propose_*` lane answered and its answer carried no proposal. This
 *    is Jorge's turn: worthline said no and the prose announced success anyway.
 *  - `interrupted`: a lane was asked and never answered. Told apart from `rejected`
 *    because the `propose_*` tools persist BEFORE returning, so a proposal may well
 *    exist server-side — the history repair says so in its own words and this one must
 *    not contradict it (`INTERRUPTED_PROPOSAL_NOTE`).
 */
export type FabricatedProposalKind = "no-call" | "rejected" | "interrupted";

/**
 * THE decision, in one place: an assistant turn that claims a prepared proposal while
 * NO card was painted in it.
 *
 * Exported because both audiences ask the same question — the panel to print the
 * warning, the route to correct the model's history — and a second copy of this
 * rule would let the two drift apart in silence the day it is widened (#1254).
 *
 * The card question is {@link rendersProposalCard}'s, off the render's own table: a
 * `propose_*` part whose output no parser recognises painted nothing, so it cannot
 * excuse the claim. Whether the lane was CALLED still matters, but only to choose
 * which sentence the user reads — which is exactly the split
 * {@link fabricatedCeremonyGuard} enforces since #1697, so the reading can no longer
 * slide back to «a `propose_*` part was there».
 */
export const fabricatedProposalIn: (message: UIMessage) => FabricatedProposalKind | null =
  fabricatedCeremonyGuard<FabricatedProposalKind>({
    claims: claimsPreparedProposal,
    delivers: rendersProposalCard,
    interrupted: "interrupted",
    lanes: (part) => isProposalToolName(toolPartName(part)),
    never: "no-call",
    rejected: "rejected",
  });

/**
 * What the app says next to a fabricated ceremony.
 *
 * Two sentences for three kinds on purpose: what the user can DO differs between «it
 * was never asked» and «it was asked and nothing came back», and not between the two
 * ways nothing came back — on screen those are the same empty space.
 */
export function fabricatedProposalNote(kind: FabricatedProposalKind): string {
  return kind === "no-call" ? FABRICATED_PROPOSAL_NOTE : NO_PROPOSAL_RETURNED_NOTE;
}

/**
 * The assistant turns that claim a proposal nobody prepared, by id, each with the
 * kind of fabrication it committed.
 *
 * The streaming exemption — the in-flight message is left alone while it streams — is
 * {@link messagesWithFabricatedCeremony}'s, shared with the alert guard since #1697.
 */
export function messagesWithFabricatedProposal(
  messages: UIMessage[],
  streaming: boolean,
): ReadonlyMap<string, FabricatedProposalKind> {
  return messagesWithFabricatedCeremony(messages, streaming, fabricatedProposalIn);
}
