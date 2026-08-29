"use client";

import type { ProposalCardResult, ProposalMutation } from "./proposal-mutation";

/**
 * The one paragraph a card prints after acting — and, until it acts, the demo gate's
 * sentence in its place (#1617).
 *
 * It is `aria-live="polite" role="status"` because it is the only place the outcome
 * of a confirm is said in words; the srOnly `ProposalMutationStatus` above says
 * «Guardando…» while it runs, this says what happened.
 *
 * `applied` is what THIS card calls a success. A plain string when the sentence is
 * fixed — which also means the shared `assistantOk`, so eight cards do not each
 * repeat the class — a function when it reads the payload back (the reconcile batch
 * counts what it created), and an object when it picks the tone too (a reconstructed
 * debt history is a warning when captures went without the debt, #1438).
 */
type AppliedCopy = string | { className: string; text: string };

type Copy = { className: string; text: string };

function copyOf(applied: AppliedCopy): Copy {
  return typeof applied === "string"
    ? { className: "assistantOk", text: applied }
    : applied;
}

export function ProposalOutcome<Result extends ProposalCardResult>({
  applied,
  mutation,
}: {
  applied:
    | AppliedCopy
    | ((result: Extract<Result, { status: "applied" }>) => AppliedCopy);
  mutation: ProposalMutation<Result>;
}) {
  const { mutationsDisabled, mutationsDisabledMessage } = mutation;
  // Narrowing the union needs the concrete shape, not the type parameter.
  const result: ProposalCardResult | null = mutation.result;
  if (result === null) {
    return mutationsDisabled ? (
      <p className="assistantError">{mutationsDisabledMessage}</p>
    ) : null;
  }
  const copy: Copy =
    result.status === "applied"
      ? copyOf(
          typeof applied === "function"
            ? applied(result as Extract<Result, { status: "applied" }>)
            : applied,
        )
      : {
          className: "assistantError",
          text: result.status === "discarded" ? "Propuesta descartada." : result.message,
        };
  return (
    <p aria-live="polite" className={copy.className} role="status">
      {copy.text}
    </p>
  );
}
