import type {
  AssetPrice,
  CreateInvestmentOperationInput,
  CurrencyCode,
  DecimalString,
  InvestmentOperation,
  OperationKind,
  OperationSource,
} from "@worthline/domain";
import { asDateKey, createInvestmentOperation } from "@worthline/domain";
import { asc, eq, sql } from "drizzle-orm";

import {
  assetOperations,
  assetPriceCache,
  assets,
  contributionOccurrenceOperations,
  contributionOccurrenceReconciliations,
  liabilities,
} from "./schema";
import { type StoreContext, toOperation } from "./store-context";

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
  source?: OperationSource;
}

export interface OperationsStore {
  recordOperation: (input: CreateInvestmentOperationInput) => Promise<void>;
  readOperations: (assetId: string) => Promise<InvestmentOperation[]>;
  /** Delete an operation. Returns the deleted operation's asset id and date, or null if not found. */
  deleteOperation: (
    operationId: string,
  ) => Promise<{ assetId: string; executedAt: string } | null>;
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
    recordOperation: (input) => recordOperation(ctx, input),
    readOperations: (assetId) => readOperations(ctx, assetId),
    deleteOperation: (operationId) => deleteOperation(ctx, operationId),
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

async function recordOperation(
  ctx: StoreContext,
  input: CreateInvestmentOperationInput,
): Promise<void> {
  const operation = createInvestmentOperation(input);

  // fees_minor has a DB default of 0; the domain constructor always supplies it,
  // matching the raw INSERT which also always passed @feesMinor.
  await ctx.db
    .insert(assetOperations)
    .values({
      assetId: operation.assetId,
      currency: operation.currency,
      executedAt: asDateKey(operation.executedAt.slice(0, 10)),
      feesMinor: operation.feesMinor,
      id: operation.id,
      kind: operation.kind,
      pricePerUnit: operation.pricePerUnit,
      source: operation.source ?? "manual",
      units: operation.units,
    })
    .run();
}

async function readOperations(
  ctx: StoreContext,
  assetId: string,
): Promise<InvestmentOperation[]> {
  const rows = await ctx.db
    .select()
    .from(assetOperations)
    .where(eq(assetOperations.assetId, assetId))
    .orderBy(asc(assetOperations.executedAt), asc(assetOperations.id))
    .all();
  return rows.map(toOperation);
}

async function deleteOperation(
  ctx: StoreContext,
  operationId: string,
): Promise<{ assetId: string; executedAt: string } | null> {
  const { db } = ctx;
  const row = await db
    .select({
      assetId: assetOperations.assetId,
      kind: assetOperations.kind,
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
    .select({ assetId: assetOperations.assetId, executedAt: assetOperations.executedAt })
    .from(assetOperations)
    .where(eq(assetOperations.id, input.id))
    .get();

  if (!row) {
    return null;
  }

  await db
    .update(assetOperations)
    .set({
      currency: input.currency,
      feesMinor: input.feesMinor,
      kind: input.kind,
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
