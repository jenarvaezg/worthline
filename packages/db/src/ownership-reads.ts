/**
 * Shared ownership reads — flat `*_ownerships` rows grouped by the entity they
 * belong to. Split out of `store-context.ts` (#1701): a reader keyed on
 * `OwnershipShare` belongs in a file that says so.
 */
import type { OwnershipShare } from "@worthline/domain";
import { asc } from "drizzle-orm";

import { assetOwnerships, liabilityOwnerships } from "./schema";
import type { StoreDb } from "./store-context";

/** Group flat ownership rows into a map keyed by their owning entity id. */
export function groupOwnershipByOwner<Row extends { memberId: string; shareBps: number }>(
  rows: Row[],
  ownerIdOf: (row: Row) => string,
): Map<string, OwnershipShare[]> {
  const byOwner = new Map<string, OwnershipShare[]>();

  for (const row of rows) {
    const ownerId = ownerIdOf(row);
    const share: OwnershipShare = { memberId: row.memberId, shareBps: row.shareBps };
    const existing = byOwner.get(ownerId);

    if (existing) {
      existing.push(share);
    } else {
      byOwner.set(ownerId, [share]);
    }
  }

  return byOwner;
}

/** All asset ownership rows in one query, grouped by asset id (member order preserved). */
export async function readAssetOwnerships(
  db: StoreDb,
): Promise<Map<string, OwnershipShare[]>> {
  const rows = await db
    .select({
      assetId: assetOwnerships.assetId,
      memberId: assetOwnerships.memberId,
      shareBps: assetOwnerships.shareBps,
    })
    .from(assetOwnerships)
    .orderBy(asc(assetOwnerships.assetId), asc(assetOwnerships.memberId))
    .all();

  return groupOwnershipByOwner(rows, (row) => row.assetId);
}

/** All liability ownership rows in one query, grouped by liability id. Shared by
 *  the LiabilityStore (R3) and the monolith's export/historical reconstruction. */
export async function readLiabilityOwnerships(
  db: StoreDb,
): Promise<Map<string, OwnershipShare[]>> {
  const rows = await db
    .select({
      liabilityId: liabilityOwnerships.liabilityId,
      memberId: liabilityOwnerships.memberId,
      shareBps: liabilityOwnerships.shareBps,
    })
    .from(liabilityOwnerships)
    .orderBy(asc(liabilityOwnerships.liabilityId), asc(liabilityOwnerships.memberId))
    .all();

  return groupOwnershipByOwner(rows, (row) => row.liabilityId);
}
