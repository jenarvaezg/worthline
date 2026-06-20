/**
 * The liquidity ladder (ADR 0013, ADR 0022): the single liquidity axis, an
 * ordered set of five pure-accessibility rungs. Each rung answers only "how
 * quickly and cheaply does this convert to cash?" — never *why* a holding is
 * locked or *what* it is (those live on the holding's instrument). The two top
 * rungs are liquid net worth (ADR 0003). `housing` is the least-accessible rung
 * (ADR 0022): every property instrument sits there, and a housing-secured
 * mortgage inherits it, so the rung's net is housing equity.
 */

/** The rungs, ordered most → least liquid. */
export const LIQUIDITY_LADDER = [
  "cash",
  "market",
  "term-locked",
  "illiquid",
  "housing",
] as const;

/** A holding's rung on the ladder. (CONTEXT.md keeps "tier" as a synonym for "rung".) */
export type LiquidityTier = (typeof LIQUIDITY_LADDER)[number];

/**
 * The single Spanish label per rung, shared by every surface that names a tier
 * (the dashboard donut, the composition/drill bands, the holding forms). One
 * source of truth so a rung's copy never drifts between views.
 */
export const LIQUIDITY_TIER_LABELS: Record<LiquidityTier, string> = {
  cash: "Caja",
  market: "Mercado",
  "term-locked": "A plazo",
  illiquid: "Ilíquido",
  housing: "Vivienda",
};

/** Liquid net worth is the top two rungs — cash + market (ADR 0003). */
export function isLiquid(rung: LiquidityTier): boolean {
  return rung === "cash" || rung === "market";
}

/**
 * The rung a liability sits on (ADR 0013, ADR 0022): an associated liability
 * inherits the rung of the asset it secures (netting against it — a mortgage
 * offsets its house on the `housing` rung); an unassociated debt, or one pointing
 * at an asset that is no longer present, lands on `cash` (a claim on liquid
 * resources for its full balance). This replaces the old invented default
 * (mortgage → housing, else → cash) that silently made informal loans erode
 * liquid net worth.
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
