import { projectPortfolio } from "./portfolio-projection";
import type { ScopeOption } from "./scope";
import type { Liability, ManualAsset, Workspace } from "./workspace-types";

/**
 * The holding ids a scope owns — assets and liabilities alike — read off the
 * portfolio projection, which is what decides scope membership everywhere else.
 *
 * Extracted from the health engine (#654) so the FIRE savings-coherence read
 * (#1449) filters the operations ledger through the SAME door: the alert on the
 * home hero and the veto on the badge must be judged over one set of holdings, or
 * the two disagree about whose savings were measured.
 */
export function scopeOwnedHoldingIds(input: {
  workspace: Workspace;
  scopeOption: ScopeOption;
  assets: readonly ManualAsset[];
  liabilities: readonly Liability[];
}): Set<string> {
  const projection = projectPortfolio({
    assets: [...input.assets],
    liabilities: [...input.liabilities],
    scope: input.scopeOption,
    workspace: input.workspace,
  });
  return new Set([
    ...projection.sections[0].rows.map((row) => row.id),
    ...projection.sections[1].rows.map((row) => row.id),
  ]);
}
