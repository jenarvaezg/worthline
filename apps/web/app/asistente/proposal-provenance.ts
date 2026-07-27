/**
 * The provenance stamp on a proposal card (#1257, security review of #1246).
 *
 * Preview-and-confirm is the LAST defence of every assistant write: the change
 * only happens from a card, and the card has a button a person presses. That
 * ceremony is worth exactly as much as the text around the button is trustworthy
 * — and the bold headline of the card is the one line the model writes
 * (`summary`). Under a successful injection (malicious text inside a document the
 * model is describing) the attacker chooses that headline, and «Ajuste detectado
 * por worthline en tu hipoteca» next to a button that really writes turns the
 * confirmation into a phishing surface. #1246 bounded the headline's LENGTH, which
 * was the cheap half.
 *
 * This is the other half: when the proposal was born in a turn carrying evidence
 * worthline could not validate, the card SAYS SO — and it says so because the
 * server stamped it, not because the model agreed to mention it. The whole point
 * is that the signal is derived, so it is stamped on the tool output (which the
 * server builds) and read back by key (never by looking at prose). The model can
 * neither write the mark nor suppress it.
 *
 * NOT the same thing as decision 4 of the PRD #1241 grilling («the provenance mark
 * dies in the preview»). That decision is about PERSISTENCE: confirming writes
 * `source: "agent"` and nothing else, because a yes has no degrees. This is a
 * PRESENTATION signal, alive only while the proposal is unconfirmed — it travels
 * on the tool output and is never written to the store. They do not contradict.
 */

import { consumesUnvalidatedEvidenceBudget } from "./unvalidated-evidence-gate";

/**
 * The word label, so the mark never depends on colour alone (canon §6: oro =
 * aviso, but the words carry the meaning).
 */
export const UNVALIDATED_PROVENANCE_LABEL = "Procedencia";

/**
 * What the card says. It speaks about the TURN, which is what the server knows:
 * a proposal prepared alongside a file worthline could not read as data. Claiming
 * anything about the proposal's own contents would be a guess — hence the ask,
 * which is the only useful action here: check the figures against your document
 * before pressing confirm.
 *
 * First person, like the rest of worthline's voice in the assistant (see
 * `UNVALIDATED_EVIDENCE_MESSAGE`), and «un archivo» deliberately neutral: a
 * spreadsheet, a PDF and a screenshot all open this door (#1246).
 */
export const UNVALIDATED_PROVENANCE_NOTE =
  "Preparada en un mensaje con un archivo que no he podido validar. Comprueba cada " +
  "dato contra tu documento antes de confirmar.";

/**
 * The key the mark travels under, spelled exactly like the flag the chat route
 * derives (#1248) so both ends of the wire share one noun.
 */
const PROVENANCE_FIELD = "unvalidatedEvidence";

/**
 * Stamp a tool result whose turn carried unvalidated evidence.
 *
 * A no-op for anything that is not a prepared proposal — an error envelope has no
 * card to mark. Returns a new object, so the proposal the store already persisted
 * is untouched: the mark exists only on the copy that travels to the client.
 */
export function withUnvalidatedProvenance<T>(result: T): T {
  if (!consumesUnvalidatedEvidenceBudget(result)) return result;
  return { ...(result as object), [PROVENANCE_FIELD]: true } as T;
}

/**
 * Whether a proposal tool's output carries the mark.
 *
 * Reads the KEY, and only the boolean `true`: this is the property that makes the
 * mark unforgeable from prose. It is asked of the raw tool output rather than of
 * the parsed proposal because every parser rebuilds its own typed shape and drops
 * unknown fields — so the answer has to be read where the server wrote it.
 */
export function hasUnvalidatedProvenance(output: unknown): boolean {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return false;
  }
  return (output as Record<string, unknown>)[PROVENANCE_FIELD] === true;
}
