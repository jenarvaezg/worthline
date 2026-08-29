"use client";

import { useNotifyProposalApplied } from "@web/asistente/onboarding-completion";

/**
 * Takes the two fields loose rather than a `ProposalMutation` (#1617): ALL thirteen
 * cards render this, including the three that keep their own confirm/discard and so
 * have no mutation object to hand it. A narrower prop would be the one thing that
 * shuts the exceptions out of the shared status line.
 */
export function ProposalMutationStatus({
  pending,
  result,
}: {
  pending: boolean;
  result: { status: string } | null;
}) {
  // Every proposal card renders this, so it is the one place that sees an
  // `applied` transition for any kind — the onboarding surface listens here to
  // stamp `onboarded_at` on the first confirmed proposal (#1169).
  useNotifyProposalApplied(result?.status);
  return (
    <p aria-live="polite" className="srOnly" role="status">
      {pending ? "Guardando…" : result?.status === "applied" ? "Guardado." : ""}
    </p>
  );
}
