import type {
  AssetPrice,
  CreateInvestmentOperationInput,
  CurrencyCode,
  DecimalString,
  Instant,
  InvestmentOperation,
  OperationCapture,
  OperationSource,
} from "@worthline/domain";
import { asDateKey, createInvestmentOperation, isTransferKind } from "@worthline/domain";
import { asc, eq, sql } from "drizzle-orm";

import { chunk } from "./chunk";
import type { FactPersistenceProvenance } from "./fact-provenance";

import {
  assetOperations,
  assetPriceCache,
  assets,
  contributionOccurrenceOperations,
  contributionOccurrenceReconciliations,
  liabilities,
} from "./schema";
import {
  operationCaptureColumns,
  operationTransferColumns,
  type StoreContext,
  toOperation,
} from "./store-context";
import {
  assertAssetAllowsOperationWrite,
  assertAssetAllowsStoredValuationWrite,
} from "./valuation-guard";

/** One confirmed value change from a value-update pass. */
export interface ValueUpdateCommand {
  id: string;
  newValueMinor: number;
}

/**
 * Investment-operation and price-cache persistence (Slice R4 of the
 * architectural refactor, PRD #120 / #124). Owns the asset_operations rows
 * (record / read / delete), the batch value-update passes that rewrite asset
 * (and liability) valuations in one transaction, and the asset_price_cache
 * (upsert / read).
 *
 * NOTE (PRD #120 candidate 4, completed in R12): every method here is on
 * Drizzle — recordOperation / upsertPrice (R11) plus deleteOperation and the
 * batch value-update passes (R12). The batch passes run one Drizzle UPDATE per
 * row inside ctx.transaction; the audit-entry and validation ordering match the
 * old prepared-statement loop exactly.
 *
 * The historical-snapshot ripple (ADR 0012, PRD #107) is NOT part of this
 * store: recordOperation and deleteOperation are pure persistence, and the
 * monolith composes the ripple alongside them at the call site (mirroring how
 * the web action already orchestrates the two methods).
 */
/** A statement-merge overwrite: replace an existing operation's values in place. */
export interface UpdateInvestmentOperationInput {
  id: string;
  /**
   * Deliberately narrower than `OperationKind`: a statement merge speaks buys
   * and sells only. A traspaso is written as a PAIR by its own gate (#1393), and
   * neither half can be minted — or turned into something else — one row at a time.
   */
  kind: "buy" | "sell";
  units: DecimalString;
  pricePerUnit: DecimalString;
  currency: CurrencyCode;
  feesMinor: number;
  occurredAt?: Instant;
  source?: OperationSource;
  /**
   * The apunte the new figures were converted from (#1401), or absent for a euro
   * one. An overwrite REPLACES the capture — including clearing it, which is what a
   * re-imported statement that now states euros means.
   */
  capture?: OperationCapture;
}

export interface OperationsStore {
  recordOperation: (
    input: CreateInvestmentOperationInput,
    provenance?: FactPersistenceProvenance,
  ) => Promise<void>;
  /**
   * Record a whole BATCH of operations in batched writes (#1440) — the shape a
   * statement import needs, where one round-trip per order is hundreds of
   * round-trips.
   */
  recordOperations: (
    inputs: readonly CreateInvestmentOperationInput[],
    provenance?: FactPersistenceProvenance,
  ) => Promise<void>;
  readOperations: (assetId: string) => Promise<InvestmentOperation[]>;
  /**
   * Delete ONE operation. Returns its asset id and date, or null if not found.
   *
   * Refuses half a traspaso: the pair is deleted through
   * {@link OperationsStore.deleteTransferPair}, which owns both rows (#1479).
   */
  deleteOperation: (
    operationId: string,
  ) => Promise<{ assetId: string; executedAt: string } | null>;
  /**
   * The `transferId` of ONE operation, or null when the row is not half a traspaso
   * (or does not exist) — the cheap lookup a caller holding an operation id needs to
   * tell «delete this row» from «undo this traspaso» (#1479). Keyed on the primary
   * key, so it costs a fraction of reading the holding's whole ledger to find out.
   */
  readTransferIdOf: (operationId: string) => Promise<string | null>;
  /**
   * Delete BOTH halves of one traspaso, by the id that ties them (#1479). Returns
   * one entry per deleted row — the two asset ids and dates the caller ripples —
   * or an empty array when no row carries that `transferId`.
   *
   * It is the mirror of the atomic write: a pair that entered the book together
   * leaves together, or the surviving half claims to be one movement with a row that
   * no longer exists — and on the destination, an inherited cost with nothing left
   * that explains it.
   */
  deleteTransferPair: (
    transferId: string,
  ) => Promise<Array<{ assetId: string; executedAt: string }>>;
  /**
   * Overwrite an existing operation's value fields in place (statement merge,
   * ADR 0018). The id, asset, and `executedAt` date are the match key and never
   * change — only kind/units/price/currency/fees are replaced (the file wins).
   * Returns the asset id and date so the caller can ripple, or null if not found.
   */
  updateOperation: (
    input: UpdateInvestmentOperationInput,
  ) => Promise<{ assetId: string; executedAt: string } | null>;
  batchApplyValueUpdates: (commands: ValueUpdateCommand[]) => Promise<void>;
  batchApplyAllValueUpdates: (
    assetCommands: ValueUpdateCommand[],
    liabilityCommands: ValueUpdateCommand[],
  ) => Promise<void>;
  upsertPrice: (price: AssetPrice) => Promise<void>;
  /** Persist many price-cache rows in one transaction (fewer Turso round-trips). */
  upsertPrices: (prices: AssetPrice[]) => Promise<void>;
  clearPriceCache: (assetId: string) => Promise<number>;
  readPriceCache: (assetId: string) => Promise<AssetPrice | null>;
  readAllPriceCacheEntries: () => Promise<AssetPrice[]>;
}

export function createOperationsStore(ctx: StoreContext): OperationsStore {
  return {
    recordOperation: (input, opts) => recordOperations(ctx, [input], opts),
    recordOperations: (inputs, opts) => recordOperations(ctx, inputs, opts),
    readOperations: (assetId) => readOperations(ctx, assetId),
    deleteOperation: (operationId) => deleteOperation(ctx, operationId),
    readTransferIdOf: (operationId) => readTransferIdOf(ctx, operationId),
    deleteTransferPair: (transferId) => deleteTransferPair(ctx, transferId),
    updateOperation: (input) => updateOperation(ctx, input),
    batchApplyValueUpdates: (commands) => batchApplyValueUpdates(ctx, commands),
    batchApplyAllValueUpdates: (assetCommands, liabilityCommands) =>
      batchApplyAllValueUpdates(ctx, assetCommands, liabilityCommands),
    upsertPrice: (price) => upsertPrice(ctx, price),
    upsertPrices: (prices) => upsertPrices(ctx, prices),
    clearPriceCache: (assetId) => clearPriceCache(ctx, assetId),
    readPriceCache: (assetId) => readPriceCache(ctx, assetId),
    readAllPriceCacheEntries: () => readAllPriceCacheEntries(ctx),
  };
}

/**
 * Operation rows per batched INSERT. ~18 columns each, so a group of 50 stays
 * well below the per-statement parameter cap (#1440).
 */
const OPERATIONS_PER_INSERT = 50;

function operationRow(
  input: CreateInvestmentOperationInput,
  provenance?: FactPersistenceProvenance,
) {
  const operation = createInvestmentOperation(input);
  return {
    assetId: operation.assetId,
    batchId: provenance?.batchId ?? null,
    ...operationCaptureColumns(operation.capture),
    currency: operation.currency,
    executedAt: asDateKey(operation.executedAt.slice(0, 10)),
    feesMinor: operation.feesMinor,
    id: operation.id,
    kind: operation.kind,
    occurredAt: operation.occurredAt ?? null,
    pricePerUnit: operation.pricePerUnit,
    source: operation.source ?? "manual",
    ...operationTransferColumns(operation),
    units: operation.units,
  };
}

/**
 * Persist a whole BATCH of operations (#1440). A statement import applies
 * hundreds of orders at once; one `await` per order is one round-trip per
 * order against a remote Turso, so the rows go in batched.
 *
 * A batch longer than one chunk spans several statements, so the CALLER owns the
 * transaction (the statement import applies the batch inside `ctx.transaction`,
 * ADR 0020) — without it a long batch could land half-written.
 */
async function recordOperations(
  ctx: StoreContext,
  inputs: readonly CreateInvestmentOperationInput[],
  provenance?: FactPersistenceProvenance,
): Promise<void> {
  if (inputs.length === 0) return;

  for (const assetId of new Set(inputs.map((input) => input.assetId))) {
    await assertAssetAllowsOperationWrite(ctx, assetId);
  }

  const rows = inputs.map((input) => operationRow(input, provenance));
  for (const group of chunk(rows, OPERATIONS_PER_INSERT)) {
    await ctx.db.insert(assetOperations).values(group).run();
  }
}

async function readOperations(
  ctx: StoreContext,
  assetId: string,
): Promise<InvestmentOperation[]> {
  const rows = await ctx.db
    .select()
    .from(assetOperations)
    .where(eq(assetOperations.assetId, assetId))
    .orderBy(
      asc(assetOperations.executedAt),
      asc(assetOperations.occurredAt),
      asc(assetOperations.id),
    )
    .all();
  return rows.map(toOperation);
}

async function deleteOperation(
  ctx: StoreContext,
  operationId: string,
): Promise<{ assetId: string; executedAt: string } | null> {
  const kind = await ctx.db
    .select({ kind: assetOperations.kind })
    .from(assetOperations)
    .where(eq(assetOperations.id, operationId))
    .get();

  // Half a traspaso is not a deletable unit (#1393). Same hazard as the statement
  // merge overwriting one row: the pair's atomic gate owns both, and a caller holding
  // one id calls `deleteTransferPair` with the `transferId` instead.
  if (kind && isTransferKind(kind.kind)) {
    throw new Error(
      "Half a traspaso cannot be deleted on its own; delete the pair (#1393).",
    );
  }

  return removeOperationRow(ctx, operationId);
}

async function readTransferIdOf(
  ctx: StoreContext,
  operationId: string,
): Promise<string | null> {
  const row = await ctx.db
    .select({ transferId: assetOperations.transferId })
    .from(assetOperations)
    .where(eq(assetOperations.id, operationId))
    .get();

  return row?.transferId ?? null;
}

/**
 * Delete both rows of one traspaso. The rows are read first so the caller learns
 * every (asset, date) it has to ripple, and each is removed through the same
 * `removeOperationRow` a single delete uses — so the audit entry and the
 * contribution-occurrence bookkeeping are identical, whichever door the row left by.
 *
 * No transaction here: the command layer brackets this with its ripple (ADR 0020), and
 * a nested transaction would commit the deletes before the ripple could roll them back.
 */
async function deleteTransferPair(
  ctx: StoreContext,
  transferId: string,
): Promise<Array<{ assetId: string; executedAt: string }>> {
  const rows = await ctx.db
    .select({ id: assetOperations.id })
    .from(assetOperations)
    .where(eq(assetOperations.transferId, transferId))
    .all();

  const deleted: Array<{ assetId: string; executedAt: string }> = [];
  for (const { id } of rows) {
    const result = await removeOperationRow(ctx, id);
    if (result) deleted.push(result);
  }
  return deleted;
}

async function removeOperationRow(
  ctx: StoreContext,
  operationId: string,
): Promise<{ assetId: string; executedAt: string } | null> {
  const { db } = ctx;
  const row = await db
    .select({
      assetId: assetOperations.assetId,
      kind: assetOperations.kind,
      occurredAt: assetOperations.occurredAt,
      executedAt: assetOperations.executedAt,
      units: assetOperations.units,
      pricePerUnit: assetOperations.pricePerUnit,
      currency: assetOperations.currency,
      feesMinor: assetOperations.feesMinor,
      source: assetOperations.source,
    })
    .from(assetOperations)
    .where(eq(assetOperations.id, operationId))
    .get();

  if (!row) {
    return null;
  }

  const reconciliation = await db
    .select({
      occurrenceId: contributionOccurrenceOperations.occurrenceId,
      state: contributionOccurrenceReconciliations.state,
    })
    .from(contributionOccurrenceOperations)
    .innerJoin(
      contributionOccurrenceReconciliations,
      eq(
        contributionOccurrenceReconciliations.occurrenceId,
        contributionOccurrenceOperations.occurrenceId,
      ),
    )
    .where(eq(contributionOccurrenceOperations.operationId, operationId))
    .get();

  await db.delete(assetOperations).where(eq(assetOperations.id, operationId)).run();
  if (reconciliation?.state === "fulfilled") {
    const remaining = await db
      .select({ id: contributionOccurrenceOperations.operationId })
      .from(contributionOccurrenceOperations)
      .where(
        eq(contributionOccurrenceOperations.occurrenceId, reconciliation.occurrenceId),
      )
      .get();
    if (!remaining) {
      await db
        .update(contributionOccurrenceReconciliations)
        .set({ state: "open", updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(
          eq(
            contributionOccurrenceReconciliations.occurrenceId,
            reconciliation.occurrenceId,
          ),
        )
        .run();
    }
  }

  // Audit against the owning asset so the deletion shows in its history;
  // the full operation is recorded, making manual re-entry a de facto undo.
  await ctx.writeAuditEntry("delete_operation", "asset", row.assetId, {
    currency: row.currency,
    executedAt: row.executedAt,
    feesMinor: row.feesMinor,
    kind: row.kind,
    occurredAt: row.occurredAt,
    operationId,
    pricePerUnit: row.pricePerUnit,
    source: row.source,
    units: row.units,
  });

  return { assetId: row.assetId, executedAt: row.executedAt };
}

async function updateOperation(
  ctx: StoreContext,
  input: UpdateInvestmentOperationInput,
): Promise<{ assetId: string; executedAt: string } | null> {
  const { db } = ctx;

  if (!Number.isInteger(input.feesMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }

  const row = await db
    .select({
      assetId: assetOperations.assetId,
      executedAt: assetOperations.executedAt,
      kind: assetOperations.kind,
    })
    .from(assetOperations)
    .where(eq(assetOperations.id, input.id))
    .get();

  if (!row) {
    return null;
  }

  // A merge that lands on half a traspaso stops here, loudly (#1393). The match is
  // made on asset + date + figures, so a statement listing the day the capital left
  // CAN point at a `transfer_out`; rewriting it as a sale would realize a gain that
  // never happened and orphan the other half in silence. Deleting a half is the same
  // hazard and belongs to the pair's own gate (#1479), which owns both rows.
  if (isTransferKind(row.kind)) {
    throw new Error(
      "A transfer operation cannot be overwritten one row at a time (#1393).",
    );
  }

  await assertAssetAllowsOperationWrite(ctx, row.assetId);

  await db
    .update(assetOperations)
    .set({
      // Replaced, never merged: an overwrite whose row is euros now must CLEAR a
      // capture the previous import wrote, or the ficha would keep showing dollars
      // that no longer back the stored figure (#1401).
      ...operationCaptureColumns(input.capture),
      currency: input.currency,
      feesMinor: input.feesMinor,
      kind: input.kind,
      occurredAt: input.occurredAt ?? null,
      pricePerUnit: input.pricePerUnit,
      source: input.source ?? "statement",
      units: input.units,
    })
    .where(eq(assetOperations.id, input.id))
    .run();

  await ctx.writeAuditEntry("update_operation", "asset", row.assetId, {
    currency: input.currency,
    executedAt: row.executedAt,
    feesMinor: input.feesMinor,
    kind: input.kind,
    operationId: input.id,
    occurredAt: input.occurredAt ?? null,
    pricePerUnit: input.pricePerUnit,
    source: input.source ?? "statement",
    units: input.units,
  });

  return { assetId: row.assetId, executedAt: row.executedAt };
}

async function batchApplyValueUpdates(
  ctx: StoreContext,
  commands: ValueUpdateCommand[],
): Promise<void> {
  if (commands.length === 0) return;

  const { db, writeAuditEntry } = ctx;
  await ctx.transaction(async () => {
    for (const cmd of commands) {
      if (!Number.isInteger(cmd.newValueMinor)) {
        throw new Error("Money must be stored as integer minor units.");
      }
      await assertAssetAllowsStoredValuationWrite(ctx, cmd.id);
      await db
        .update(assets)
        .set({ currentValueMinor: cmd.newValueMinor, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(assets.id, cmd.id))
        .run();
      await writeAuditEntry("update_valuation", "asset", cmd.id, {
        currentValueMinor: cmd.newValueMinor,
      });
    }
  });
}

async function batchApplyAllValueUpdates(
  ctx: StoreContext,
  assetCommands: ValueUpdateCommand[],
  liabilityCommands: ValueUpdateCommand[],
): Promise<void> {
  const allCommands = [...assetCommands, ...liabilityCommands];
  if (allCommands.length === 0) return;

  const { db, writeAuditEntry } = ctx;

  // Validate ALL amounts before any write.
  for (const cmd of allCommands) {
    if (!Number.isInteger(cmd.newValueMinor)) {
      throw new Error("Money must be stored as integer minor units.");
    }
  }

  await ctx.transaction(async () => {
    for (const cmd of assetCommands) {
      await assertAssetAllowsStoredValuationWrite(ctx, cmd.id);
      await db
        .update(assets)
        .set({ currentValueMinor: cmd.newValueMinor, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(assets.id, cmd.id))
        .run();
      await writeAuditEntry("update_valuation", "asset", cmd.id, {
        currentValueMinor: cmd.newValueMinor,
      });
    }
    for (const cmd of liabilityCommands) {
      await db
        .update(liabilities)
        .set({
          currentBalanceMinor: cmd.newValueMinor,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(liabilities.id, cmd.id))
        .run();
      await writeAuditEntry("update_balance", "liability", cmd.id, {
        balanceMinor: cmd.newValueMinor,
      });
    }
  });
}

function priceCacheRowValues(price: AssetPrice, updatedAt: string) {
  return {
    assetId: price.assetId,
    currency: price.currency,
    fetchedAt: price.fetchedAt,
    freshnessState: price.freshnessState,
    price: price.price,
    priceDate: price.priceDate ?? null,
    source: price.source,
    staleReason: price.staleReason ?? null,
    updatedAt,
  };
}

async function upsertPrices(ctx: StoreContext, prices: AssetPrice[]): Promise<void> {
  if (prices.length === 0) return;

  const db = ctx.db;
  const now = new Date().toISOString();

  await ctx.transaction(async () => {
    for (const price of prices) {
      await db
        .insert(assetPriceCache)
        .values(priceCacheRowValues(price, now))
        .onConflictDoUpdate({
          target: assetPriceCache.assetId,
          set: {
            currency: price.currency,
            fetchedAt: price.fetchedAt,
            freshnessState: price.freshnessState,
            price: price.price,
            priceDate: price.priceDate ?? null,
            source: price.source,
            staleReason: price.staleReason ?? null,
            updatedAt: now,
          },
        })
        .run();
    }
  });
}

async function upsertPrice(ctx: StoreContext, price: AssetPrice): Promise<void> {
  await upsertPrices(ctx, [price]);
}

async function clearPriceCache(ctx: StoreContext, assetId: string): Promise<number> {
  const result = await ctx.db
    .delete(assetPriceCache)
    .where(eq(assetPriceCache.assetId, assetId))
    .run();
  return result.rowsAffected;
}

async function readPriceCache(
  ctx: StoreContext,
  assetId: string,
): Promise<AssetPrice | null> {
  const row = await ctx.db
    .select()
    .from(assetPriceCache)
    .where(eq(assetPriceCache.assetId, assetId))
    .get();

  if (!row) return null;

  return {
    assetId: row.assetId,
    currency: row.currency,
    fetchedAt: row.fetchedAt,
    freshnessState: row.freshnessState,
    price: row.price,
    source: row.source,
    ...(row.priceDate ? { priceDate: row.priceDate } : {}),
    ...(row.staleReason ? { staleReason: row.staleReason } : {}),
  };
}

async function readAllPriceCacheEntries(ctx: StoreContext): Promise<AssetPrice[]> {
  const rows = await ctx.db.select().from(assetPriceCache).all();

  return rows.map((row) => ({
    assetId: row.assetId,
    currency: row.currency,
    fetchedAt: row.fetchedAt,
    freshnessState: row.freshnessState,
    price: row.price,
    source: row.source,
    ...(row.priceDate ? { priceDate: row.priceDate } : {}),
    ...(row.staleReason ? { staleReason: row.staleReason } : {}),
  }));
}
