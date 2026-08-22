import type { ManagedPortfolio } from "@worthline/domain";

import type { AgentViewHoldingPortfolioMembership } from "./contract";

/**
 * Membership lookup for the agent view (ADR 0085, #1547): internal holding id →
 * the ONE portfolio that holds it. Membership is exclusive by a UNIQUE index,
 * so a flat map is the whole shape — overlap would be a data error upstream.
 *
 * The portfolio's public id comes from the same registry rows the caller
 * already holds; a grouping without a registry row is skipped rather than
 * invented (the read surfaces degrade, they never fabricate an id).
 */
export function managedPortfoliosByAssetId(
  portfolios: readonly ManagedPortfolio[],
  publicIdByInternalPortfolio: ReadonlyMap<string, string>,
): ReadonlyMap<string, AgentViewHoldingPortfolioMembership> {
  const byAsset = new Map<string, AgentViewHoldingPortfolioMembership>();

  for (const portfolio of portfolios) {
    const publicId = publicIdByInternalPortfolio.get(portfolio.id);
    if (!publicId) continue;

    for (const assetId of portfolio.holdingIds) {
      if (!byAsset.has(assetId)) {
        byAsset.set(assetId, {
          id: publicId,
          label: portfolio.name,
          object: "managed_portfolio",
        });
      }
    }
  }

  return byAsset;
}
