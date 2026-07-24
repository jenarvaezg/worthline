"use client";

import { createContext, useContext, useEffect, useRef } from "react";

/**
 * Onboarding completion wiring (PRD #1167 S2, #1169). The onboarding surface
 * must stamp `onboarded_at` when the user confirms their FIRST assistant
 * proposal from it — but the proposal cards are shared verbatim with the
 * floating panel and each owns its own confirm state, so threading a callback
 * through all nine would be noise.
 *
 * Instead the surface publishes a listener through context; every card already
 * renders `ProposalMutationStatus`, so that single component observes its own
 * `applied` transition via {@link useNotifyProposalApplied} and notifies. The
 * floating panel provides no listener (the default no-op), so nothing fires
 * there. The listener the onboarding surface supplies is itself guarded to fire
 * the server action once.
 */
export type ProposalAppliedListener = () => void;

const NOOP: ProposalAppliedListener = () => {};

export const ProposalAppliedContext = createContext<ProposalAppliedListener>(NOOP);

/**
 * The fire-once decision, extracted pure so it unit-tests in the node env (the
 * effect wrapper below and the provider-side dedup both lean on it): notify only
 * on the `applied` transition, and never twice for the same guard. Both the
 * per-card ref and the session-wide provider ref pass their own `alreadyFired`.
 */
export function shouldNotifyApplied(
  status: string | undefined,
  alreadyFired: boolean,
): boolean {
  return status === "applied" && !alreadyFired;
}

/**
 * Notify the surrounding {@link ProposalAppliedContext} the first time this
 * card's proposal settles as `applied`. Per-instance ref-guarded so a re-render
 * never re-fires; the provider dedupes across the whole conversation.
 */
export function useNotifyProposalApplied(status: string | undefined): void {
  const notify = useContext(ProposalAppliedContext);
  const firedRef = useRef(false);
  useEffect(() => {
    if (shouldNotifyApplied(status, firedRef.current)) {
      firedRef.current = true;
      notify();
    }
  }, [status, notify]);
}
