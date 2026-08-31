/**
 * Shared liability-domain reads — the live-liability projection and its hard
 * delete. Split out of `store-context.ts` (#1701): whoever reads where a
 * `Liability` comes from should land in a file that says so, not in the
 * connection/transaction/audit substrate every slice imports.
 */
import type { Liability, Workspace } from "@worthline/domain";
import { createLiability } from "@worthline/domain";
import { and, asc, eq, isNull } from "drizzle-orm";
import { readLiabilityOwnerships } from "./ownership-reads";
import {
  agentViewPublicIds,
  liabilities,
  liabilityOwnerships,
  warningOverrides,
} from "./schema";
import type { StoreContext, StoreDb } from "./store-context";

/**
 * Read every live (non-trashed) liability as a domain Liability. Shared by the
 * LiabilityStore (R3) and the monolith's historical-snapshot reconstruction and
 * export, so it lives here — the one shared-concerns home — rather than being
 * duplicated across the slices.
 */
export async function readLiabilities(
  db: StoreDb,
  workspace: Workspace | null,
): Promise<Liability[]> {
  if (!workspace) {
    return [];
  }

  const rows = await db
    .select({
      associatedAssetId: liabilities.associatedAssetId,
      balanceMinor: liabilities.currentBalanceMinor,
      currency: liabilities.currency,
      id: liabilities.id,
      name: liabilities.name,
      type: liabilities.type,
    })
    .from(liabilities)
    .where(isNull(liabilities.deletedAt))
    .orderBy(asc(liabilities.createdAt), asc(liabilities.id))
    .all();
  const ownershipByLiability = await readLiabilityOwnerships(db);

  return rows.map((row) =>
    // Reconstruction of already-persisted data never re-asserts the strict
    // "totals 100%" rule (that is a write-time concern). A debt on a co-owned
    // home is legitimately a known partial (#171), so accept ≤100% here — re-
    // asserting would turn a valid data state into a crash on every read.
    createLiability(
      workspace,
      {
        balanceMinor: row.balanceMinor,
        currency: row.currency,
        id: row.id,
        name: row.name,
        ownership: ownershipByLiability.get(row.id) ?? [],
        type: row.type,
        ...(row.associatedAssetId ? { associatedAssetId: row.associatedAssetId } : {}),
      },
      { allowKnownPartial: true },
    ),
  );
}

/**
 * Hard-delete one trashed liability in the caller's transaction. FK cascade
 * takes its ownerships; snapshots stay frozen (ADR 0008). Returns the number of
 * liability rows removed (0 when the id is unknown or not in the trash).
 *
 * Shared here because both the LiabilityStore (R3, via hardDeleteLiability) and
 * the monolith's emptyTrash run it — so the trash-delete semantics can never
 * drift.
 */
export async function hardDeleteLiabilityTx(
  ctx: StoreContext,
  liabilityId: string,
): Promise<number> {
  const { db } = ctx;
  const row = await db
    .select({
      name: liabilities.name,
      type: liabilities.type,
      deletedAt: liabilities.deletedAt,
    })
    .from(liabilities)
    .where(eq(liabilities.id, liabilityId))
    .get();

  if (!row || row.deletedAt === null) {
    return 0;
  }

  const ownership = await db
    .select({
      memberId: liabilityOwnerships.memberId,
      shareBps: liabilityOwnerships.shareBps,
    })
    .from(liabilityOwnerships)
    .where(eq(liabilityOwnerships.liabilityId, liabilityId))
    .all();

  // FK cascade takes the ownerships; clear the warning overrides by hand (no FK
  // points at them); snapshots stay frozen (ADR 0008).
  await db
    .delete(warningOverrides)
    .where(eq(warningOverrides.entityId, liabilityId))
    .run();
  // Drop the holding's agent-view public id on HARD delete only (#335); a
  // soft-delete/trash keeps it so a restore stays stable.
  await db
    .delete(agentViewPublicIds)
    .where(
      and(
        eq(agentViewPublicIds.entityType, "holding"),
        eq(agentViewPublicIds.entityId, liabilityId),
      ),
    )
    .run();
  const result = await db
    .delete(liabilities)
    .where(eq(liabilities.id, liabilityId))
    .run();

  await ctx.writeAuditEntry("hard_delete_liability", "liability", liabilityId, {
    name: row.name,
    ownership,
    type: row.type,
  });

  return result.rowsAffected;
}
