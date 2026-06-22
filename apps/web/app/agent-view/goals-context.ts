import type { AgentViewReadStore } from "@worthline/db";
import {
  assignedHoldingsValueMinor,
  goalFundedRatioBps,
  goalReservedMinor,
  resolveScopeMemberIds,
} from "@worthline/domain";

import type { AgentViewGoal } from "./contract";
import { ratioStringFromBps } from "./financial-context";
import { publicIdMap, requirePublicId, resolveInternalScopeId } from "./scope-resolution";

/**
 * The goals for a scope as `list_goals` exposes them (PRD #421, #424): each with
 * its target, deadline, priority, the public ids of its assigned holdings, and a
 * scope-weighted reserved amount + funded ratio. Reads only.
 *
 * The reserved amount is the scope-allocated value of the assigned holdings,
 * capped at the target (`goalReservedMinor`) — the same rule the FIRE-eligibility
 * slice (#426) will subtract, but here it only powers the funded ratio; goals do
 * not yet change any FIRE figure.
 */
export async function buildGoals(
  store: AgentViewReadStore,
  publicScopeId: string,
): Promise<AgentViewGoal[]> {
  const workspace = await store.readWorkspace();

  if (!workspace) {
    return [];
  }

  const internalScopeId = await resolveInternalScopeId(store, publicScopeId);
  const scopeMemberIds = new Set(resolveScopeMemberIds(workspace, internalScopeId));
  const goals = await store.readGoals(internalScopeId);
  const assetById = new Map((await store.readAssets()).map((asset) => [asset.id, asset]));
  const holdingPublicIds = publicIdMap(await store.readPublicIds(), "holding");
  const currency = workspace.baseCurrency;

  return goals.map((goal) => {
    const assignedMinor = assignedHoldingsValueMinor(
      goal.assetIds,
      assetById,
      scopeMemberIds,
    );
    // Public ids of the holdings the scope actually holds (a trashed/removed
    // holding is excluded from readAssets, so it never appears here).
    const assignedHoldings = goal.assetIds
      .filter((assetId) => assetById.has(assetId))
      .map((assetId) => requirePublicId(holdingPublicIds, assetId));

    const reservedMinor = goalReservedMinor(goal.targetAmountMinor, assignedMinor);

    return {
      object: "goal" as const,
      id: goal.id,
      name: goal.name,
      targetAmount: { amountMinor: goal.targetAmountMinor, currency },
      deadline: goal.deadline,
      priority: goal.priority,
      assignedHoldings,
      reservedAmount: { amountMinor: reservedMinor, currency },
      fundedRatio: ratioStringFromBps(
        goalFundedRatioBps(goal.targetAmountMinor, assignedMinor),
      ),
    };
  });
}
