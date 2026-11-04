/**
 * What a careo needs of a few holdings at once (#1881): each one's ledger, the
 * inputs its valuation reads (the usable cached price and the hand-set price, the
 * same two `deriveInvestmentValuation` takes) and the holdings its traspasos pair
 * it with. A fixed number of statements whatever the count, never one read per
 * holding (ADR 0030): the first start reads this on every visit to Conexiones.
 */
import type { DecimalString, InvestmentOperation } from "@worthline/domain";
import { compareInvestmentOperations, usableCachedPrice } from "@worthline/domain";
import { and, inArray, isNotNull, notInArray } from "drizzle-orm";

import { chunk } from "./chunk";
import { toOperation } from "./operation-reads";
import { assetOperations, assetPriceCache, investmentAssets } from "./schema";
import type { StoreContext } from "./store-context";

export interface HoldingLedger {
  operations: InvestmentOperation[];
  /** The cached quote the valuation would use; absent when none is usable. */
  cachedPrice?: DecimalString;
  /** The hand-set price; absent when none. */
  manualPrice?: DecimalString;
  /** Other holdings holding the other half of one of this ledger's traspasos. */
  transferCounterparts: string[];
}

/** Ids per `IN (…)`: well under the statement's parameter cap. */
const IDS_PER_QUERY = 200;

export async function readHoldingLedgers(
  ctx: StoreContext,
  assetIds: readonly string[],
): Promise<Map<string, HoldingLedger>> {
  const ids = [...new Set(assetIds)];
  const ledgers = new Map<string, HoldingLedger>(
    ids.map((id) => [id, { operations: [], transferCounterparts: [] }]),
  );
  if (ids.length === 0) return ledgers;

  for (const group of chunk(ids, IDS_PER_QUERY)) {
    const rows = await ctx.db
      .select()
      .from(assetOperations)
      .where(inArray(assetOperations.assetId, group))
      .all();
    for (const row of rows) ledgers.get(row.assetId)?.operations.push(toOperation(row));

    const prices = await ctx.db
      .select()
      .from(assetPriceCache)
      .where(inArray(assetPriceCache.assetId, group))
      .all();
    for (const row of prices) {
      const price = usableCachedPrice(row);
      const ledger = ledgers.get(row.assetId);
      if (ledger && price !== null) ledger.cachedPrice = price;
    }

    const meta = await ctx.db
      .select({
        assetId: investmentAssets.assetId,
        manualPricePerUnit: investmentAssets.manualPricePerUnit,
      })
      .from(investmentAssets)
      .where(inArray(investmentAssets.assetId, group))
      .all();
    for (const row of meta) {
      const ledger = ledgers.get(row.assetId);
      if (ledger && row.manualPricePerUnit) ledger.manualPrice = row.manualPricePerUnit;
    }
  }

  // A traspaso between two of these holdings has an owner on each side.
  const transferOwners = new Map<string, Set<string>>();
  for (const [assetId, ledger] of ledgers) {
    ledger.operations.sort(compareInvestmentOperations);
    for (const operation of ledger.operations) {
      if (!operation.transferId) continue;
      const owners = transferOwners.get(operation.transferId) ?? new Set<string>();
      owners.add(assetId);
      transferOwners.set(operation.transferId, owners);
    }
  }
  for (const group of chunk([...transferOwners.keys()], IDS_PER_QUERY)) {
    const halves = await ctx.db
      .select({
        assetId: assetOperations.assetId,
        transferId: assetOperations.transferId,
      })
      .from(assetOperations)
      .where(
        and(
          isNotNull(assetOperations.transferId),
          inArray(assetOperations.transferId, group),
        ),
      )
      .all();
    for (const half of halves) {
      const owners =
        half.transferId === null ? undefined : transferOwners.get(half.transferId);
      for (const owner of owners ?? []) {
        const ledger = ledgers.get(owner);
        if (!ledger || half.assetId === owner) continue;
        if (!ledger.transferCounterparts.includes(half.assetId)) {
          ledger.transferCounterparts.push(half.assetId);
        }
      }
    }
  }
  return ledgers;
}

/**
 * The traspasos that would be split if these holdings' operations were replaced:
 * a half whose other half lives in a holding that is NOT among them. Empty when
 * every pair is replaced whole. The gate that owns a pair removes both rows
 * together (#1393); a replacement must not leave one behind.
 */
export async function readSplitTransfers(
  ctx: StoreContext,
  assetIds: readonly string[],
): Promise<{ assetId: string; counterpartAssetId: string }[]> {
  const ids = [...new Set(assetIds)];
  if (ids.length === 0) return [];
  const own = await ctx.db
    .select({ assetId: assetOperations.assetId, transferId: assetOperations.transferId })
    .from(assetOperations)
    .where(
      and(inArray(assetOperations.assetId, ids), isNotNull(assetOperations.transferId)),
    )
    .all();
  const ownerByTransfer = new Map<string, string>();
  for (const row of own)
    if (row.transferId) ownerByTransfer.set(row.transferId, row.assetId);
  const split: { assetId: string; counterpartAssetId: string }[] = [];
  for (const group of chunk([...ownerByTransfer.keys()], IDS_PER_QUERY)) {
    const outside = await ctx.db
      .select({
        assetId: assetOperations.assetId,
        transferId: assetOperations.transferId,
      })
      .from(assetOperations)
      .where(
        and(
          inArray(assetOperations.transferId, group),
          notInArray(assetOperations.assetId, ids),
        ),
      )
      .all();
    for (const row of outside) {
      const owner = row.transferId ? ownerByTransfer.get(row.transferId) : undefined;
      if (owner) split.push({ assetId: owner, counterpartAssetId: row.assetId });
    }
  }
  return split;
}
