import { PRICE_FAILURE_REASONS, type PriceProvider, type PriceSource } from "./index";

/**
 * A provider whose upstream is gone for good (#1354).
 *
 * When a source is retired, the rows that already point at it do not disappear —
 * a holding keeps its stored `price_provider` and its last good price. The refresh
 * path still has to answer *something* for them, and both easy answers are wrong:
 * skipping them silently freezes the price with no visible cause, and a permanent
 * failure would zero the cached price (`fetchAndCachePrice` only preserves a prior
 * good price on a TRANSIENT miss).
 *
 * So this fetches nothing and returns a transient failure with an actionable
 * reason: the last known price survives as `stale`, and the reason travels into
 * `stale_reason`, where it surfaces on the «Actualizar precios» digest and in the
 * agent view's price freshness — telling the user the one thing they can do about
 * it. (Salud de datos raises its usual STALE_PRICE for the holding; that signal
 * carries no reason text today.) It is "transient" in the mechanical sense the
 * cache layer means — do not discard the price — not a prediction that the
 * provider will come back.
 */
export function retiredPriceProvider(source: PriceSource): PriceProvider {
  return {
    name: source,
    fetchPrice: async () => ({
      failed: true,
      reason: PRICE_FAILURE_REASONS.providerRetired,
      transient: true,
    }),
  };
}
