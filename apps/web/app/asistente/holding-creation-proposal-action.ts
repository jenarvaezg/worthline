"use server";

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
import type { AssistantProposal } from "@worthline/db";
import { systemClock } from "@worthline/domain";

import { parseHoldingCreationProposalDraft } from "./holding-creation-proposal-contract";
import { persistHoldingCreation } from "./persist-holding-creation";

type ActionResult =
  | { status: "applied" }
  | { status: "discarded" }
  | { status: "blocked"; message: string }
  | { status: "error"; message: string };

/** The demo / impersonation write barrier shared by both actions. */
async function guardWrites(): Promise<{ status: "blocked"; message: string } | null> {
  const target = await readStoreTarget();
  if (target.kind === "demo")
    return { message: DEMO_DISABLED_MESSAGE, status: "blocked" };
  if (target.kind === "authenticated" && target.impersonatedEmail !== undefined) {
    return { message: IMPERSONATION_READONLY_MESSAGE, status: "blocked" };
  }
  return null;
}

/** The single alta plan a `holding_creation` proposal carries. */
function holdingCreationPlanOf(proposal: AssistantProposal) {
  const fact = proposal.documents
    .flatMap((document) => document.facts)
    .find((item) => item.kind === "holding_creation");
  return fact && fact.kind === "holding_creation" ? fact.row : null;
}

export async function confirmHoldingCreationProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
): Promise<ActionResult> {
  const _store = testStoreFromActionArgs(_testArgs);
  const clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  const blocked = await guardWrites();
  if (blocked) return blocked;
  const draft = parseHoldingCreationProposalDraft(rawDraft);
  if (!draft) return { message: "Propuesta no reconocida.", status: "error" };
  return runActionWithStore(async (store) => {
    const proposal = await store.assistantProposals.read(draft.proposalId);
    if (
      !proposal ||
      proposal.kind !== "holding_creation" ||
      proposal.status !== "draft"
    ) {
      return { message: "La propuesta ya no está disponible.", status: "error" };
    }
    const plan = holdingCreationPlanOf(proposal);
    if (!plan) return { message: "La propuesta no contiene un alta.", status: "error" };
    const today = clock.today();

    // Persist-then-mark. The write and the resolution are two seams, so a crash
    // between them would leave the holding created but the proposal still draft
    // (a re-confirm would then create a duplicate — the informative duplicate
    // warning is the mitigation, not a lock). We accept this small window rather
    // than thread the resolution through the create seam's transaction.
    const persisted = await persistHoldingCreation(store, plan, Date.now(), today);
    if (!persisted.ok) return { message: persisted.error, status: "error" };
    await store.assistantProposals.markApplied(proposal.id);
    return { status: "applied" };
  }, _store);
}

export async function discardHoldingCreationProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
): Promise<ActionResult> {
  const _store = testStoreFromActionArgs(_testArgs);
  const blocked = await guardWrites();
  if (blocked) return blocked;
  const draft = parseHoldingCreationProposalDraft(rawDraft);
  if (!draft) return { message: "Propuesta no reconocida.", status: "error" };
  return runActionWithStore(async (store) => {
    const proposal = await store.assistantProposals.read(draft.proposalId);
    if (
      !proposal ||
      proposal.kind !== "holding_creation" ||
      proposal.status !== "draft"
    ) {
      return { message: "La propuesta ya no está disponible.", status: "error" };
    }
    await store.assistantProposals.markDiscarded(proposal.id);
    return { status: "discarded" };
  }, _store);
}
