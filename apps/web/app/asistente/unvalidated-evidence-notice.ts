/**
 * The app saying out loud that the evidence gate closed a door (#1418).
 *
 * The gate has always produced an honest message ({@link UNVALIDATED_EVIDENCE_MESSAGE}),
 * and until now only the MODEL read it — as a tool result, which it paraphrases,
 * softens or ignores. In the conversation that filed this ticket it took five turns to
 * reach the user at all, and in between he did the manual work we had just made
 * impossible: he pasted 360 months of balances into a lane that could not accept them.
 *
 * So the fact is printed by the app, from the server's own tool output, exactly like
 * the fabricated-ceremony note (#1262) it is modelled on: same «Aviso de worthline»
 * frame, same reason — a guarantee cannot depend on the model agreeing to mention it.
 *
 * ONCE per conversation. Repeating it on every refused call turns the boundary into a
 * telling-off, and the fact does not change between two turns of the same thread.
 */

import type { UIMessage } from "ai";

import { unvalidatedEvidenceRejected } from "./unvalidated-evidence-gate";

/**
 * What the app says. It must be TRUE for every lane that can refuse — an import, a
 * reconcile, a reconstruction — so it speaks about the file and the routes, never
 * about which tool the model happened to call.
 *
 * The middle sentence is the door #1418 opened, and it is here rather than only in the
 * model's copy because this note is what the user actually reads: a dated balance
 * series typed into the chat is parsed by worthline itself, so for a debt's history the
 * manual path really is open. It stays explicit that everything else has one route,
 * which is what keeps «pégame los datos» from becoming a promise we cannot keep.
 */
export const UNVALIDATED_EVIDENCE_NOTE =
  "Un archivo que no he podido leer como tabla no puede entrar en bloque al " +
  "patrimonio, y repetir sus datos en el chat tampoco lo consigue — con una " +
  "excepción: el histórico de saldos de una deuda. Escríbeme una línea por fecha, con " +
  "la fecha y el saldo, y esa serie la leo yo de tu mensaje. Para lo demás " +
  "(posiciones, movimientos) el camino es /patrimonio/importar-extracto, o el extracto " +
  "original del banco o del broker.";

/**
 * The envelope this note answers to, read off the gate itself so the two can never
 * drift apart. The per-turn CAP (`unvalidated_evidence_limit`) is deliberately not
 * here: that turn did prepare a proposal, so the user is not staring at a dead end.
 */
const REFUSAL_ERROR: string = unvalidatedEvidenceRejected().error;

/**
 * Whether a tool output is the gate's refusal.
 *
 * Reads the KEY the server wrote, never prose — the same rule as the provenance mark
 * (#1257): what the app asserts about a turn has to come from what the app itself
 * emitted.
 */
export function isUnvalidatedEvidenceRefusal(output: unknown): boolean {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return false;
  }
  return (output as Record<string, unknown>)["error"] === REFUSAL_ERROR;
}

/**
 * The id of the message the note belongs under — the FIRST turn of the conversation
 * whose tools were refused — or `null` when no turn was.
 *
 * Not filtered by streaming state, unlike the fabricated-proposal note: that one reads
 * prose that may still be arriving, this one reads a finished tool result the server
 * produced. There is nothing to withdraw a moment later.
 */
export function messageWithUnvalidatedEvidenceNotice(
  messages: readonly UIMessage[],
): string | null {
  const refused = messages.find(
    (message) =>
      message.role === "assistant" &&
      message.parts.some(
        (part) => "output" in part && isUnvalidatedEvidenceRefusal(part.output),
      ),
  );
  return refused?.id ?? null;
}
