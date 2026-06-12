import type { CreateLiabilityInput, Liability, OwnershipShare } from "@worthline/domain";
import { createLiability } from "@worthline/domain";

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
  const { sqlite } = ctx;
  const workspace = ctx.getWorkspace();

  if (!workspace) {
    throw new Error("Workspace must be initialized before creating liabilities.");
  }

  const liability = createLiability(workspace, input);
  const insert = sqlite.transaction(() => {
    sqlite
      .prepare(
        `
        INSERT INTO liabilities (
          id,
          name,
          type,
          currency,
          current_balance_minor,
          associated_asset_id
        )
        VALUES (
          @id,
          @name,
          @type,
          @currency,
          @currentBalanceMinor,
          @associatedAssetId
        )
      `,
      )
      .run({
        associatedAssetId: liability.associatedAssetId ?? null,
        currency: liability.currency,
        currentBalanceMinor: liability.currentBalance.amountMinor,
        id: liability.id,
        name: liability.name,
        type: liability.type,
      });

    const insertOwnership = sqlite.prepare(`
      INSERT INTO liability_ownerships (liability_id, member_id, share_bps)
      VALUES (@liabilityId, @memberId, @shareBps)
    `);

    for (const share of liability.ownership) {
      insertOwnership.run({
        liabilityId: liability.id,
        memberId: share.memberId,
        shareBps: share.shareBps,
      });
    }
  });

  insert();
  ctx.writeAuditEntry("create_liability", "liability", liability.id);
}

function updateLiability(
  ctx: StoreContext,
  liabilityId: string,
  input: UpdateLiabilityInput,
): void {
  const { sqlite } = ctx;
  const updates: string[] = [];
  const params: unknown[] = [];

  if (input.name !== undefined) {
    updates.push("name = ?");
    params.push(input.name);
  }

  if (input.type !== undefined) {
    updates.push("type = ?");
    params.push(input.type);
  }

  if (input.associatedAssetId !== undefined) {
    updates.push("associated_asset_id = ?");
    params.push(input.associatedAssetId);
  }

  const editLiability = sqlite.transaction(() => {
    if (updates.length > 0) {
      updates.push("updated_at = CURRENT_TIMESTAMP");
      params.push(liabilityId);
      sqlite
        .prepare(`UPDATE liabilities SET ${updates.join(", ")} WHERE id = ?`)
        .run(...params);
    }

    if (input.ownership !== undefined) {
      sqlite
        .prepare(`DELETE FROM liability_ownerships WHERE liability_id = ?`)
        .run(liabilityId);

      const insertOwnership = sqlite.prepare(`
        INSERT INTO liability_ownerships (liability_id, member_id, share_bps)
        VALUES (@liabilityId, @memberId, @shareBps)
      `);

      for (const share of input.ownership) {
        insertOwnership.run({
          liabilityId,
          memberId: share.memberId,
          shareBps: share.shareBps,
        });
      }
    }
  });

  editLiability();
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
  const { sqlite } = ctx;

  if (!Number.isInteger(balanceMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }

  sqlite
    .prepare(
      `
      UPDATE liabilities
      SET current_balance_minor = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    )
    .run(balanceMinor, liabilityId);
  ctx.writeAuditEntry("update_balance", "liability", liabilityId, { balanceMinor });
}

function softDeleteLiability(
  ctx: StoreContext,
  liabilityId: string,
  deletedAt: string,
): number {
  const { sqlite } = ctx;
  const result = sqlite
    .prepare(`UPDATE liabilities SET deleted_at = ? WHERE id = ?`)
    .run(deletedAt, liabilityId);
  if (result.changes > 0) {
    ctx.writeAuditEntry("delete_liability", "liability", liabilityId, { deletedAt });
  }
  return result.changes;
}

function restoreLiability(ctx: StoreContext, liabilityId: string): number {
  const { sqlite } = ctx;
  const result = sqlite
    .prepare(
      `UPDATE liabilities SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`,
    )
    .run(liabilityId);
  if (result.changes > 0) {
    ctx.writeAuditEntry("restore_liability", "liability", liabilityId);
  }
  return result.changes;
}
