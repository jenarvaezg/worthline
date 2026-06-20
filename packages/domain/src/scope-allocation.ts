/**
 * Scope allocation — the single place that answers "what share of this holding
 * belongs to this scope".
 *
 * Given a holding's amount (integer minor units) and its ownership split, plus
 * the set of member IDs that constitute the scope, returns:
 *   - ownedMinor   : the scope's share of the amount, rounded half-up
 *   - totalShareBps: the sum of basis-point stakes belonging to scope members
 *
 * Rounding delegates entirely to allocateByBps (money.ts).
 *
 * Consumers: calculateNetWorth, buildLiquidityBreakdown, projectPortfolio,
 * calculateFireForScope.
 */

import { allocateByBps } from "./money";
import type { OwnershipShare } from "./workspace-types";

export interface ScopedHolding {
  /** The scope's owned amount in integer minor units. */
  ownedMinor: number;
  /** Sum of ownership basis points belonging to the scope's members (0–10_000). */
  totalShareBps: number;
}

/**
 * Allocate a holding amount to a scope.
 *
 * @param amountMinor  - The holding's total value in integer minor units (may be negative for debts).
 * @param input.ownership      - All ownership shares on the holding.
 * @param input.scopeMemberIds - The set of member IDs that constitute the scope.
 */
export function allocateScopedHolding(
  amountMinor: number,
  input: {
    ownership: OwnershipShare[];
    scopeMemberIds: Set<string>;
  },
): ScopedHolding {
  const totalShareBps = input.ownership
    .filter((share) => input.scopeMemberIds.has(share.memberId))
    .reduce((sum, share) => sum + share.shareBps, 0);

  return {
    ownedMinor: allocateByBps(amountMinor, totalShareBps),
    totalShareBps,
  };
}
