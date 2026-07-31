/**
 * The one projection of the current portfolio into S1 matcher holdings (#1331).
 *
 * The reconcile builder and the alta's duplicate warning both need the same thing —
 * every hand-maintained holding with its match keys — and both used to build it
 * inline. Two copies meant two chances to answer "is this position closed?"
 * differently, which is exactly the drift ADR 0055's amendment forbids: closed has
 * ONE definition (`isClosedPosition`, net units ≈ 0 over a real ledger), never a
 * value-is-zero guess — a live holding with no price symbol values at cost basis and
 * can read 0 € while holding units.
 *
 * Reads only. `closed` exists solely to RANK the claimants of a duplicated ISIN or
 * provider symbol (the same fund at two brokers): it never gates a match.
 */

import type {
  AgentViewReadStore,
  AssetStore,
  LiabilityStore,
  WorthlineStore,
} from "@worthline/db";
import type { MatchPortfolioHolding } from "@worthline/domain";
import {
  isClosedPosition,
  netUnitsByAsset,
  valuationMethodOfAsset,
} from "@worthline/domain";

/** The reads the projection needs — a narrow slice of any assistant store. */
export interface MatcherPortfolioStore {
  assets: Pick<
    WorthlineStore["assets"] & AssetStore,
    "readAssets" | "readInvestmentAssetsWithMeta"
  >;
  liabilities: Pick<WorthlineStore["liabilities"] & LiabilityStore, "readLiabilities">;
  /** Only for the per-holding ledger the closed test needs. */
  agentView: Pick<AgentViewReadStore, "readOperations">;
}

export interface MatcherPortfolioOptions {
  /**
   * Holdings that must never be offered as a match candidate — the reconcile passes
   * its connected-source-owned assets here ("no escribas a fuente conectada").
   */
  excludeAssetIds?: ReadonlySet<string>;
}

/**
 * Project assets + liabilities into matcher holdings, best-effort `closed` mark
 * included. The ledger is read for every `derived` holding (not only the ambiguous
 * ones): which holdings share a key is not known until the matcher runs, and a map
 * narrowed to today's candidates would under-populate the next caller — the same
 * reasoning the data-quality engine states for its required `netUnitsByAssetId`.
 */
export async function projectMatcherPortfolio(
  store: MatcherPortfolioStore,
  options: MatcherPortfolioOptions = {},
): Promise<MatchPortfolioHolding[]> {
  const excluded = options.excludeAssetIds ?? new Set<string>();
  const assets = (await store.assets.readAssets()).filter(
    (asset) => !excluded.has(asset.id),
  );
  const investmentMeta = await store.assets.readInvestmentAssetsWithMeta();
  const metaById = new Map(investmentMeta.map((meta) => [meta.id, meta]));

  const netUnitsByAssetId = netUnitsByAsset(
    new Map(
      await Promise.all(
        assets
          .filter((asset) => valuationMethodOfAsset(asset) === "derived")
          .map(
            async (asset) =>
              [asset.id, await store.agentView.readOperations(asset.id)] as const,
          ),
      ),
    ),
  );

  const assetHoldings: MatchPortfolioHolding[] = assets.map((asset) => {
    const meta = metaById.get(asset.id);
    return {
      holdingId: asset.id,
      name: asset.name,
      ...(isClosedPosition(asset, netUnitsByAssetId) ? { closed: true } : {}),
      ...(asset.instrument ? { instrument: asset.instrument } : {}),
      ...(meta?.isin ? { isin: meta.isin } : {}),
      ...((asset.providerSymbol ?? meta?.providerSymbol)
        ? { providerSymbol: asset.providerSymbol ?? meta?.providerSymbol ?? null }
        : {}),
    };
  });

  const liabilities = await store.liabilities.readLiabilities();
  const liabilityHoldings: MatchPortfolioHolding[] = liabilities.map((liability) => ({
    holdingId: liability.id,
    name: liability.name,
  }));
  return [...assetHoldings, ...liabilityHoldings];
}
