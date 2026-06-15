import type {
  AssetPrice,
  CreateInvestmentOperationInput,
  CurrencyCode,
  DecimalString,
  InvestmentOperation,
  OperationKind,
} from "@worthline/domain";
import { createInvestmentOperation } from "@worthline/domain";
import { asc, eq, sql } from "drizzle-orm";

import { assetOperations, assetPriceCache, assets, liabilities } from "./schema";
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
  kind: OperationKind;
  units: DecimalString;
  pricePerUnit: DecimalString;
  currency: CurrencyCode;
  feesMinor: number;
}

export interface OperationsStore {
  recordOperation: (input: CreateInvestmentOperationInput) => void;
  readOperations: (assetId: string) => InvestmentOperation[];
  /** Delete an operation. Returns the deleted operation's asset id and date, or null if not found. */
  deleteOperation: (
    operationId: string,
  ) => { assetId: string; executedAt: string } | null;
  /**
   * Overwrite an existing operation's value fields in place (statement merge,
   * ADR 0018). The id, asset, and `executedAt` date are the match key and never
   * change — only kind/units/price/currency/fees are replaced (the file wins).
   * Returns the asset id and date so the caller can ripple, or null if not found.
   */
  updateOperation: (
    input: UpdateInvestmentOperationInput,
  ) => { assetId: string; executedAt: string } | null;
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
    updateOperation: (input) => updateOperation(ctx, input),
    batchApplyValueUpdates: (commands) => batchApplyValueUpdates(ctx, commands),
    batchApplyAllValueUpdates: (assetCommands, liabilityCommands) =>
      batchApplyAllValueUpdates(ctx, assetCommands, liabilityCommands),
    upsertPrice: (price) => upsertPrice(ctx, price),
    readPriceCache: (assetId) => readPriceCache(ctx, assetId),
    readAllPriceCacheEntries: () => readAllPriceCacheEntries(ctx),
  };
}

function recordOperation(ctx: StoreContext, input: CreateInvestmentOperationInput): void {
  const operation = createInvestmentOperation(input);

  // fees_minor has a DB default of 0; the domain constructor always supplies it,
  // matching the raw INSERT which also always passed @feesMinor.
  ctx.db
    .insert(assetOperations)
    .values({
      assetId: operation.assetId,
      currency: operation.currency,
      executedAt: operation.executedAt,
      feesMinor: operation.feesMinor,
      id: operation.id,
      kind: operation.kind,
      pricePerUnit: operation.pricePerUnit,
      units: operation.units,
    })
    .run();
}

function readOperations(ctx: StoreContext, assetId: string): InvestmentOperation[] {
  return ctx.db
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
  const { db } = ctx;
  const row = db
    .select({
      assetId: assetOperations.assetId,
      kind: assetOperations.kind,
      executedAt: assetOperations.executedAt,
      units: assetOperations.units,
      pricePerUnit: assetOperations.pricePerUnit,
      currency: assetOperations.currency,
      feesMinor: assetOperations.feesMinor,
    })
    .from(assetOperations)
    .where(eq(assetOperations.id, operationId))
    .get();

  if (!row) {
    return null;
  }

  db.delete(assetOperations).where(eq(assetOperations.id, operationId)).run();

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

function updateOperation(
  ctx: StoreContext,
  input: UpdateInvestmentOperationInput,
): { assetId: string; executedAt: string } | null {
  const { db } = ctx;

  if (!Number.isInteger(input.feesMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }

  const row = db
    .select({ assetId: assetOperations.assetId, executedAt: assetOperations.executedAt })
    .from(assetOperations)
    .where(eq(assetOperations.id, input.id))
    .get();

  if (!row) {
    return null;
  }

  db.update(assetOperations)
    .set({
      currency: input.currency,
      feesMinor: input.feesMinor,
      kind: input.kind,
      pricePerUnit: input.pricePerUnit,
      units: input.units,
    })
    .where(eq(assetOperations.id, input.id))
    .run();

  ctx.writeAuditEntry("update_operation", "asset", row.assetId, {
    currency: input.currency,
    executedAt: row.executedAt,
    feesMinor: input.feesMinor,
    kind: input.kind,
    operationId: input.id,
    pricePerUnit: input.pricePerUnit,
    units: input.units,
  });

  return { assetId: row.assetId, executedAt: row.executedAt };
}

function batchApplyValueUpdates(ctx: StoreContext, commands: ValueUpdateCommand[]): void {
  if (commands.length === 0) return;

  const { db, writeAuditEntry } = ctx;
  ctx.transaction(() => {
    for (const cmd of commands) {
      if (!Number.isInteger(cmd.newValueMinor)) {
        throw new Error("Money must be stored as integer minor units.");
      }
      db.update(assets)
        .set({ currentValueMinor: cmd.newValueMinor, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(assets.id, cmd.id))
        .run();
      writeAuditEntry("update_valuation", "asset", cmd.id, {
        currentValueMinor: cmd.newValueMinor,
      });
    }
  });
}

function batchApplyAllValueUpdates(
  ctx: StoreContext,
  assetCommands: ValueUpdateCommand[],
  liabilityCommands: ValueUpdateCommand[],
): void {
  const allCommands = [...assetCommands, ...liabilityCommands];
  if (allCommands.length === 0) return;

  const { db, writeAuditEntry } = ctx;

  // Validate ALL amounts before any write.
  for (const cmd of allCommands) {
    if (!Number.isInteger(cmd.newValueMinor)) {
      throw new Error("Money must be stored as integer minor units.");
    }
  }

  ctx.transaction(() => {
    for (const cmd of assetCommands) {
      db.update(assets)
        .set({ currentValueMinor: cmd.newValueMinor, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(assets.id, cmd.id))
        .run();
      writeAuditEntry("update_valuation", "asset", cmd.id, {
        currentValueMinor: cmd.newValueMinor,
      });
    }
    for (const cmd of liabilityCommands) {
      db.update(liabilities)
        .set({
          currentBalanceMinor: cmd.newValueMinor,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(liabilities.id, cmd.id))
        .run();
      writeAuditEntry("update_balance", "liability", cmd.id, {
        balanceMinor: cmd.newValueMinor,
      });
    }
  });
}

function upsertPrice(ctx: StoreContext, price: AssetPrice): void {
  const db = ctx.db;
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
  const row = ctx.db
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
  const rows = ctx.db.select().from(assetPriceCache).all();

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
