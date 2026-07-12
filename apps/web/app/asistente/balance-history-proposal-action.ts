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

import {
  observationsFromProposal,
  parseBalanceHistoryProposalDraft,
  projectBalanceHistoryProposal,
} from "./balance-history-proposals";

export async function confirmBalanceHistoryProposalAction(
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
  const parsed = parseBalanceHistoryProposalDraft(rawDraft);
  if (!parsed.ok) return { status: "error" as const, message: parsed.error };
  return runActionWithStore(async (store) => {
    const proposal = await store.assistantProposals.read(parsed.draft.proposalId);
    if (!proposal || proposal.status !== "draft") {
      return { status: "error" as const, message: "La propuesta ya no está disponible." };
    }
    const observations = observationsFromProposal(proposal);
    if (!observations) {
      return {
        status: "error" as const,
        message: "La propuesta no contiene una deuda inequívoca.",
      };
    }
    const today = clock.today();
    const projected = await projectBalanceHistoryProposal(
      store,
      observations.liabilityId,
      observations.rows,
      today,
    );
    if (!projected.ok) return { status: "error" as const, message: projected.error };
    if (!projected.reconciliation.matches) {
      return {
        status: "error" as const,
        message: "La serie ya no reconcilia exactamente con el saldo actual de la deuda.",
      };
    }
    await store.applyAssistantBalanceHistoryProposalAndRipple({
      liabilityId: observations.liabilityId,
      proposalId: proposal.id,
      rebaselines: projected.plan.composed.map((row) => ({
        ...row,
        id: createStableId(
          "rebaseline",
          `${observations.liabilityId}_${row.baselineDate}`,
          0,
        ),
        liabilityId: observations.liabilityId,
        source: "agent" as const,
        startsAtBaseline: false,
      })),
      today,
    });
    return { status: "applied" as const, created: projected.plan.composed.length };
  }, _store);
}
