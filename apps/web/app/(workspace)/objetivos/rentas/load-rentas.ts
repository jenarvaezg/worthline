/**
 * The Rentas read model (#1673): every declared income in the workspace — the ones
 * no asset generates, which have nowhere else to be seen, and the ones a holding
 * generates, which also live on its ficha — plus the name and ficha link of each
 * holding an income hangs from.
 *
 * And how the scope on screen lets the sustainable-spending card read an income
 * without an asset (#1811) — the only figure that reads one. Read even for an empty
 * list: an income declared a second ago is told, optimistically, the same answer.
 *
 * Cache-only GET: it reads the store and nothing else. The holdings are read only
 * when some income is linked to one — an empty list, or a list of pensions and
 * salaries, never pays for the ledger.
 */

import { holdingCobrosHref, holdingPublicIdIndex } from "@web/holding-route";
import type { WorthlineStore } from "@web/store";
import type { Income, StandaloneIncomeCardContext, Workspace } from "@worthline/domain";
import { standaloneIncomeCardContext } from "@worthline/domain";

/** What a linked income's row says about its holding. */
export interface IncomeHolding {
  name: string;
  /** The holding's Cobros section, or null when it has no public id to link by. */
  href: string | null;
}

export interface RentasReadModel {
  /**
   * Every income, in store order. The display order is the ledger's, applied once
   * after its optimistic fold (`sortIncomesForDisplay`).
   */
  incomes: Income[];
  /** The live holdings incomes are linked to, by internal id. */
  holdingById: Record<string, IncomeHolding>;
  /** The scope on screen, as the sustainable-spending card sees it. */
  cardContext: StandaloneIncomeCardContext;
}

export async function loadRentas({
  scopeId,
  store,
  today,
  workspace,
}: {
  /** The scope on screen — the one Objetivos would draw the card for. */
  scopeId: string;
  store: Pick<WorthlineStore, "agentView" | "assets" | "payouts" | "readFireConfig">;
  today: string;
  workspace: Workspace;
}): Promise<RentasReadModel> {
  const [incomes, fireConfig] = await Promise.all([
    store.payouts.readPayoutSchedules(),
    store.readFireConfig(today),
  ]);
  const cardContext = standaloneIncomeCardContext({
    retirementPlan: fireConfig[scopeId]?.retirementPlan,
    scopeId,
    workspace,
  });
  const linkedIds = new Set(
    incomes.flatMap((income) => (income.holdingId === null ? [] : [income.holdingId])),
  );
  if (linkedIds.size === 0) {
    return { cardContext, holdingById: {}, incomes };
  }

  const [assets, publicIdRows] = await Promise.all([
    store.assets.readAssets(),
    store.agentView.readPublicIds(),
  ]);
  const { publicByInternal } = holdingPublicIdIndex(publicIdRows);
  const holdingById: Record<string, IncomeHolding> = {};
  for (const asset of assets) {
    if (!linkedIds.has(asset.id)) continue;
    const publicId = publicByInternal.get(asset.id);
    holdingById[asset.id] = {
      name: asset.name,
      href: publicId === undefined ? null : holdingCobrosHref(publicId),
    };
  }
  return { cardContext, holdingById, incomes };
}
