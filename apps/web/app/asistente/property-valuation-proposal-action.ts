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
import { createStableId } from "@web/intake";
import { readStoreTarget } from "@web/read-store-target";
import { systemClock } from "@worthline/domain";

import { parsePropertyValuationProposalDraft } from "./property-valuation-proposal-contract";
import {
  parsePropertyValuationAnchorInput,
  projectPropertyValuationProposal,
  valuationAnchorFromProposal,
} from "./property-valuation-proposals";

export async function confirmPropertyValuationProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  const _store = testStoreFromActionArgs(_testArgs);
  const clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  const target = await readStoreTarget();
  if (target.kind === "demo")
    return { status: "blocked" as const, message: DEMO_DISABLED_MESSAGE };
  if (target.kind === "authenticated" && target.impersonatedEmail !== undefined) {
    return { status: "blocked" as const, message: IMPERSONATION_READONLY_MESSAGE };
  }
  const parsed = parsePropertyValuationProposalDraft(rawDraft);
  if (!parsed.ok) return { status: "error" as const, message: parsed.error };
  return runActionWithStore(async (store) => {
    const proposal = await store.assistantProposals.read(parsed.draft.proposalId);
    if (!proposal || proposal.status !== "draft")
      return { status: "error" as const, message: "La propuesta ya no está disponible." };
    const anchor = valuationAnchorFromProposal(proposal);
    if (!anchor)
      return {
        status: "error" as const,
        message: "La propuesta no contiene una valoración inequívoca.",
      };
    const today = clock.today();
    const validated = parsePropertyValuationAnchorInput(anchor, today);
    if (!validated.ok) return { status: "error" as const, message: validated.error };
    const projected = await projectPropertyValuationProposal(
      store,
      validated.row.assetId,
      validated.row.valuationDate,
      validated.row.valueMinor,
      today,
    );
    if (!projected.ok) return { status: "error" as const, message: projected.error };
    await store.applyAssistantPropertyValuationProposalAndRipple({
      proposalId: proposal.id,
      today,
      anchor: {
        id: createStableId(
          "valuation_anchor",
          `${validated.row.assetId}_${validated.row.valuationDate}`,
          0,
        ),
        ...validated.row,
        adjustsPriorCurve: true,
        source: "agent",
      },
    });
    return { status: "applied" as const };
  }, _store);
}

export async function discardPropertyValuationProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  const _store = testStoreFromActionArgs(_testArgs);
  const target = await readStoreTarget();
  if (target.kind === "demo")
    return { status: "blocked" as const, message: DEMO_DISABLED_MESSAGE };
  if (target.kind === "authenticated" && target.impersonatedEmail !== undefined) {
    return { status: "blocked" as const, message: IMPERSONATION_READONLY_MESSAGE };
  }
  const parsed = parsePropertyValuationProposalDraft(rawDraft);
  if (!parsed.ok) return { status: "error" as const, message: parsed.error };
  return runActionWithStore(async (store) => {
    const proposal = await store.assistantProposals.read(parsed.draft.proposalId);
    if (
      !proposal ||
      proposal.kind !== "property_valuation_anchor" ||
      proposal.status !== "draft"
    ) {
      return { status: "error" as const, message: "La propuesta ya no está disponible." };
    }
    await store.assistantProposals.markDiscarded(proposal.id);
    return { status: "discarded" as const };
  }, _store);
}
