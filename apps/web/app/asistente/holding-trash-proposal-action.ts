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
import type { WorthlineStore } from "@web/store";
import type {
  AssistantProposal,
  BatchTrashResult,
  HoldingTrashTarget,
} from "@worthline/db";
import { type Clock, systemClock } from "@worthline/domain";

import { parseHoldingTrashProposalDraft } from "./holding-trash-proposal-contract";

type ActionResult =
  | { status: "applied" }
  | { status: "discarded" }
  | { status: "blocked"; message: string }
  | { status: "error"; message: string };

/** The demo / impersonation write barrier shared by every trash action (ADR 0044/0057). */
async function guardWrites(): Promise<{ status: "blocked"; message: string } | null> {
  const target = await readStoreTarget();
  if (target.kind === "demo")
    return { message: DEMO_DISABLED_MESSAGE, status: "blocked" };
  if (target.kind === "authenticated" && target.impersonatedEmail !== undefined) {
    return { message: IMPERSONATION_READONLY_MESSAGE, status: "blocked" };
  }
  return null;
}

/** The `{ holdingId, kind }` targets a trash proposal carries, from its facts. */
function targetsOf(proposal: AssistantProposal): HoldingTrashTarget[] {
  return proposal.documents
    .flatMap((document) => document.facts)
    .flatMap((fact) =>
      fact.kind === "holding_trash_action"
        ? [{ holdingId: fact.row.holdingId, kind: fact.row.holdingKind }]
        : [],
    );
}

async function confirmTrashProposal(
  rawDraft: unknown,
  testArgs: unknown[],
  kind: "holding_removal" | "holding_restoration",
  apply: (
    store: WorthlineStore,
    targets: HoldingTrashTarget[],
    clock: Clock,
  ) => Promise<BatchTrashResult>,
): Promise<ActionResult> {
  const _store = testStoreFromActionArgs(testArgs);
  const clock = testArgFromActionArgs(testArgs, isClock) ?? systemClock();
  const blocked = await guardWrites();
  if (blocked) return blocked;
  const draft = parseHoldingTrashProposalDraft(rawDraft);
  if (!draft) return { message: "Propuesta no reconocida.", status: "error" };
  return runActionWithStore(async (store) => {
    const proposal = await store.assistantProposals.read(draft.proposalId);
    if (!proposal || proposal.kind !== kind || proposal.status !== "draft") {
      return { message: "La propuesta ya no está disponible.", status: "error" };
    }
    const targets = targetsOf(proposal);
    if (targets.length === 0) {
      return { message: "La propuesta no contiene holdings.", status: "error" };
    }
    const result = await apply(store, targets, clock);
    if (!result.ok) {
      return { message: trashFailureMessage(result), status: "error" };
    }
    await store.assistantProposals.markApplied(proposal.id);
    return { status: "applied" };
  }, _store);
}

/** Map an atomic batch failure to a Spanish, user-facing message. */
function trashFailureMessage(result: {
  ok: false;
  reason: "not_found" | "not_in_trash";
  holdingId: string;
}): string {
  return result.reason === "not_in_trash"
    ? "Uno de los holdings ya no está en la papelera; no se ha restaurado nada."
    : "Uno de los holdings ya no existe; no se ha dado de baja nada.";
}

async function discardTrashProposal(
  rawDraft: unknown,
  testArgs: unknown[],
  kind: "holding_removal" | "holding_restoration",
): Promise<ActionResult> {
  const _store = testStoreFromActionArgs(testArgs);
  const blocked = await guardWrites();
  if (blocked) return blocked;
  const draft = parseHoldingTrashProposalDraft(rawDraft);
  if (!draft) return { message: "Propuesta no reconocida.", status: "error" };
  return runActionWithStore(async (store) => {
    const proposal = await store.assistantProposals.read(draft.proposalId);
    if (!proposal || proposal.kind !== kind || proposal.status !== "draft") {
      return { message: "La propuesta ya no está disponible.", status: "error" };
    }
    await store.assistantProposals.markDiscarded(proposal.id);
    return { status: "discarded" };
  }, _store);
}

export async function confirmHoldingRemovalProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
): Promise<ActionResult> {
  return confirmTrashProposal(
    rawDraft,
    _testArgs,
    "holding_removal",
    (store, targets, clock) => store.batchSoftDeleteHoldings(targets, clock.now()),
  );
}

export async function discardHoldingRemovalProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
): Promise<ActionResult> {
  return discardTrashProposal(rawDraft, _testArgs, "holding_removal");
}

export async function confirmHoldingRestorationProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
): Promise<ActionResult> {
  return confirmTrashProposal(
    rawDraft,
    _testArgs,
    "holding_restoration",
    (store, targets) => store.batchRestoreHoldings(targets),
  );
}

export async function discardHoldingRestorationProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
): Promise<ActionResult> {
  return discardTrashProposal(rawDraft, _testArgs, "holding_restoration");
}
