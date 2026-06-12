import type { CreateLiabilityInput, Liability, OwnershipShare } from "@worthline/domain";
import { createLiability } from "@worthline/domain";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { liabilities, liabilityOwnerships } from "./schema";
import {
  hardDeleteLiabilityTx,
  readLiabilities,
  type StoreContext,
} from "./store-context";

/** Fields that can be changed when editing an existing liability. */
export interface UpdateLiabilityInput {
  name?: string;
  type?: "mortgage" | "debt";
  associatedAssetId?: string | null;
  ownership?: OwnershipShare[];
}

/**
 * Liability persistence (Slice R3 of the architectural refactor, PRD #120 / #123).
 * Owns the live liability rows, their ownership, the balance valuation, and the
 * trash (soft delete / restore / hard delete). Reads return domain Liabilities;
 * see readLiabilities.
 */
export interface LiabilityStore {
  createLiability: (input: CreateLiabilityInput) => void;
  readLiabilities: () => Liability[];
  updateLiability: (liabilityId: string, input: UpdateLiabilityInput) => void;
  updateLiabilityBalance: (liabilityId: string, balanceMinor: number) => void;
  /** Soft-delete a liability (moves it to the trash). Returns 1 if moved, 0 if not found. */
  softDeleteLiability: (liabilityId: string, deletedAt: string) => number;
  /** Restore a trashed liability. Returns 1 if restored, 0 if not found or not in trash. */
  restoreLiability: (liabilityId: string) => number;
  /** Hard-delete a trashed liability (live data + overrides; snapshots untouched). Returns 1 if removed, 0 if not found or not in trash. */
  hardDeleteLiability: (liabilityId: string) => number;
}

export function createLiabilityStore(ctx: StoreContext): LiabilityStore {
  return {
    createLiability: (input) => createLiabilityRecord(ctx, input),
    readLiabilities: () => readLiabilities(ctx.sqlite, ctx.getWorkspace()),
    updateLiability: (liabilityId, input) => updateLiability(ctx, liabilityId, input),
    updateLiabilityBalance: (liabilityId, balanceMinor) =>
      updateLiabilityBalance(ctx, liabilityId, balanceMinor),
    softDeleteLiability: (liabilityId, deletedAt) =>
      softDeleteLiability(ctx, liabilityId, deletedAt),
    restoreLiability: (liabilityId) => restoreLiability(ctx, liabilityId),
    hardDeleteLiability: (liabilityId) =>
      ctx.sqlite.transaction(() => hardDeleteLiabilityTx(ctx, liabilityId))(),
  };
}

function createLiabilityRecord(ctx: StoreContext, input: CreateLiabilityInput): void {
  const { db } = ctx;
  const workspace = ctx.getWorkspace();

  if (!workspace) {
    throw new Error("Workspace must be initialized before creating liabilities.");
  }

  const liability = createLiability(workspace, input);
  ctx.transaction(() => {
    db.insert(liabilities)
      .values({
        associatedAssetId: liability.associatedAssetId ?? null,
        currency: liability.currency,
        currentBalanceMinor: liability.currentBalance.amountMinor,
        id: liability.id,
        name: liability.name,
        type: liability.type,
      })
      .run();

    if (liability.ownership.length > 0) {
      db.insert(liabilityOwnerships)
        .values(
          liability.ownership.map((share) => ({
            liabilityId: liability.id,
            memberId: share.memberId,
            shareBps: share.shareBps,
          })),
        )
        .run();
    }
  });

  ctx.writeAuditEntry("create_liability", "liability", liability.id);
}

function updateLiability(
  ctx: StoreContext,
  liabilityId: string,
  input: UpdateLiabilityInput,
): void {
  const { db } = ctx;
  const fields: Partial<typeof liabilities.$inferInsert> = {};

  if (input.name !== undefined) {
    fields.name = input.name;
  }

  if (input.type !== undefined) {
    fields.type = input.type;
  }

  if (input.associatedAssetId !== undefined) {
    fields.associatedAssetId = input.associatedAssetId;
  }

  ctx.transaction(() => {
    if (Object.keys(fields).length > 0) {
      db.update(liabilities)
        .set({ ...fields, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(liabilities.id, liabilityId))
        .run();
    }

    if (input.ownership !== undefined) {
      db.delete(liabilityOwnerships)
        .where(eq(liabilityOwnerships.liabilityId, liabilityId))
        .run();

      if (input.ownership.length > 0) {
        db.insert(liabilityOwnerships)
          .values(
            input.ownership.map((share) => ({
              liabilityId,
              memberId: share.memberId,
              shareBps: share.shareBps,
            })),
          )
          .run();
      }
    }
  });

  ctx.writeAuditEntry("update_liability", "liability", liabilityId, {
    ...input,
    ownership: undefined,
  });
}

function updateLiabilityBalance(
  ctx: StoreContext,
  liabilityId: string,
  balanceMinor: number,
): void {
  const { db } = ctx;

  if (!Number.isInteger(balanceMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }

  db.update(liabilities)
    .set({ currentBalanceMinor: balanceMinor, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(liabilities.id, liabilityId))
    .run();
  ctx.writeAuditEntry("update_balance", "liability", liabilityId, { balanceMinor });
}

function softDeleteLiability(
  ctx: StoreContext,
  liabilityId: string,
  deletedAt: string,
): number {
  const result = ctx.db
    .update(liabilities)
    .set({ deletedAt })
    .where(eq(liabilities.id, liabilityId))
    .run();
  if (result.changes > 0) {
    ctx.writeAuditEntry("delete_liability", "liability", liabilityId, { deletedAt });
  }
  return result.changes;
}

function restoreLiability(ctx: StoreContext, liabilityId: string): number {
  const result = ctx.db
    .update(liabilities)
    .set({ deletedAt: null })
    .where(and(eq(liabilities.id, liabilityId), isNotNull(liabilities.deletedAt)))
    .run();
  if (result.changes > 0) {
    ctx.writeAuditEntry("restore_liability", "liability", liabilityId);
  }
  return result.changes;
}
