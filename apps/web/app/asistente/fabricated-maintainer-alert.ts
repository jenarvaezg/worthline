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

import type { UIMessage } from "ai";

import { assertedInAnySentence } from "./claim-sentences";
import {
  fabricatedCeremonyGuard,
  LEAVE_IN_FLIGHT_ALONE,
  messagesWithFabricatedCeremony,
} from "./fabricated-ceremony";
import { toolPartName } from "./tool-parts";

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
const ALERT_NOUN =
  "(?:incidencias?|alertas?|tickets?|avisos?\\s+al\\s+(?:mantenedor|desarrollador|equipo))";

/**
 * The gap a claim verb may leave before its noun. Deliberately tight — «la », « una »,
 * « el » is all a true claim needs — and it is what keeps the noun in the SAME clause as
 * the verb. Review built the turn that made this necessary: «He registrado tu operación;
 * sobre la alerta, no puedo levantarla» is honest, is one sentence to the splitter (a
 * semicolon does not end one), and would otherwise be accused. `;` is excluded from the
 * gap for the same reason.
 */
const NOUN_GAP = "[^.!?;]{0,15}";

/**
 * Assertions that the incident ALREADY exists. Perfect and preterite forms only, the
 * same line `fabricated-proposal.ts` draws: Spanish uses the present to OFFER
 * («¿quieres que registre una incidencia?», «puedo levantar una alerta»), which is the
 * honest turn and the one the refusal message is trying to produce.
 *
 * The noun rides INSIDE each pattern rather than being tested over the whole sentence.
 * The proposal guard can afford the looser reading because its verbs are the ceremony's
 * own («preparar una propuesta»); these are everyday verbs — «he registrado la
 * amortización» — so what has to be pinned is that the thing registered IS the incident.
 */
const CLAIM_PATTERNS = [
  // «he registrado la incidencia» — the sentence from the transcript itself — plus the
  // rest of the family the same auxiliary opens: «hemos abierto», «te he levantado».
  new RegExp(
    `\\b(?:he|hemos)\\b[^.!?;]{0,30}\\b(?:registrado|levantado|abierto|creado|generado|reportado|notificado|trasladado|elevado|comunicado)\\b${NOUN_GAP}\\b${ALERT_NOUN}\\b`,
    "i",
  ),
  // The impersonal voice for the same claim: «se ha registrado la incidencia».
  new RegExp(
    `\\bse (?:ha|han)\\b[^.!?;]{0,30}\\b(?:registrado|levantado|abierto|creado|reportado|notificado|trasladado|comunicado)\\b${NOUN_GAP}\\b${ALERT_NOUN}\\b`,
    "i",
  ),
  // No trailing \b on the preterites: JS word boundaries do not see «é» as a word
  // character, so «registré» would never close one.
  new RegExp(
    `\\b(?:registré|levanté|abrí|creé|reporté|notifiqué|trasladé|elevé|comuniqué)${NOUN_GAP}\\b${ALERT_NOUN}\\b`,
    "i",
  ),
  // «la incidencia queda registrada», «el ticket está abierto» — the same assertion
  // without the first person, so the noun leads.
  new RegExp(
    `\\b${ALERT_NOUN}\\b[^.!?;]{0,40}\\b(?:est[áa]|queda|quedan)\\s+(?:registrad|levantad|abiert|cread|curs)`,
    "i",
  ),
];

/**
 * Does this text assert that a maintainer alert has been raised?
 *
 * Scope, stated plainly: the ceremony's own noun, next to a perfect form of the claim,
 * inside one clause. Widening it stays a decision to take with measured cases, never by
 * guessing at synonyms — the cost of guessing is notes on honest turns, and those are
 * what teach a user to ignore notes.
 */
export function claimsRaisedMaintainerAlert(text: string): boolean {
  return assertedInAnySentence(text, () => CLAIM_PATTERNS);
}

/** The one tool output shape that means an alert really reached the control plane. */
export function isRaisedAlertOutput(output: unknown): boolean {
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
 * proposal, which the user could ask for again — so the turn is simply left alone. The
 * shared mechanics carry that asymmetry as {@link LEAVE_IN_FLIGHT_ALONE} (#1697), so it
 * reads as a declared choice rather than an accident of two hand-written loops.
 */
const maintainerAlertGuard = fabricatedCeremonyGuard<true>({
  claims: claimsRaisedMaintainerAlert,
  delivers: (part) => "output" in part && isRaisedAlertOutput(part.output),
  interrupted: LEAVE_IN_FLIGHT_ALONE,
  lanes: (part) => toolPartName(part) === MAINTAINER_ALERT_TOOL,
  never: true,
  rejected: true,
});

/** {@link maintainerAlertGuard} as the boolean both audiences ask for. */
export function fabricatesMaintainerAlert(message: UIMessage): boolean {
  return maintainerAlertGuard(message) !== null;
}

/**
 * The assistant turns that claim an incident nobody filed, by id.
 *
 * The streaming exemption is {@link messagesWithFabricatedCeremony}'s, the same loop the
 * proposal guard runs since #1697 — the two used to hold a copy each.
 */
export function messagesWithFabricatedMaintainerAlert(
  messages: UIMessage[],
  streaming: boolean,
): ReadonlySet<string> {
  return new Set(
    messagesWithFabricatedCeremony(messages, streaming, maintainerAlertGuard).keys(),
  );
}
