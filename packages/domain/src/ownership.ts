import { allocateByBps } from "./money";
import type { OwnershipShare } from "./workspace-types";

export function allocateOwnedMoneyMinor(
  amountMinor: number,
  input: {
    ownership: OwnershipShare[];
    scopeMemberIds: Set<string>;
  },
): number {
  const shareBps = input.ownership
    .filter((share) => input.scopeMemberIds.has(share.memberId))
    .reduce((sum, share) => sum + share.shareBps, 0);

  return allocateByBps(amountMinor, shareBps);
}
