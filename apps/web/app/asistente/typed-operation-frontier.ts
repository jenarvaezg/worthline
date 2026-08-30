/**
 * The typed door of `propose_operation` (#1466) — the half of the frontier that faces
 * the MODEL, kept apart from the parser that faces the message.
 *
 * The split is the one `operation-document-frontier.ts` already makes for the other
 * door: reading a fact and checking a claim against it are two different jobs, and only
 * this one knows about tool arguments. Its answers are shaped exactly like that
 * sibling's, so the tool routes both doors through one branch.
 *
 * Pure and I/O-free.
 */

import {
  OPERATION_DOCUMENT_REQUIRED_MESSAGE,
  type OperationFactClaim,
  type OperationFactVoice,
  type OperationFrontierError,
  operationClaimMismatches,
} from "./operation-document-frontier";
import {
  holdingEventFromTyped,
  type TypedHoldingEvent,
  type TypedHoldingEventReading,
  typedDirectionConflict,
  typedHoldingEventGapMessage,
} from "./typed-holding-event";

/**
 * The currency the mismatch sentences format their figures in when the message marked
 * none. It never leaves this refusal: nothing is written from a rejected call, and the
 * write's own currency comes from the holding.
 */
const REFUSAL_CURRENCY = "EUR";

/** The two words the mismatch sentences need when the fact came off the message. */
const MESSAGE_VOICE: OperationFactVoice = {
  of: "del mensaje",
  subject: "el mensaje",
};

/**
 * A figure relayed by the model contradicts what the user typed. Mirrors
 * `operationFactNotInDocumentMessage`, and for the same reason: a refusal that does not
 * name the real value invites the same guess again.
 */
export function operationFactNotInMessageMessage(mismatches: readonly string[]): string {
  return (
    `Esto no es lo que dice el mensaje del usuario: ${mismatches.join("; ")}. ` +
    "No anoto una operación con cifras que no salgan de él: las leo yo de lo que ha " +
    "escrito. Pásame los datos tal cual los ha escrito, o pídele el justificante."
  );
}

export type TypedOperationResolution =
  | { ok: true; event: TypedHoldingEvent }
  | { ok: false; error: OperationFrontierError };

/**
 * Resolve the fact a DICTATED operation will be built from — the typed lane's half of
 * `resolveOperationEvent`, and deliberately shaped like it.
 *
 * The result is always what worthline READ: the claim only says which holding and which
 * direction, and a claim that disagrees fails the whole call. Two refusals are the
 * lane's own — a message that states no operation is routed to both vías, and a
 * half-written one is told which figure is missing — because «no te he entendido» is
 * the answer #1418 is named after.
 */
export function resolveTypedOperationEvent(
  claim: OperationFactClaim,
  reading: TypedHoldingEventReading | undefined,
): TypedOperationResolution {
  if (reading === undefined || reading.status === "absent") {
    return {
      error: {
        error: "operation_document_required",
        message: OPERATION_DOCUMENT_REQUIRED_MESSAGE,
      },
      ok: false,
    };
  }
  if (reading.status === "incomplete") {
    return {
      error: {
        error: "operation_fact_incomplete_in_message",
        message: typedHoldingEventGapMessage(reading.missing),
      },
      ok: false,
    };
  }

  const { event } = reading;
  const conflict = typedDirectionConflict(event, claim.kind);
  if (conflict !== null) {
    return {
      error: { error: "operation_kind_contradicts_message", message: conflict },
      ok: false,
    };
  }

  // The comparison runs over the event as it will be COMPOSED, so the model is checked
  // against the very figures the ledger would receive — including the importe derived
  // from `participaciones × precio`. The currency is the one place the two lanes differ:
  // when the user marked none there is nothing to contradict, so the claim's currency is
  // dropped from the check rather than measured against a placeholder (#1401 is about
  // never assuming a currency in silence, and inventing one HERE to refuse with would be
  // the same sin wearing a guard's clothes). What is left is only how the refusal PRINTS
  // its figures — deliberately not the model's own `currency` either, which would let the
  // argument under scrutiny choose the words it is scolded in. The currency that reaches
  // the ledger is neither of these: the builder takes the HOLDING's (`resolveOperationFact`).
  const currency = event.currency ?? REFUSAL_CURRENCY;
  const checked: OperationFactClaim =
    event.currency === null ? { ...claim, currency: undefined } : claim;
  const mismatches = operationClaimMismatches(
    checked,
    holdingEventFromTyped(event, currency),
    MESSAGE_VOICE,
  );
  if (mismatches.length > 0) {
    return {
      error: {
        error: "operation_fact_not_in_message",
        message: operationFactNotInMessageMessage(mismatches),
      },
      ok: false,
    };
  }
  return { event, ok: true };
}
