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
import { systemClock } from "@worthline/domain";

import { parseCorrectionProposalDraft } from "./correction-proposal-contract";

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

export async function confirmCorrectionProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
): Promise<ActionResult> {
  const _store = testStoreFromActionArgs(_testArgs);
  const clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  const blocked = await guardWrites();
  if (blocked) return blocked;
  const draft = parseCorrectionProposalDraft(rawDraft);
  if (!draft) return { message: "Propuesta no reconocida.", status: "error" };
  return runActionWithStore(async (store) => {
    const proposal = await store.assistantProposals.read(draft.proposalId);
    if (!proposal || proposal.kind !== "correction" || proposal.status !== "draft") {
      return { message: "La propuesta ya no está disponible.", status: "error" };
    }
    try {
      await store.command.applyAssistantCorrectionProposal({
        proposalId: proposal.id,
        today: clock.today(),
      });
    } catch (error) {
      // A stale draft (live data moved since drafting) or a domain violation
      // rolls the whole apply back; surface it honestly, nothing persisted.
      return {
        message:
          error instanceof Error ? error.message : "No se pudo aplicar la corrección.",
        status: "error",
      };
    }
    return { status: "applied" };
  }, _store);
}

export async function discardCorrectionProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
): Promise<ActionResult> {
  const _store = testStoreFromActionArgs(_testArgs);
  const blocked = await guardWrites();
  if (blocked) return blocked;
  const draft = parseCorrectionProposalDraft(rawDraft);
  if (!draft) return { message: "Propuesta no reconocida.", status: "error" };
  return runActionWithStore(async (store) => {
    const proposal = await store.assistantProposals.read(draft.proposalId);
    if (!proposal || proposal.kind !== "correction" || proposal.status !== "draft") {
      return { message: "La propuesta ya no está disponible.", status: "error" };
    }
    await store.assistantProposals.markDiscarded(proposal.id);
    return { status: "discarded" };
  }, _store);
}
