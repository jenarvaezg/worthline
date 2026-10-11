/**
 * The Rentas read model (#1673): every declared income in the workspace — the ones
 * no asset generates, which have nowhere else to be seen, and the ones a holding
 * generates, which also live on its ficha — plus the name and ficha link of each
 * holding an income hangs from.
 *
 * Cache-only GET: it reads the store and nothing else. The holdings are read only
 * when some income is linked to one — an empty list, or a list of pensions and
 * salaries, never pays for the ledger.
 */

import { holdingCobrosHref, holdingPublicIdIndex } from "@web/holding-route";
import type { WorthlineStore } from "@web/store";
import type { Income } from "@worthline/domain";

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
}

export async function loadRentas({
  store,
}: {
  store: Pick<WorthlineStore, "agentView" | "assets" | "payouts">;
}): Promise<RentasReadModel> {
  const incomes = await store.payouts.readPayoutSchedules();
  const linkedIds = new Set(
    incomes.flatMap((income) => (income.holdingId === null ? [] : [income.holdingId])),
  );
  if (linkedIds.size === 0) {
    return { holdingById: {}, incomes };
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
  return { holdingById, incomes };
}
