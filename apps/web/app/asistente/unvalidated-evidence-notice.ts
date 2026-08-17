/**
 * The app saying out loud what the evidence gate did (#1418).
 *
 * The gate has always produced honest copy ({@link UNVALIDATED_EVIDENCE_MESSAGE}), and
 * until now only the MODEL read it — as a tool result, which it paraphrases, softens or
 * ignores. In the conversation that filed this ticket it took five turns to reach the
 * user at all, and in between he did the manual work we had just made impossible: he
 * pasted 360 months of balances into a lane that could not accept them.
 *
 * So the app prints it, from facts the app itself holds, exactly like the
 * fabricated-ceremony note (#1262) this is modelled on: same «Aviso de worthline» frame,
 * same reason — a guarantee cannot depend on the model agreeing to mention it.
 *
 * TWO notes, because there are two moments and the second is the one the ticket is named
 * after:
 *
 *  - **The door shut.** Printed under the card that shut it, which is the earliest
 *    honest moment — BEFORE the user does the work, not after a tool refuses. Anchoring
 *    it to a refusal would miss the turn that filed this ticket entirely: the prompt
 *    tells the model not to offer a bulk import, so an obedient model never calls, is
 *    never refused, and nothing would ever be said.
 *  - **You wrote it and I could not read it.** Printed under the turn where that
 *    refusal happened, because worthline cannot know it until the user has written
 *    something and the parser has failed on it.
 *
 * Each ONCE per conversation. Repeating either turns the boundary into a telling-off,
 * and neither fact changes between two turns of the same thread.
 */

import type { UIMessage } from "ai";

import { messageWithUnstructuredEvidence } from "./attachment-chat";
import { unreadableTypedSeriesRejected } from "./unvalidated-evidence-gate";

/**
 * What the app says when the door shuts. True for every lane that can refuse — an
 * import, a reconcile, a reconstruction — so it speaks about the file and the routes,
 * never about which tool the model happened to call.
 *
 * It names BOTH ways out, in the order that costs the user least. First the door #1418
 * opened, because they are already standing in the chat and it needs no second upload.
 * Then the deterministic importer, by its two tabs (#1406, ADR 0071): «Operaciones» for
 * positions and movements, «Cuadro de amortización» for the bank's schedule. Naming the
 * tab matters — before #1406 that door only had the operations reader, so sending a
 * mortgage schedule there was sending someone to a door that did not open.
 */
export const UNVALIDATED_EVIDENCE_NOTE =
  "Ese archivo no lo he podido leer como tabla, así que de él no puedo llevar nada en " +
  "bloque al patrimonio — y repetir sus datos en el chat tampoco lo consigue, con una " +
  "excepción: el histórico de saldos de una deuda. Ese escríbemelo aquí, una línea por " +
  "fecha con la fecha y el saldo, y lo leo yo de tu mensaje. Y para cargar un documento " +
  "entero el camino es /patrimonio/importar-extracto: la pestaña «Operaciones» para " +
  "posiciones y movimientos, y «Cuadro de amortización» para el cuadro del banco.";

/**
 * What the app says when the user DID write the series and worthline could not read it.
 *
 * Its whole job is to not be the note above. «Escríbeme las fechas y los saldos» said to
 * someone who has just written them is the failure this ticket is named after, so this
 * one confirms the attempt, keeps the work alive, and names the two things that break a
 * real paste. The precise shape lives in the tool's own refusal, which the model relays
 * next to this; here it is enough that the user knows worthline tried and why nothing
 * appeared.
 *
 * The schedule tab is offered LAST, for the same reason it is last in the tool's copy:
 * it is a real alternative since #1406, and leading with it would answer «I could not
 * read what you wrote» with «upload a file instead».
 */
export const UNREADABLE_TYPED_SERIES_NOTE =
  "He leído tu mensaje buscando la serie de saldos y no he sabido interpretarla, así " +
  "que no hay ninguna tarjeta que confirmar. No has perdido el trabajo: con una línea " +
  "por fecha —solo la fecha y el saldo pendiente— la leo. Lo que no puedo resolver es " +
  "un saldo que suba de una fecha a la siguiente, ni dos cifras distintas para la " +
  "misma fecha. Y si prefieres no reescribirlo, el cuadro del banco entero entra por " +
  "/patrimonio/importar-extracto, pestaña «Cuadro de amortización».";

/**
 * The envelope the second note answers to, read off the gate itself so the two can never
 * drift apart.
 */
const UNREADABLE_SERIES_ERROR: string = unreadableTypedSeriesRejected().error;

/**
 * Whether a tool output is the «I could not read what you wrote» refusal.
 *
 * Reads the KEY the server wrote, never prose — the same rule as the provenance mark
 * (#1257): what the app asserts about a turn has to come from what the app emitted.
 */
export function isUnreadableTypedSeriesRefusal(output: unknown): boolean {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return false;
  }
  return (output as Record<string, unknown>)["error"] === UNREADABLE_SERIES_ERROR;
}

/**
 * Which message carries which note — the whole decision, in one place, over the whole
 * thread because both notes are once-per-conversation.
 *
 * Neither is filtered by streaming state, unlike the fabricated-proposal note: that one
 * reads prose that may still be arriving, these read a card and a finished tool result
 * the server produced. There is nothing to withdraw a moment later.
 */
export interface UnvalidatedEvidenceNotices {
  /** Where «the door shut» goes, or `null` when it never did. */
  gateClosed: string | null;
  /** Where «you wrote it and I could not read it» goes, or `null`. */
  unreadableSeries: string | null;
}

export function unvalidatedEvidenceNotices(
  messages: readonly UIMessage[],
): UnvalidatedEvidenceNotices {
  const refused = messages.find(
    (message) =>
      message.role === "assistant" &&
      message.parts.some(
        (part) => "output" in part && isUnreadableTypedSeriesRefusal(part.output),
      ),
  );
  return {
    gateClosed: messageWithUnstructuredEvidence(messages),
    unreadableSeries: refused?.id ?? null,
  };
}
