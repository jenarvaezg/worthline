import { asc, eq } from "drizzle-orm";
import type { FactPersistenceProvenance } from "./fact-provenance";
import { assertIsoDate, assertMinorUnits } from "./liability-fact-guards";
import { liabilityBalanceAnchors } from "./schema";
import type { StoreContext } from "./store-context";

/** Input for a single balance anchor of a revolving/informal liability (slice 8). */
export interface AddBalanceAnchorInput {
  id: string;
  liabilityId: string;
  /** Total owed on that date, integer minor units (interest already included). */
  balanceMinor: number;
  /** YYYY-MM-DD the balance applies on. */
  anchorDate: string;
}

/** A stored balance anchor as read back from the store. */
export interface BalanceAnchorRecord {
  id: string;
  liabilityId: string;
  balanceMinor: number;
  anchorDate: string;
}

/** Fields that can be patched on an existing balance anchor. */
export interface UpdateBalanceAnchorInput {
  balanceMinor?: number;
  anchorDate?: string;
}

/**
 * Result of an in-place balance-anchor write (ADR 0025). `changes` is the 0/1
 * not-found contract; on a hit, `anchorDate`/`liabilityId` carry the OLD date and
 * owning liability the write read by id inside the transaction, so the seam can
 * derive the ripple from-date without the caller re-reading the row.
 */
export interface BalanceAnchorWriteResult {
  changes: number;
  anchorDate?: string;
  liabilityId?: string;
}

/**
 * Balance anchors: the dated fact of a revolving/informal debt — «on this date I
 * owed this much», interest already inside. One family, one module (#1604); an
 * anchor answers for the whole balance, so it never meets a plan.
 */
export interface BalanceAnchorStore {
  /** Add a balance anchor to a revolving/informal liability. */
  addBalanceAnchor: (
    input: AddBalanceAnchorInput,
    provenance?: FactPersistenceProvenance,
  ) => Promise<void>;
  /** Read a liability's balance anchors, ordered ascending by date. */
  readBalanceAnchors: (liabilityId: string) => Promise<BalanceAnchorRecord[]>;
  /**
   * Update a balance anchor in place. `changes` is 1 if updated, 0 if not found;
   * on a hit it also returns the OLD date + owning liability read by id (ADR 0025).
   */
  updateBalanceAnchor: (
    anchorId: string,
    input: UpdateBalanceAnchorInput,
  ) => Promise<BalanceAnchorWriteResult>;
  /**
   * Delete a balance anchor by id. `changes` is 1 if removed, 0 if not found; on a
   * hit it also returns the removed date + owning liability read by id (ADR 0025).
   */
  deleteBalanceAnchor: (anchorId: string) => Promise<BalanceAnchorWriteResult>;
}

export function createBalanceAnchorStore(ctx: StoreContext): BalanceAnchorStore {
  return {
    addBalanceAnchor: (input, opts) => addBalanceAnchor(ctx, input, opts),
    readBalanceAnchors: (liabilityId) => readBalanceAnchors(ctx, liabilityId),
    updateBalanceAnchor: (anchorId, input) => updateBalanceAnchor(ctx, anchorId, input),
    deleteBalanceAnchor: (anchorId) => deleteBalanceAnchor(ctx, anchorId),
  };
}

async function addBalanceAnchor(
  ctx: StoreContext,
  input: AddBalanceAnchorInput,
  provenance?: FactPersistenceProvenance,
): Promise<void> {
  assertMinorUnits(input.balanceMinor);
  assertIsoDate(input.anchorDate, "Anchor date");

  // The "liability must be revolving/informal" invariant is a domain/caller
  // guard (R9), not enforced here. The unique index on (liability_id,
  // anchor_date) keeps one anchor per liability per date — a collision throws.
  await ctx.db
    .insert(liabilityBalanceAnchors)
    .values({
      anchorDate: input.anchorDate,
      batchId: provenance?.batchId ?? null,
      balanceMinor: input.balanceMinor,
      id: input.id,
      liabilityId: input.liabilityId,
    })
    .run();

  await ctx.writeAuditEntry("add_balance_anchor", "liability", input.liabilityId, {
    anchorDate: input.anchorDate,
    anchorId: input.id,
    balanceMinor: input.balanceMinor,
  });
}

export async function readBalanceAnchors(
  ctx: StoreContext,
  liabilityId: string,
): Promise<BalanceAnchorRecord[]> {
  const rows = await ctx.db
    .select()
    .from(liabilityBalanceAnchors)
    .where(eq(liabilityBalanceAnchors.liabilityId, liabilityId))
    .orderBy(asc(liabilityBalanceAnchors.anchorDate), asc(liabilityBalanceAnchors.id))
    .all();

  return rows.map((row) => ({
    anchorDate: row.anchorDate,
    balanceMinor: row.balanceMinor,
    id: row.id,
    liabilityId: row.liabilityId,
  }));
}

async function updateBalanceAnchor(
  ctx: StoreContext,
  anchorId: string,
  input: UpdateBalanceAnchorInput,
): Promise<BalanceAnchorWriteResult> {
  if (input.balanceMinor !== undefined) {
    assertMinorUnits(input.balanceMinor);
  }
  if (input.anchorDate !== undefined) {
    assertIsoDate(input.anchorDate, "Anchor date");
  }

  // Widened by-id select (ADR 0025): the OLD date and owning liability are read
  // here, inside the transaction, so the seam derives the ripple from-date itself
  // without the caller re-reading the row first.
  const existing = await ctx.db
    .select({
      anchorDate: liabilityBalanceAnchors.anchorDate,
      liabilityId: liabilityBalanceAnchors.liabilityId,
    })
    .from(liabilityBalanceAnchors)
    .where(eq(liabilityBalanceAnchors.id, anchorId))
    .get();

  if (!existing) return { changes: 0 };

  const fields: Partial<typeof liabilityBalanceAnchors.$inferInsert> = {};
  if (input.balanceMinor !== undefined) fields.balanceMinor = input.balanceMinor;
  if (input.anchorDate !== undefined) fields.anchorDate = input.anchorDate;

  const result = await ctx.db
    .update(liabilityBalanceAnchors)
    .set(fields)
    .where(eq(liabilityBalanceAnchors.id, anchorId))
    .run();

  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry(
      "update_balance_anchor",
      "liability",
      existing.liabilityId,
      {
        anchorId,
        ...input,
      },
    );
  }
  return {
    anchorDate: existing.anchorDate,
    changes: result.rowsAffected,
    liabilityId: existing.liabilityId,
  };
}

async function deleteBalanceAnchor(
  ctx: StoreContext,
  anchorId: string,
): Promise<BalanceAnchorWriteResult> {
  // Widened by-id select (ADR 0025): the row's date and owning liability are read
  // inside the transaction so the seam ripples from the removed anchor's own date.
  const row = await ctx.db
    .select({
      anchorDate: liabilityBalanceAnchors.anchorDate,
      liabilityId: liabilityBalanceAnchors.liabilityId,
    })
    .from(liabilityBalanceAnchors)
    .where(eq(liabilityBalanceAnchors.id, anchorId))
    .get();

  if (!row) return { changes: 0 };

  const result = await ctx.db
    .delete(liabilityBalanceAnchors)
    .where(eq(liabilityBalanceAnchors.id, anchorId))
    .run();

  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry("delete_balance_anchor", "liability", row.liabilityId, {
      anchorId,
    });
  }
  return {
    anchorDate: row.anchorDate,
    changes: result.rowsAffected,
    liabilityId: row.liabilityId,
  };
}
