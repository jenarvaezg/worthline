/**
 * The liquidity ladder (ADR 0013): the single liquidity axis, an ordered set of
 * four pure-accessibility rungs. Each rung answers only "how quickly and cheaply
 * does this convert to cash?" — never *why* a holding is locked or *what* it is
 * (those live on the holding's instrument). The two top rungs are liquid net
 * worth (ADR 0003).
 */

/** The rungs, ordered most → least liquid. */
export const LIQUIDITY_LADDER = ["cash", "market", "term-locked", "illiquid"] as const;

/** A holding's rung on the ladder. (CONTEXT.md keeps "tier" as a synonym for "rung".) */
export type LiquidityTier = (typeof LIQUIDITY_LADDER)[number];

/** Liquid net worth is the top two rungs — cash + market (ADR 0003). */
export function isLiquid(rung: LiquidityTier): boolean {
  return rung === "cash" || rung === "market";
}

/**
 * The rung a liability sits on (ADR 0013): an associated liability inherits the
 * rung of the asset it secures (netting against it — a mortgage offsets its
 * house on `illiquid`); an unassociated debt, or one pointing at an asset that
 * is no longer present, lands on `cash` (a claim on liquid resources for its
 * full balance). This replaces the old invented default (mortgage → housing,
 * else → cash) that silently made informal loans erode liquid net worth.
 */
export function rungForLiability(
  liability: { associatedAssetId?: string },
  assetRungById: ReadonlyMap<string, LiquidityTier>,
): LiquidityTier {
  if (liability.associatedAssetId) {
    return assetRungById.get(liability.associatedAssetId) ?? "cash";
  }
  return "cash";
}
