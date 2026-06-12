import type {
  AssetPrice,
  CreateInvestmentOperationInput,
  InvestmentOperation,
} from "@worthline/domain";
import { createInvestmentOperation } from "@worthline/domain";
import { asc, eq } from "drizzle-orm";

import { assetOperations, assetPriceCache } from "./schema";
import { toOperation, type StoreContext } from "./store-context";

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
 * NOTE (PRD #120 candidate 4, R11–R12): the query patterns are deliberately
 * left mixed — upsertPrice / readPriceCache / readAllPriceCacheEntries use
 * drizzle, recordOperation / deleteOperation use raw SQL — exactly as the
 * monolith had them. A later slice owns unifying them.
 *
 * The historical-snapshot ripple (ADR 0012, PRD #107) is NOT part of this
 * store: recordOperation and deleteOperation are pure persistence, and the
 * monolith composes the ripple alongside them at the call site (mirroring how
 * the web action already orchestrates the two methods).
 */
export interface OperationsStore {
  recordOperation: (input: CreateInvestmentOperationInput) => void;
  readOperations: (assetId: string) => InvestmentOperation[];
  /** Delete an operation. Returns the deleted operation's asset id and date, or null if not found. */
  deleteOperation: (operationId: string) => { assetId: string; executedAt: string } | null;
  batchApplyValueUpdates: (commands: ValueUpdateCommand[]) => void;
  batchApplyAllValueUpdates: (
    assetCommands: ValueUpdateCommand[],
    liabilityCommands: ValueUpdateCommand[],
  ) => void;
  upsertPrice: (price: AssetPrice) => void;
  readPriceCache: (assetId: string) => AssetPrice | null;
  readAllPriceCacheEntries: () => AssetPrice[];
}

export function createOperationsStore(ctx: StoreContext): OperationsStore {
  return {
    recordOperation: (input) => recordOperation(ctx, input),
    readOperations: (assetId) => readOperations(ctx, assetId),
    deleteOperation: (operationId) => deleteOperation(ctx, operationId),
    batchApplyValueUpdates: (commands) => batchApplyValueUpdates(ctx, commands),
    batchApplyAllValueUpdates: (assetCommands, liabilityCommands) =>
      batchApplyAllValueUpdates(ctx, assetCommands, liabilityCommands),
    upsertPrice: (price) => upsertPrice(ctx, price),
    readPriceCache: (assetId) => readPriceCache(ctx, assetId),
    readAllPriceCacheEntries: () => readAllPriceCacheEntries(ctx),
  };
}

function recordOperation(ctx: StoreContext, input: CreateInvestmentOperationInput): void {
  const { sqlite } = ctx;
  const operation = createInvestmentOperation(input);

  sqlite
    .prepare(
      `
      INSERT INTO asset_operations (
        id,
        asset_id,
        kind,
        executed_at,
        units,
        price_per_unit,
        currency,
        fees_minor
      )
      VALUES (
        @id,
        @assetId,
        @kind,
        @executedAt,
        @units,
        @pricePerUnit,
        @currency,
        @feesMinor
      )
    `,
    )
    .run({
      assetId: operation.assetId,
      currency: operation.currency,
      executedAt: operation.executedAt,
      feesMinor: operation.feesMinor,
      id: operation.id,
      kind: operation.kind,
      pricePerUnit: operation.pricePerUnit,
      units: operation.units,
    });
}

function readOperations(ctx: StoreContext, assetId: string): InvestmentOperation[] {
  return ctx
    .db()
    .select()
    .from(assetOperations)
    .where(eq(assetOperations.assetId, assetId))
    .orderBy(asc(assetOperations.executedAt), asc(assetOperations.id))
    .all()
    .map(toOperation);
}

function deleteOperation(
  ctx: StoreContext,
  operationId: string,
): { assetId: string; executedAt: string } | null {
  const { sqlite } = ctx;
  const row = sqlite
    .prepare(
      `SELECT asset_id AS assetId, kind, executed_at AS executedAt, units,
              price_per_unit AS pricePerUnit, currency, fees_minor AS feesMinor
       FROM asset_operations WHERE id = ?`,
    )
    .get(operationId) as
    | {
        assetId: string;
        kind: string;
        executedAt: string;
        units: string;
        pricePerUnit: string;
        currency: string;
        feesMinor: number;
      }
    | undefined;

  if (!row) {
    return null;
  }

  sqlite.prepare(`DELETE FROM asset_operations WHERE id = ?`).run(operationId);

  // Audit against the owning asset so the deletion shows in its history;
  // the full operation is recorded, making manual re-entry a de facto undo.
  ctx.writeAuditEntry("delete_operation", "asset", row.assetId, {
    currency: row.currency,
    executedAt: row.executedAt,
    feesMinor: row.feesMinor,
    kind: row.kind,
    operationId,
    pricePerUnit: row.pricePerUnit,
    units: row.units,
  });

  return { assetId: row.assetId, executedAt: row.executedAt };
}

function batchApplyValueUpdates(ctx: StoreContext, commands: ValueUpdateCommand[]): void {
  if (commands.length === 0) return;

  const { sqlite, writeAuditEntry } = ctx;
  const applyAll = sqlite.transaction(() => {
    const update = sqlite.prepare(
      `UPDATE assets SET current_value_minor = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    );

    for (const cmd of commands) {
      if (!Number.isInteger(cmd.newValueMinor)) {
        throw new Error("Money must be stored as integer minor units.");
      }
      update.run(cmd.newValueMinor, cmd.id);
      writeAuditEntry("update_valuation", "asset", cmd.id, {
        currentValueMinor: cmd.newValueMinor,
      });
    }
  });

  applyAll();
}

function batchApplyAllValueUpdates(
  ctx: StoreContext,
  assetCommands: ValueUpdateCommand[],
  liabilityCommands: ValueUpdateCommand[],
): void {
  const allCommands = [...assetCommands, ...liabilityCommands];
  if (allCommands.length === 0) return;

  const { sqlite, writeAuditEntry } = ctx;

  // Validate ALL amounts before any write.
  for (const cmd of allCommands) {
    if (!Number.isInteger(cmd.newValueMinor)) {
      throw new Error("Money must be stored as integer minor units.");
    }
  }

  const applyAll = sqlite.transaction(() => {
    const updateAsset = sqlite.prepare(
      `UPDATE assets SET current_value_minor = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    );
    const updateLiability = sqlite.prepare(
      `UPDATE liabilities SET current_balance_minor = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    );

    for (const cmd of assetCommands) {
      updateAsset.run(cmd.newValueMinor, cmd.id);
      writeAuditEntry("update_valuation", "asset", cmd.id, {
        currentValueMinor: cmd.newValueMinor,
      });
    }
    for (const cmd of liabilityCommands) {
      updateLiability.run(cmd.newValueMinor, cmd.id);
      writeAuditEntry("update_balance", "liability", cmd.id, {
        balanceMinor: cmd.newValueMinor,
      });
    }
  });

  applyAll();
}

function upsertPrice(ctx: StoreContext, price: AssetPrice): void {
  const db = ctx.db();
  const now = new Date().toISOString();

  db.insert(assetPriceCache)
    .values({
      assetId: price.assetId,
      currency: price.currency,
      fetchedAt: price.fetchedAt,
      freshnessState: price.freshnessState,
      price: price.price,
      priceDate: price.priceDate ?? null,
      source: price.source,
      staleReason: price.staleReason ?? null,
      updatedAt: now,
    })
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

function readPriceCache(ctx: StoreContext, assetId: string): AssetPrice | null {
  const row = ctx
    .db()
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

function readAllPriceCacheEntries(ctx: StoreContext): AssetPrice[] {
  const rows = ctx.db().select().from(assetPriceCache).all();

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
