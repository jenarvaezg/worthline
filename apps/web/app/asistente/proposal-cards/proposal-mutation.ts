"use client";

import { useState, useTransition } from "react";
import type { ProposalCardGate } from "./gate";

/**
 * The skeleton every proposal card repeated verbatim (#1617, consequence declared in
 * ADR 0088): one piece of state for the result of whichever action ran, one
 * transition for the pending flag, and the one derived truth both buttons read —
 * a settled proposal has nothing left to confirm or discard.
 *
 * The hook takes THUNKS rather than the server actions themselves: a card's confirm
 * carries its own extra payload (the reconstruct card re-sends its kept series, the
 * reconcile card its curated decisions), and a thunk closes over the render's state
 * so the click always sends what is on screen.
 */

/**
 * What a proposal action returns, seen from the card: the applied outcome carries a
 * kind-specific payload, the discard carries nothing, and the two ways to fail carry
 * the sentence to print. Restated structurally here rather than imported from the
 * `"use server"` module the actions live in, so a client component never reaches
 * into a server one for a type.
 */
export type ProposalCardResult =
  | { status: "applied" }
  | { status: "discarded" }
  | { status: "blocked" | "error"; message: string };

export type ProposalMutation<Result extends ProposalCardResult> = {
  /** Pending, blocked by the demo gate, or already settled — no button acts. */
  actionsDisabled: boolean;
  confirm: () => void;
  /** Null for a card whose proposal has no discard (the debt balance history). */
  discard: (() => void) | null;
  // The gate rides along deliberately: the outcome paragraph prints its sentence
  // when nothing has happened yet, so passing `mutation` alone is enough for it.
  mutationsDisabled: boolean;
  mutationsDisabledMessage: string;
  pending: boolean;
  result: Result | null;
};

/**
 * A proposal with no discard is a different thing from one whose discard happens to
 * be missing, and the two overloads say so: only the pair-shaped call yields a
 * `discard` a `<ProposalActions>` will take, so a card without one cannot reach for
 * the button row and get a half-painted pair.
 */
export function useProposalMutation<Confirm extends ProposalCardResult>(
  gate: ProposalCardGate,
  actions: { confirm: () => Promise<Confirm> },
): ProposalMutation<Confirm> & { discard: null };
export function useProposalMutation<
  Confirm extends ProposalCardResult,
  Discard extends ProposalCardResult,
>(
  gate: ProposalCardGate,
  actions: { confirm: () => Promise<Confirm>; discard: () => Promise<Discard> },
): ProposalMutation<Confirm | Discard> & { discard: () => void };
export function useProposalMutation<
  Confirm extends ProposalCardResult,
  Discard extends ProposalCardResult,
>(
  gate: ProposalCardGate,
  actions: { confirm: () => Promise<Confirm>; discard?: () => Promise<Discard> },
): ProposalMutation<Confirm | Discard> {
  const [result, setResult] = useState<Confirm | Discard | null>(null);
  const [pending, startTransition] = useTransition();
  const settled = result?.status === "applied" || result?.status === "discarded";
  const { confirm, discard } = actions;
  return {
    actionsDisabled: pending || gate.mutationsDisabled || settled,
    confirm: () => startTransition(async () => setResult(await confirm())),
    discard: discard
      ? () => startTransition(async () => setResult(await discard()))
      : null,
    mutationsDisabled: gate.mutationsDisabled,
    mutationsDisabledMessage: gate.mutationsDisabledMessage,
    pending,
    result,
  };
}
