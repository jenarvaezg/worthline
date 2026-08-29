/**
 * The Numista coin-collection ficha (PRD #160, ADR 0016).
 *
 * A collection is `derived` like an investment, but its sub-detail is the
 * positions its connected source mirrors — not an operations ledger. So it reads
 * its source, its coins and its own decoupled valuation freshness (PRD #166),
 * and nothing else: no operations, no price cache for a quote it does not have,
 * no traspaso surface.
 */

import { CoinCollectionSection } from "@web/patrimonio/[id]/editar/_surfaces/coin-collection-section";
import type { CoinPosition } from "@worthline/domain";
import type { AssetFamilyContext, HoldingSurface } from "./family-contract";
import { holdingSurface } from "./family-contract";

export async function loadCoinCollectionSurface(
  ctx: AssetFamilyContext,
): Promise<HoldingSurface> {
  const { currentUrl, id, payoutsPanel, privacyMode, store } = ctx;

  // Resolve the source from the asset id, then read its coins. The valuation
  // freshness is this collection's OWN `numista`-source cache row (PRD #166),
  // separate from the investment price cache.
  const source =
    (await store.connectedSources.listSources()).find((s) => s.assetId === id) ?? null;
  const [positions, valuationCache] = await Promise.all([
    source
      ? store.connectedSources.readPositions(source.id)
      : Promise.resolve<never[]>([]),
    store.operations.readPriceCache(id),
  ]);

  return holdingSurface("coin-collection", {
    // «Lo básico» locks the identity fields: name, type and value are the
    // source's, not the user's (ADR 0016).
    basics: { isCoinCollection: true },
    body: (
      <>
        <CoinCollectionSection
          currentUrl={currentUrl}
          lastSyncAt={source?.lastSyncAt ?? null}
          positions={positions.filter((p): p is CoinPosition => p.kind === "coin")}
          privacyMode={privacyMode}
          sourceId={source?.id ?? null}
          valuationFreshness={valuationCache?.freshnessState ?? null}
          valuationStaleReason={valuationCache?.staleReason ?? null}
        />
        {payoutsPanel}
      </>
    ),
  });
}
