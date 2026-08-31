import type {
  CreateLiabilityInput,
  DebtModel,
  Liability,
  OwnershipShare,
  ValuationCadence,
} from "@worthline/domain";
import { createLiability, defaultInstrumentForLiability } from "@worthline/domain";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  ensureAgentViewPublicIds,
  publicIdTargetsForHolding,
} from "./agent-view-public-ids";
import { assertMinorUnits } from "./liability-fact-guards";
import { hardDeleteLiabilityTx, readLiabilities } from "./liability-reads";
import { liabilities, liabilityOwnerships } from "./schema";
import type { StoreContext } from "./store-context";

/** Fields that can be changed when editing an existing liability. */
export interface UpdateLiabilityInput {
  name?: string;
  type?: "mortgage" | "debt";
  associatedAssetId?: string | null;
  ownership?: OwnershipShare[];
}

/**
 * The liability row itself (Slice R3 of the architectural refactor, PRD #120 /
 * #123): its ownership, its declared shape — debt model and valuation cadence —
 * its stored balance, and the trash (soft delete / restore / hard delete). Reads
 * return domain Liabilities; see readLiabilities.
 *
 * Deliberately thin (#1604): every dated fact of a debt — the amortization plan
 * and its rate revisions and early repayments, the balance re-baselines, the
 * anchors — is its own family in its own module, so a change to a curve never
 * lands here. The whole face callers consume is `LiabilityStore` in
 * `store-types.ts`, assembled by the store opener.
 */
export interface LiabilityRecordStore {
  createLiability: (input: CreateLiabilityInput) => Promise<void>;
  readLiabilities: () => Promise<Liability[]>;
  updateLiability: (liabilityId: string, input: UpdateLiabilityInput) => Promise<void>;
  updateLiabilityBalance: (liabilityId: string, balanceMinor: number) => Promise<void>;
  /** Soft-delete a liability (moves it to the trash). Returns 1 if moved, 0 if not found. */
  softDeleteLiability: (liabilityId: string, deletedAt: string) => Promise<number>;
  /** Restore a trashed liability. Returns 1 if restored, 0 if not found or not in trash. */
  restoreLiability: (liabilityId: string) => Promise<number>;
  /** Hard-delete a trashed liability (live data + overrides; snapshots untouched). Returns 1 if removed, 0 if not found or not in trash. */
  hardDeleteLiability: (liabilityId: string) => Promise<number>;
  /** Set (or clear, with null) a liability's debt model. */
  setDebtModel: (liabilityId: string, debtModel: DebtModel | null) => Promise<void>;
  /** Read a liability's debt model, or null if unset. */
  readDebtModel: (liabilityId: string) => Promise<DebtModel | null>;
  /** Set (or clear, with null) a liability's valuation cadence (ADR 0031). */
  setValuationCadence: (
    liabilityId: string,
    cadence: ValuationCadence | null,
  ) => Promise<void>;
  /** Read a liability's valuation cadence, or null (reads as `step`) if unset. */
  readValuationCadence: (liabilityId: string) => Promise<ValuationCadence | null>;
}

export function createLiabilityRecordStore(ctx: StoreContext): LiabilityRecordStore {
  return {
    createLiability: (input) => createLiabilityRecord(ctx, input),
    readLiabilities: async () => readLiabilities(ctx.db, await ctx.getWorkspace()),
    updateLiability: (liabilityId, input) => updateLiability(ctx, liabilityId, input),
    updateLiabilityBalance: (liabilityId, balanceMinor) =>
      updateLiabilityBalance(ctx, liabilityId, balanceMinor),
    softDeleteLiability: (liabilityId, deletedAt) =>
      softDeleteLiability(ctx, liabilityId, deletedAt),
    restoreLiability: (liabilityId) => restoreLiability(ctx, liabilityId),
    hardDeleteLiability: (liabilityId) =>
      ctx.transaction(async () => hardDeleteLiabilityTx(ctx, liabilityId)),
    setDebtModel: (liabilityId, debtModel) => setDebtModel(ctx, liabilityId, debtModel),
    readDebtModel: (liabilityId) => readDebtModel(ctx, liabilityId),
    setValuationCadence: (liabilityId, cadence) =>
      setValuationCadence(ctx, liabilityId, cadence),
    readValuationCadence: (liabilityId) => readValuationCadence(ctx, liabilityId),
  };
}

async function setDebtModel(
  ctx: StoreContext,
  liabilityId: string,
  debtModel: DebtModel | null,
): Promise<void> {
  await ctx.db
    .update(liabilities)
    .set({ debtModel, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(liabilities.id, liabilityId))
    .run();
  await ctx.writeAuditEntry("set_debt_model", "liability", liabilityId, { debtModel });
}

async function readDebtModel(
  ctx: StoreContext,
  liabilityId: string,
): Promise<DebtModel | null> {
  const row = await ctx.db
    .select({ debtModel: liabilities.debtModel })
    .from(liabilities)
    .where(eq(liabilities.id, liabilityId))
    .get();
  return row?.debtModel ?? null;
}

async function setValuationCadence(
  ctx: StoreContext,
  liabilityId: string,
  cadence: ValuationCadence | null,
): Promise<void> {
  await ctx.db
    .update(liabilities)
    .set({ valuationCadence: cadence, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(liabilities.id, liabilityId))
    .run();
  await ctx.writeAuditEntry("set_valuation_cadence", "liability", liabilityId, {
    cadence,
  });
}

async function readValuationCadence(
  ctx: StoreContext,
  liabilityId: string,
): Promise<ValuationCadence | null> {
  const row = await ctx.db
    .select({ valuationCadence: liabilities.valuationCadence })
    .from(liabilities)
    .where(eq(liabilities.id, liabilityId))
    .get();
  return row?.valuationCadence ?? null;
}

async function createLiabilityRecord(
  ctx: StoreContext,
  input: CreateLiabilityInput,
): Promise<void> {
  const { db } = ctx;
  const workspace = await ctx.getWorkspace();

  if (!workspace) {
    throw new Error("Workspace must be initialized before creating liabilities.");
  }

  // The split rule is enforced at the write boundary (createLiabilitySafe, which
  // allows a known partial for a debt on a co-owned home — #171). This low-level
  // persist only constructs the row, so it accepts ≤100% rather than re-asserting
  // strict 100% and rejecting an already-approved partial split.
  const liability = createLiability(workspace, input, { allowKnownPartial: true });
  await ctx.transaction(async () => {
    await db
      .insert(liabilities)
      .values({
        associatedAssetId: liability.associatedAssetId ?? null,
        currency: liability.currency,
        currentBalanceMinor: liability.currentBalance.amountMinor,
        id: liability.id,
        // Debt model is declared later (setDebtModel); at create time the
        // instrument follows the liability type (mortgage→mortgage, else loan).
        instrument: defaultInstrumentForLiability(liability.type, null),
        name: liability.name,
        type: liability.type,
      })
      .run();

    if (liability.ownership.length > 0) {
      await db
        .insert(liabilityOwnerships)
        .values(
          liability.ownership.map((share) => ({
            liabilityId: liability.id,
            memberId: share.memberId,
            shareBps: share.shareBps,
          })),
        )
        .run();
    }

    // Register the holding's agent-view public id on creation (#335) so the
    // non-lazy read path never 500s on a missing id — mirrors createMember.
    await ensureAgentViewPublicIds(ctx, publicIdTargetsForHolding(liability.id));
  });

  await ctx.writeAuditEntry("create_liability", "liability", liability.id);
}

async function updateLiability(
  ctx: StoreContext,
  liabilityId: string,
  input: UpdateLiabilityInput,
): Promise<void> {
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

  await ctx.transaction(async () => {
    if (Object.keys(fields).length > 0) {
      await db
        .update(liabilities)
        .set({ ...fields, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(liabilities.id, liabilityId))
        .run();
    }

    if (input.ownership !== undefined) {
      await db
        .delete(liabilityOwnerships)
        .where(eq(liabilityOwnerships.liabilityId, liabilityId))
        .run();

      if (input.ownership.length > 0) {
        await db
          .insert(liabilityOwnerships)
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

  await ctx.writeAuditEntry("update_liability", "liability", liabilityId, {
    ...input,
    ownership: undefined,
  });
}

async function updateLiabilityBalance(
  ctx: StoreContext,
  liabilityId: string,
  balanceMinor: number,
): Promise<void> {
  const { db } = ctx;

  assertMinorUnits(balanceMinor);

  await db
    .update(liabilities)
    .set({ currentBalanceMinor: balanceMinor, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(liabilities.id, liabilityId))
    .run();
  await ctx.writeAuditEntry("update_balance", "liability", liabilityId, { balanceMinor });
}

async function softDeleteLiability(
  ctx: StoreContext,
  liabilityId: string,
  deletedAt: string,
): Promise<number> {
  const result = await ctx.db
    .update(liabilities)
    .set({ deletedAt })
    .where(eq(liabilities.id, liabilityId))
    .run();
  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry("delete_liability", "liability", liabilityId, {
      deletedAt,
    });
  }
  return result.rowsAffected;
}

async function restoreLiability(ctx: StoreContext, liabilityId: string): Promise<number> {
  const result = await ctx.db
    .update(liabilities)
    .set({ deletedAt: null })
    .where(and(eq(liabilities.id, liabilityId), isNotNull(liabilities.deletedAt)))
    .run();
  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry("restore_liability", "liability", liabilityId);
  }
  return result.rowsAffected;
}
