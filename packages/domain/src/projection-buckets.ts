/**
 * Shared per-holding bucket mutations for FIRE plan what-if and exposure-drift
 * what-if. Both already grow over the same contribution stream
 * (`contributionMoneyByProjectionYear`); the Map mutate loops live here once.
 * Callers supply their own rate function so STARTING_BUCKET / scenario-shift
 * vs look-through rates stay at the call site.
 */

export function growHoldingBuckets(
  buckets: Map<string, number>,
  rateFor: (holdingId: string) => number,
): void {
  for (const [holdingId, amount] of buckets) {
    buckets.set(holdingId, amount * (1 + rateFor(holdingId)));
  }
}

export function addHoldingContributions(
  buckets: Map<string, number>,
  contributions: Map<string, number> | undefined,
): number {
  if (contributions === undefined) {
    return 0;
  }
  let added = 0;
  for (const [holdingId, amountMinor] of contributions) {
    buckets.set(holdingId, (buckets.get(holdingId) ?? 0) + amountMinor);
    added += amountMinor;
  }
  return added;
}
