import {
  isClock,
  runActionWithStore,
  testArgFromActionArgs,
  testStoreFromActionArgs,
} from "@web/action-store";
import {
  DEMO_DISABLED_MESSAGE,
  IMPERSONATION_READONLY_MESSAGE,
} from "@web/demo/write-guard";
import { readStoreTarget } from "@web/read-store-target";
import { type WorthlineStore } from "@web/store";
import type { AssistantProposal, AssistantProposalKind } from "@worthline/db";
import { systemClock } from "@worthline/domain";

/**
 * The lifecycle seam every assistant-proposal action shares (PRD #1112 S4). Each
 * confirm/discard action re-wrote the same shell by hand: the `_testArgs` store +
 * clock seam, the demo/impersonation write barrier (9 inline copies across the
 * proposal files), the draft parse, and — inside the store cycle — the
 * read-proposal + validate-kind-and-state gate whose Spanish message drifted
 * between files. This module owns all of that so an action supplies ONLY what
 * genuinely varies: how to parse its draft, and its `apply` body (confirm) — or
 * nothing beyond the kind (discard). Adding a new proposal kind costs one apply.
 *
 * The mutation barrier does NOT move: the commands (ADR 0062) stay the frontier;
 * the seam owns the web choreography in front of them, exactly like the
 * `formAction` combinator (#1113) does for the redirect/useActionState actions —
 * this is its assistant-proposal specialization (the guard is `readStoreTarget`
 * returning a `blocked` result, not `guardDemoWrite` redirecting).
 */

/** The unified message when a proposal is missing, of the wrong kind, or already resolved. */
export const PROPOSAL_UNAVAILABLE_MESSAGE = "La propuesta ya no está disponible.";
/** The default message when a raw draft does not parse to a proposal reference. */
export const PROPOSAL_UNRECOGNIZED_MESSAGE = "Propuesta no reconocida.";

/** A blocked write (demo persona or admin impersonation) — read-only sessions. */
export type ProposalBlocked = { status: "blocked"; message: string };
/** A recoverable failure surfaced to the card inline. */
export type ProposalError = { status: "error"; message: string };
/** A discard that resolved the draft. */
export type ProposalDiscarded = { status: "discarded" };

/** What an `apply` body returns: applied (with a kind-specific payload) or an error. */
export type ProposalApplyResult<Applied extends object = Record<never, never>> =
  | ({ status: "applied" } & Applied)
  | ProposalError;

/** The full confirm result: an apply outcome, or blocked before any write. */
export type ProposalConfirmResult<Applied extends object = Record<never, never>> =
  | ProposalApplyResult<Applied>
  | ProposalBlocked;

/** The full discard result. */
export type ProposalDiscardResult = ProposalDiscarded | ProposalBlocked | ProposalError;

/**
 * Parse a raw draft to its proposal id, carrying any extra `data` the apply body
 * needs (e.g. a reconcile curation) so it is validated in the same pre-store step
 * as the draft — never after the proposal read, preserving the original order.
 */
export type ProposalParseResult<Data = undefined> =
  | { ok: true; proposalId: string; data: Data }
  | { ok: false; message: string };

/**
 * The demo / impersonation write barrier shared by every proposal action (ADR
 * 0044 / 0057): a demo persona or an admin impersonation is read-only, so the
 * write is blocked with a friendly message rather than executed. Returns null
 * when the write may proceed. This is the ONE copy that replaces the nine inline
 * ones.
 */
export async function guardProposalWrite(): Promise<ProposalBlocked | null> {
  const target = await readStoreTarget();
  if (target.kind === "demo") {
    return { status: "blocked", message: DEMO_DISABLED_MESSAGE };
  }
  if (target.kind === "authenticated" && target.impersonatedEmail !== undefined) {
    return { status: "blocked", message: IMPERSONATION_READONLY_MESSAGE };
  }
  return null;
}

/**
 * Confirm an assistant proposal: lift the test seam, run the write guard, parse
 * the draft, then — inside one store cycle — read the proposal and gate on its
 * kind + draft status before handing the live proposal to `apply`. The gate's
 * message is unified here ({@link PROPOSAL_UNAVAILABLE_MESSAGE}); the apply body
 * owns everything downstream (projection, revalidation, the command, mark-applied).
 */
export async function runProposalConfirm<
  Applied extends object = Record<never, never>,
  Data = undefined,
>(config: {
  rawDraft: unknown;
  testArgs: readonly unknown[];
  kind: AssistantProposalKind;
  parse: (rawDraft: unknown) => ProposalParseResult<Data>;
  apply: (ctx: {
    store: WorthlineStore;
    proposal: AssistantProposal;
    today: string;
    now: string;
    data: Data;
  }) => Promise<ProposalApplyResult<Applied>>;
}): Promise<ProposalConfirmResult<Applied>> {
  const store = testStoreFromActionArgs(config.testArgs);
  const clock = testArgFromActionArgs(config.testArgs, isClock) ?? systemClock();
  const blocked = await guardProposalWrite();
  if (blocked) {
    return blocked;
  }
  const parsed = config.parse(config.rawDraft);
  if (!parsed.ok) {
    return { status: "error", message: parsed.message };
  }
  return runActionWithStore(async (liveStore) => {
    const proposal = await liveStore.assistantProposals.read(parsed.proposalId);
    if (!proposal || proposal.kind !== config.kind || proposal.status !== "draft") {
      return { status: "error", message: PROPOSAL_UNAVAILABLE_MESSAGE };
    }
    return config.apply({
      store: liveStore,
      proposal,
      today: clock.today(),
      now: clock.now(),
      data: parsed.data,
    });
  }, store);
}

/**
 * Discard an assistant proposal: the symmetric, apply-less counterpart of
 * {@link runProposalConfirm}. Same guard + parse + kind/state gate, then
 * `markDiscarded`. Every proposal kind's discard is identical, so it lives here
 * once rather than being re-implemented per file.
 */
export async function runProposalDiscard(config: {
  rawDraft: unknown;
  testArgs: readonly unknown[];
  kind: AssistantProposalKind;
  parse: (rawDraft: unknown) => ProposalParseResult<unknown>;
}): Promise<ProposalDiscardResult> {
  const store = testStoreFromActionArgs(config.testArgs);
  const blocked = await guardProposalWrite();
  if (blocked) {
    return blocked;
  }
  const parsed = config.parse(config.rawDraft);
  if (!parsed.ok) {
    return { status: "error", message: parsed.message };
  }
  return runActionWithStore(async (liveStore) => {
    const proposal = await liveStore.assistantProposals.read(parsed.proposalId);
    if (!proposal || proposal.kind !== config.kind || proposal.status !== "draft") {
      return { status: "error", message: PROPOSAL_UNAVAILABLE_MESSAGE };
    }
    await liveStore.assistantProposals.markDiscarded(proposal.id);
    return { status: "discarded" };
  }, store);
}
