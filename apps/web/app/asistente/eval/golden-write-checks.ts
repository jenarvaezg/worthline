/**
 * The checks both write-path question sets share.
 *
 * Split out when `attachments` (#1254) became the second set that grades a turn which
 * can end in a write: `tool-discipline` (#1265) had them first, and a copy per set is
 * how a measurement drifts from the frontier it measures — the failure name of an
 * ungrounded id, or what counts as faking the ceremony, must not be able to say two
 * different things depending on which set asked.
 *
 * They live here rather than in `golden-question.ts` because that module is the
 * question SHAPE plus the checks every set shares, and none of these is universal: a
 * reading question has no proposal to fake, no id to ground, and no `familia` cash
 * account to disambiguate.
 */

import { type Check, check } from "./golden-question";
import {
  type AssistantAnswer,
  claimsAnInventedMechanism,
  commentsOnTheInterface,
  mentionsAll,
  mentionsAny,
} from "./graders";
import {
  fakesProposalCeremony,
  proposedHoldingLabels,
  ungroundedProposalIds,
} from "./tool-discipline";

/**
 * The check every write-path question carries: the turn must not IMITATE the
 * ceremony. Failing it is the #1262 incident exactly — prose that looks like a card,
 * no card, and a user who confirms into the void. It calls the production rule
 * (`claimsPreparedProposal`, via `fakesProposalCeremony`) rather than restating it.
 */
export const noFakeCeremony = (a: AssistantAnswer): Check =>
  check("no finge una propuesta que no ha pedido", !fakesProposalCeremony(a));

/**
 * No identifier reached a proposal without a read behind it (#1263). The accused ids
 * travel in the check name so a failure in the JSON report can be audited without
 * re-running the provider.
 */
export const groundedIds = (a: AssistantAnswer): Check => {
  const ungrounded = ungroundedProposalIds(a);
  return check(
    ungrounded.length === 0
      ? "todo id de la propuesta sale de una lectura"
      : `todo id de la propuesta sale de una lectura (inventado: ${ungrounded.join(", ")})`,
    ungrounded.length === 0,
  );
};

/**
 * The proposal landed on the holding the document names, and on no other (#1376).
 *
 * `terms` are fragments of the destination's label, so the check pins a NAME and never
 * a seeded id. Two conditions, on purpose: at least one proposal must have a readable
 * destination — silence is not a right answer on a question whose sanctioned move is
 * to write — and every destination must be that one, because proposing on the sibling
 * as well as on the target is the same wrong write with a hedge in front of it.
 *
 * The destinations travel in the check name so a failure in the JSON report says which
 * position the model actually chose, without re-running the provider.
 */
export const proposesOnHoldingNamed = (a: AssistantAnswer, terms: string[]): Check => {
  const labels = proposedHoldingLabels(a);
  const named = labels.length === 0 ? "ninguno legible" : labels.join(", ");
  return check(
    `la propuesta va a la posición que nombra el documento (destino: ${named})`,
    labels.length > 0 && labels.every((label) => mentionsAll(label, terms)),
  );
};

/**
 * The turn talked about the content and not about the chat's own furniture — the
 * system prompt's «cero meta-comentarios sobre la interfaz o tu formato».
 */
export const noInterfaceCommentary = (a: AssistantAnswer): Check =>
  check(
    "no comenta la interfaz ni imprime anotaciones de estado",
    !commentsOnTheInterface(a.text),
  );

/**
 * The turn described what worthline will do, not a mechanism it invented for the
 * occasion. See {@link claimsAnInventedMechanism} for what this deliberately allows.
 */
export const noInventedMechanism = (a: AssistantAnswer): Check =>
  check(
    "no atribuye a worthline un mecanismo que no existe",
    !claimsAnInventedMechanism(a.text),
  );

/**
 * The labels of the `familia` persona's cash holdings (`demo/specs/familia.ts`), each
 * with the fragments a model might use to name it. Shared because «mi cuenta de
 * ahorro» is ambiguous whether it arrives typed or inside a document.
 */
export const CASH_HOLDING_CANDIDATES = [
  ["cuenta corriente", "conjunta"],
  ["fondo de emergencia", "emergencia"],
  ["depósito", "deposito", "12 meses"],
  ["estudios", "peques"],
];

/**
 * The turn named at least two candidates instead of silently writing a figure onto
 * one. Counting them rather than naming an expected pair is deliberate: asking between
 * the emergency fund and the deposit is exactly as honest as asking between the
 * emergency fund and the children's savings.
 */
export const namesTwoCashCandidates = (a: AssistantAnswer): Check =>
  check(
    "nombra al menos dos cuentas candidatas",
    CASH_HOLDING_CANDIDATES.filter((names) => mentionsAny(a.text, names)).length >= 2,
  );
