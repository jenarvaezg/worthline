import type { AgentViewReadStore } from "@worthline/db";
import {
  assignedHoldingsValueMinor,
  goalFundedRatioBps,
  goalReservedMinor,
  resolveScopeMemberIds,
  systemClock,
} from "@worthline/domain";

import type { AgentViewGoal } from "./contract";
import { ratioStringFromBps } from "./financial-context";
import { publicIdMap, requirePublicId } from "./scope-resolution";
import type { ScopedAgentView } from "./scoped-read";

/**
 * The goals for a scope as `list_goals` exposes them (PRD #421, #424): each with
 * its target, deadline, priority, the public ids of its assigned holdings, and a
 * scope-weighted reserved amount + funded ratio. Reads only.
 *
 * The reserved amount is the scope-allocated value of the assigned holdings,
 * capped at the target (`goalReservedMinor`). FIRE context/projection apply an
 * additional filter: only future in-horizon reservations backed by FIRE-eligible
 * assigned holdings reduce FIRE.
 */
export async function buildGoals(scoped: ScopedAgentView): Promise<AgentViewGoal[]> {
  const { store } = scoped;
  const workspace = await store.readWorkspace();

  if (!workspace) {
    return [];
  }

  const internalScopeId = await scoped.internalScopeId();
  const scopeMemberIds = new Set(resolveScopeMemberIds(workspace, internalScopeId));
  const goals = await store.readGoals(internalScopeId);
  // Curve-valued today so funded ratios count live housing values, matching FIRE.
  const { assets } = await store.readCurveValuedHoldings(systemClock().today());
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
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
