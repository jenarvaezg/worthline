/**
 * The turn that says it filed an INCIDENT and did not (#1525).
 *
 * Observed in production (2026-08-21). Jorge hit a wall, asked for the reasonable
 * thing — «levanta una incidencia sobre esto» — and read back: «te confirmo que he
 * registrado la incidencia técnicamente como una limitación del sistema». Nothing was
 * registered: `raise_maintainer_alert` had REFUSED the call, and the same message said
 * so two paragraphs below («como asistente no puedo […] levantar alertas sobre
 * "ausencia de funcionalidades"»). It asserted the effect and the impossibility of the
 * effect in one turn. He believed it, and only found out by asking for a ticket number.
 *
 * It is the shape of #1468 — the turn that DID call a tool, was rejected, and narrated
 * the rejection as success — in the lane that had no guard. And it is worse here than
 * over a proposal, for two reasons:
 *
 *  1. NO SCREEN CONTRADICTS IT. A fabricated proposal collides with a card that is not
 *     there; the user sees the gap. A fabricated alert paints nothing ever, so the lie
 *     is indistinguishable from the truth until somebody asks for a case number. Which
 *     is why the note below is painted at RENDER as well as fed back into history: the
 *     history repair alone only stops the model doubling down, and the user of THIS
 *     turn stays deceived.
 *  2. THE REFUSAL MESSAGE IS ALREADY WELL WRITTEN AND DID NOT HOLD.
 *     `MAINTAINER_ALERT_WITHOUT_DISCREPANCY_MESSAGE` says, in as many words, «no le
 *     prometas al usuario gestión alguna». The model read it and promised management
 *     anyway. An instruction already measured as insufficient is not fixed by rewriting
 *     it — that is the whole reason `fabricated-proposal.ts` exists.
 *
 * The signal is CLEANER than the proposal one: there, what matters is whether a card
 * was painted, which takes a parser (`proposal-card-presence.ts`). Here the alert has
 * exactly one success shape — `status: "raised"`, the only branch of the tool that ran
 * a control-plane write — and every other answer (a refusal, `unpersisted`,
 * `maintainer_alert_unavailable`) means no incident exists and no number can be given.
 */

import { isToolUIPart, type UIMessage } from "ai";

import { assertsAny, sentences } from "./claim-sentences";
import { toolCallAnswered, toolPartName } from "./tool-parts";

/**
 * What the app says next to a fabricated incident.
 *
 * True whenever it appears, like its sibling in `fabricated-proposal.ts`, and for the
 * same reason: it speaks about THIS message. An alert really raised in an earlier turn
 * does not make «en este mensaje no se ha registrado nada» false.
 *
 * The last sentence is the one the incident actually needs. Jorge did not want a
 * ticket, he wanted the developer to know — and telling him only that the ticket does
 * not exist would leave him where the lie left him. Until worthline has a channel of
 * its own (#1174) the honest answer is that there is none.
 */
export const FABRICATED_ALERT_NOTE =
  "En este mensaje no se ha registrado ninguna incidencia: no hay ticket, ni número, " +
  "ni nadie a quien le haya llegado. El asistente no tiene detrás ningún canal de " +
  "soporte, así que hoy worthline no puede tramitar un aviso por ti.";

/**
 * What the model is told about its own previous turn, in the history it gets back.
 *
 * A statement of fact and NOTHING else — no «vuelve a intentarlo», the lesson
 * `FABRICATED_PROPOSAL_MODEL_NOTE` learnt the hard way: an instruction on a write path,
 * fired by a text heuristic, is how a regex match turns into a duplicate call. Here it
 * would be worse than useless, because the retry is the very thing the admission gate
 * already refused.
 */
export const FABRICATED_ALERT_MODEL_NOTE =
  "(En ese turno no se levantó ninguna alerta: `raise_maintainer_alert` no devolvió " +
  "ninguna alerta registrada, así que no hay incidencia, ni ticket, ni número que dar, " +
  "ni nadie a quien haya llegado.)";

/** The assistant's only path to a maintainer alert (ADR 0064). */
const MAINTAINER_ALERT_TOOL = "raise_maintainer_alert";

/**
 * The ceremony's own nouns. Narrow on purpose and taken from the transcript that opened
 * the issue: «incidencia» is the word Jorge used and the word the model echoed, and
 * «ticket» is what he asked for when he doubted it. «Aviso» only counts when it names
 * who it went to — «te aviso de que el saldo no cuadra» is an ordinary sentence and
 * flagging it would put an alarming note on an honest turn, which is how a user learns
 * to ignore notes.
 */
const ALERT_WORD =
  /\b(incidencias?|alertas?|tickets?|avisos?\s+al\s+(mantenedor|desarrollador|equipo))\b/i;

/**
 * Assertions that the incident ALREADY exists. Perfect and preterite forms only, the
 * same line `fabricated-proposal.ts` draws: Spanish uses the present to OFFER
 * («¿quieres que registre una incidencia?», «puedo levantar una alerta»), which is the
 * honest turn and the one the refusal message is trying to produce.
 */
const CLAIM_PATTERNS = [
  // «he registrado la incidencia» — the sentence from the transcript itself — plus the
  // rest of the family the same auxiliary opens: «hemos abierto», «te he levantado».
  /\b(he|hemos)\b[^.!?]{0,30}\b(registrado|levantado|abierto|creado|generado|reportado|notificado|trasladado|elevado|comunicado)\b/i,
  // The impersonal voice for the same claim. No trailing \b on the preterites: JS word
  // boundaries do not see «é» as a word character, so «registré» would never close one.
  /\bse (ha|han)\b[^.!?]{0,30}\b(registrado|levantado|abierto|creado|reportado|notificado|trasladado|comunicado)\b/i,
  /\b(registré|levanté|abrí|creé|reporté|notifiqué|trasladé|elevé|comuniqué)/i,
  // «la incidencia queda registrada», «la alerta está abierta».
  /\b(incidencias?|alertas?|tickets?|avisos?)\b[^.!?]{0,40}\b(est[áa]|queda|quedan)\s+(registrad|levantad|abiert|cread|curs)/i,
];

/**
 * Does this text assert that a maintainer alert has been raised?
 *
 * Scope, stated plainly: it reads the ceremony's own vocabulary crossed with the
 * perfect forms, in the SAME sentence. Widening it stays a decision to take with
 * measured cases, never by guessing at synonyms — the cost of guessing is notes on
 * honest turns.
 */
export function claimsRaisedMaintainerAlert(text: string): boolean {
  return sentences(text).some(
    (sentence) => ALERT_WORD.test(sentence) && assertsAny(sentence, CLAIM_PATTERNS),
  );
}

/** The one tool output shape that means an alert really reached the control plane. */
export function outputRaisedAnAlert(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    (output as { status?: unknown }).status === "raised"
  );
}

/**
 * THE decision, in one place: an assistant turn claiming a filed incident while no
 * `raise_maintainer_alert` call in it came back with one.
 *
 * Exported because both audiences ask the same question — the panel to print the
 * warning, the route to correct the model's history — and a second copy of the rule
 * would let the two drift apart in silence (#1254).
 *
 * A call still IN FLIGHT exempts the turn, and that is the one asymmetry with the
 * proposal guard. The tool persists through the control plane BEFORE it returns, so a
 * stream that died after the write leaves an alert that really exists; accusing there
 * would make the app the liar. There is no third state to describe either — unlike a
 * proposal, which the user could ask for again — so the turn is simply left alone.
 */
export function fabricatesMaintainerAlert(message: UIMessage): boolean {
  if (message.role !== "assistant") return false;
  const calls = message.parts.filter(
    (part) => isToolUIPart(part) && toolPartName(part) === MAINTAINER_ALERT_TOOL,
  );
  if (calls.some((part) => !toolCallAnswered(part))) return false;
  if (calls.some((part) => "output" in part && outputRaisedAnAlert(part.output))) {
    return false;
  }
  return claimsRaisedMaintainerAlert(
    message.parts
      .filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text)
      .join("\n"),
  );
}

/**
 * The assistant turns that claim an incident nobody filed, by id.
 *
 * The in-flight message is left alone while the turn streams, exactly as the proposal
 * guard does: prose can land before the tool call within one turn, so judging it early
 * would flash an accusation and then withdraw it. That rule belongs to the screen only;
 * the history the model gets back is never in flight.
 */
export function messagesWithFabricatedMaintainerAlert(
  messages: UIMessage[],
  streaming: boolean,
): ReadonlySet<string> {
  const fabricated = new Set<string>();
  messages.forEach((message, index) => {
    if (streaming && index === messages.length - 1) return;
    if (fabricatesMaintainerAlert(message)) fabricated.add(message.id);
  });
  return fabricated;
}
