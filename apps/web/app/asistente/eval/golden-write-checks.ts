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
import { type AssistantAnswer, mentionsAny } from "./graders";
import { fakesProposalCeremony, ungroundedProposalIds } from "./tool-discipline";

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
