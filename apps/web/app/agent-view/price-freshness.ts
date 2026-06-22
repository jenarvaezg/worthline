import type { AgentViewReadStore } from "@worthline/db";

import type { AgentViewPriceFreshnessResult } from "./contract";
import { resolveInternalHoldingId } from "./scope-resolution";

/**
 * Surface one holding's cached-price freshness (#466, PRD #417 S2), with no side
 * effects — a read never refreshes the price. Resolves the public `wl_hld_…` to
 * its internal asset id (an unknown id is a `404` via the shared resolver), then
 * reads the sanitized freshness off the price-cache row. A holding with no cached
 * provider quote (manual/derived) reports `freshness: null`, never a guess. The
 * `readPriceFreshness` port is secret-free, so no price figure or provider
 * payload can leak through here.
 */
export async function buildPriceFreshness(
  store: AgentViewReadStore,
  publicHoldingId: string,
): Promise<AgentViewPriceFreshnessResult> {
  const internalHoldingId = await resolveInternalHoldingId(store, publicHoldingId);
  const freshness = await store.readPriceFreshness(internalHoldingId);

  return {
    object: "price_freshness",
    holding: publicHoldingId,
    freshness: freshness
      ? {
          freshnessState: freshness.freshnessState,
          fetchedAt: freshness.fetchedAt,
          source: freshness.source,
          ...(freshness.staleReason === undefined
            ? {}
            : { staleReason: freshness.staleReason }),
        }
      : null,
  };
}
