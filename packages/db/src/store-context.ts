import type {
  AssetProjectionContext,
  DecimalString,
  InvestmentOperation,
  Liability,
  ManualAsset,
  OwnershipShare,
  RawAssetRow,
  Workspace,
} from "@worthline/domain";
import { createLiability, projectAssets } from "@worthline/domain";
import type { Client, Transaction } from "@libsql/client";
import { and, asc, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { openDrizzle } from "./libsql-client";

import {
  agentViewPublicIds,
  assetOperations,
  assetOwnerships,
  assetPriceCache,
  assets,
  auditLog,
  investmentAssets,
  liabilities,
  liabilityOwnerships,
  warningOverrides,
} from "./schema";

/** The shared drizzle query builder type, bound to the libSQL driver. */
export type StoreDb = ReturnType<typeof openDrizzle>;

/**
 * Shared substrate for every extracted *-Store (R1–R5 of the architectural
 * refactor, PRD #120). One StoreContext is built per WorthlineStore lifetime in
 * buildStore and threaded into each focused store factory, so the libSQL
 * connection, the drizzle instance, id generation, transaction wrapping, audit
 * logging, and the per-unit-of-work workspace cache are owned in exactly one
 * place and never duplicated across the slices.
 *
 * STORE RULE (PRD #120 candidate 4, completed in R12): the store layer uses
 * Drizzle for everything — reads and writes alike, through the one shared
 * `db` instance. If a query genuinely cannot be expressed in Drizzle, drop to
 * raw SQL on `client` and document why inline. The only standing exceptions are
 * `resetWorkspace` / `importWorkspace`'s table wipe (a DELETE over a runtime
 * list of table names, which Drizzle's typed builder cannot express) and the
 * schema setup in `migrate` (out of scope — not store reads/writes).
 */
export interface StoreContext {
  /** The raw libSQL client — for raw SQL (table wipes, pragmas) and as the
   *  transaction owner. Shared so every store writes through the same handle. */
  readonly client: Client;
  /** A drizzle query builder bound to the shared client. Built once per store
   *  lifetime and shared, so every slice writes through one instance. */
  readonly db: StoreDb;
  /** Id generator (randomUUID), injectable so slices never import crypto twice. */
  newId: () => string;
  /**
   * Bracket a unit of work in a SQLite transaction and run it, with both the
   * drizzle `db` and raw `client` writes participating. Two drivers, chosen by
   * connection kind (see `createStoreContext`):
   *   - LOCAL (`file:`/`:memory:`) hand-rolls `BEGIN`/`COMMIT`/`ROLLBACK` over
   *     the single shared connection — libSQL's interactive transaction would
   *     open a SEPARATE connection that can't see a `:memory:` database.
   *   - REMOTE (Turso, `libsql://` → http/ws) opens an interactive
   *     `client.transaction()` (one stream) and redirects the store's `db`/
   *     `client` onto it — hand-rolled `BEGIN`/`COMMIT` would land on different
   *     pooled streams and fail with "no transaction is active".
   * Nested calls flatten into the outer transaction (every caller rethrows on
   * failure, so the whole unit rolls back together under one flattened tx).
   */
  transaction: <T>(work: () => T | Promise<T>) => Promise<T>;
  /** Append one row to the audit log. Shared concern (ADR audit trail). */
  writeAuditEntry: (
    action: string,
    entityType: string,
    entityId: string,
    details?: Record<string, unknown>,
  ) => Promise<void>;
  /** The memoized workspace for this unit of work (null before initialization). */
  getWorkspace: () => Promise<Workspace | null>;
  /** Drop the memoized workspace after a membership write. */
  invalidateWorkspace: () => void;
}

/**
 * Build the shared StoreContext for one store lifetime. `readWorkspace` is
 * injected (rather than imported) to avoid a cycle with index.ts, which owns
 * the workspace reader alongside the monolith.
 */
export function createStoreContext(
  client: Client,
  readWorkspace: (db: StoreDb) => Promise<Workspace | null>,
): StoreContext {
  // Per-unit-of-work workspace cache: the workspace only changes on membership
  // writes, so memoize it for the store's (short) lifetime and invalidate on
  // those writes. A single page render then reads it once instead of many times.
  let cachedWorkspace: Workspace | null | undefined;

  // One drizzle instance per store lifetime, bound to the shared client.
  const baseDb = openDrizzle(client);

  // A remote libSQL connection (Turso, `libsql://` → http/ws) cannot be driven
  // by hand-rolled BEGIN/COMMIT: each `execute` may land on a different pooled
  // stream, so COMMIT throws "no transaction is active". For remote we open one
  // interactive `client.transaction()` and redirect both the drizzle `db` and
  // the raw `client` writes onto it for the unit of work. Local `file:`/
  // `:memory:` keeps the hand-rolled path over its single shared connection
  // (an interactive tx would open a SEPARATE connection blind to `:memory:`).
  const isRemote = client.protocol !== "file";

  // The live transaction-scoped targets: the base instances outside a tx (and
  // always on local), the interactive-tx connection during a remote tx. The
  // exposed `db`/`client` are STABLE proxies over these, so the many
  // `const { db } = ctx` call sites — which capture before a tx opens — still
  // route their writes onto the tx connection once one is active.
  let currentDb: StoreDb = baseDb;
  let currentClient: Client | Transaction = client;

  // Forward each accessed method bound to the LIVE target: the native libSQL
  // client rejects a Proxy as its `this`, so methods must run on the real
  // object, not the proxy.
  const bindToTarget = (target: object, prop: string | symbol): unknown => {
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  };
  const db = new Proxy(baseDb, {
    get: (_t, prop) => bindToTarget(currentDb as object, prop),
  });
  const client_ = new Proxy(client, {
    get: (_t, prop) => bindToTarget(currentClient as object, prop),
  });

  // Flatten-nesting depth: only the outermost transaction issues BEGIN/COMMIT.
  let txDepth = 0;

  // REMOTE: one interactive tx (a single stream); redirect db/client onto it.
  const runRemoteTransaction = async <T>(work: () => T | Promise<T>): Promise<T> => {
    const tx = await client.transaction("write");
    currentClient = tx;
    currentDb = openDrizzle(tx as unknown as Client);
    try {
      const result = await work();
      await tx.commit();
      return result;
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // A failed rollback must not mask the original error.
      }
      throw err;
    } finally {
      tx.close();
      currentClient = client;
      currentDb = baseDb;
    }
  };

  // LOCAL: hand-rolled BEGIN/COMMIT over the single shared connection.
  const runLocalTransaction = async <T>(work: () => T | Promise<T>): Promise<T> => {
    await client.execute("BEGIN");
    try {
      const result = await work();
      await client.execute("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.execute("ROLLBACK");
      } catch {
        // A failed rollback must not mask the original error.
      }
      throw err;
    }
  };

  return {
    client: client_,
    db,
    newId: () => randomUUID(),
    transaction: async (work) => {
      if (txDepth > 0) {
        // Already inside a transaction → run inline; the outer owns commit/rollback.
        return work();
      }
      txDepth += 1;
      try {
        return isRemote
          ? await runRemoteTransaction(work)
          : await runLocalTransaction(work);
      } finally {
        txDepth -= 1;
      }
    },
    writeAuditEntry: async (action, entityType, entityId, details = {}) => {
      await currentDb
        .insert(auditLog)
        .values({
          action,
          detailsJson: JSON.stringify(details),
          entityId,
          entityType,
          id: randomUUID(),
        })
        .run();
    },
    getWorkspace: async () => {
      if (cachedWorkspace === undefined) {
        cachedWorkspace = await readWorkspace(currentDb);
      }

      return cachedWorkspace;
    },
    invalidateWorkspace: () => {
      cachedWorkspace = undefined;
    },
  };
}

// ── Shared low-level readers ────────────────────────────────────────────────
// Pure (db) readers shared across slices and the monolith (export,
// historical reconstruction, positions). Kept here — the one shared-concerns
// home — so no slice duplicates them.

export interface InvestmentMeta {
  manualPricePerUnit?: DecimalString;
}

export function toOperation(
  row: typeof assetOperations.$inferSelect,
): InvestmentOperation {
  return {
    assetId: row.assetId,
    currency: row.currency,
    executedAt: row.executedAt,
    feesMinor: row.feesMinor,
    id: row.id,
    kind: row.kind,
    pricePerUnit: row.pricePerUnit,
    units: row.units,
  };
}

export async function readAllOperations(
  db: StoreDb,
): Promise<Map<string, InvestmentOperation[]>> {
  const rows = await db
    .select()
    .from(assetOperations)
    .orderBy(asc(assetOperations.executedAt), asc(assetOperations.id))
    .all();

  return rows.reduce((byAsset, row) => {
    const operation = toOperation(row);
    const existing = byAsset.get(row.assetId);

    if (existing) {
      existing.push(operation);
    } else {
      byAsset.set(row.assetId, [operation]);
    }

    return byAsset;
  }, new Map<string, InvestmentOperation[]>());
}

export async function readInvestmentMeta(
  db: StoreDb,
): Promise<Map<string, InvestmentMeta>> {
  const rows = await db
    .select({
      assetId: investmentAssets.assetId,
      manualPricePerUnit: investmentAssets.manualPricePerUnit,
    })
    .from(investmentAssets)
    .all();

  return rows.reduce((byAsset, row) => {
    byAsset.set(
      row.assetId,
      row.manualPricePerUnit ? { manualPricePerUnit: row.manualPricePerUnit } : {},
    );

    return byAsset;
  }, new Map<string, InvestmentMeta>());
}

export async function readAllPriceCache(
  db: StoreDb,
): Promise<Map<string, { price: string }>> {
  const rows = await db.select().from(assetPriceCache).all();

  return rows.reduce((map, row) => {
    map.set(row.assetId, { price: row.price });
    return map;
  }, new Map<string, { price: string }>());
}

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

/**
 * Build the raw supporting reads (ownership, operations, manual + cached prices)
 * that the domain projection needs to value investments. The store layer stays
 * shallow — it gathers raw rows and the domain owns the composition (PRD #120
 * candidate 3, R10). The investment-only reads are skipped entirely when there
 * are no investments to value.
 *
 * Shared by readAssets (R2) and readPositions (R1), so the raw-read shape never
 * drifts between them.
 */
export async function buildAssetProjectionContext(
  db: StoreDb,
  hasInvestments: boolean,
): Promise<AssetProjectionContext> {
  const operationsByAsset = hasInvestments
    ? await readAllOperations(db)
    : new Map<string, InvestmentOperation[]>();
  const metaByAsset = hasInvestments
    ? await readInvestmentMeta(db)
    : new Map<string, InvestmentMeta>();
  const priceCacheByAsset = hasInvestments
    ? await readAllPriceCache(db)
    : new Map<string, { price: string }>();

  const manualPriceByAsset = new Map<string, DecimalString | undefined>();
  for (const [assetId, meta] of metaByAsset) {
    manualPriceByAsset.set(assetId, meta.manualPricePerUnit);
  }

  const cachedPriceByAsset = new Map<string, DecimalString | undefined>();
  for (const [assetId, cached] of priceCacheByAsset) {
    cachedPriceByAsset.set(assetId, cached.price);
  }

  return {
    cachedPriceByAsset,
    manualPriceByAsset,
    operationsByAsset,
    ownershipByAsset: await readAssetOwnerships(db),
  };
}

/**
 * Read every live (non-trashed) asset as a domain ManualAsset. The store reads
 * raw rows and the raw supporting maps, then hands them to the domain projection
 * (projectAssets), which owns the units × price valuation (ADR 0006) and the
 * ManualAsset reconstitution. Shared by the AssetStore (R2) and the monolith's
 * historical-snapshot reconstruction, so it lives here — the one shared-concerns
 * home — rather than being duplicated across the slices.
 */
export async function readAssets(
  db: StoreDb,
  workspace: Workspace | null,
): Promise<ManualAsset[]> {
  if (!workspace) {
    return [];
  }

  const rows = await db
    .select({
      currency: assets.currency,
      currentValueMinor: assets.currentValueMinor,
      id: assets.id,
      instrument: assets.instrument,
      isPrimaryResidence: assets.isPrimaryResidence,
      liquidityTier: assets.liquidityTier,
      name: assets.name,
      type: assets.type,
    })
    .from(assets)
    .where(isNull(assets.deletedAt))
    .orderBy(asc(assets.createdAt), asc(assets.id))
    .all();

  const rawRows: RawAssetRow[] = rows.map((row) => ({
    currency: row.currency,
    currentValueMinor: row.currentValueMinor,
    id: row.id,
    instrument: row.instrument,
    isPrimaryResidence: row.isPrimaryResidence === 1,
    liquidityTier: row.liquidityTier,
    name: row.name,
    type: row.type,
  }));

  const hasInvestments = rawRows.some((row) => row.type === "investment");
  const projectionContext = await buildAssetProjectionContext(db, hasInvestments);

  return projectAssets(workspace, rawRows, projectionContext);
}

/**
 * Hard-delete one trashed asset in the caller's transaction. Captures the
 * entity's key data for the audit trail BEFORE destroying it; FK cascades take
 * ownerships, investment metadata, operations, and the price cache, and we clear
 * the warning overrides by hand (no FK points at them). Frozen snapshot_holdings
 * are intentionally never touched (ADR 0008): history stays intact, so the
 * holding keeps appearing in past captures. Returns the number of asset rows
 * removed (0 when the id is unknown or not in the trash).
 *
 * Shared here because both the AssetStore (R2, via hardDeleteAsset) and the
 * monolith's emptyTrash run it — so the trash-delete semantics can never drift.
 */
export async function hardDeleteAssetTx(
  ctx: StoreContext,
  assetId: string,
): Promise<number> {
  const { db } = ctx;
  const row = await db
    .select({ name: assets.name, type: assets.type, deletedAt: assets.deletedAt })
    .from(assets)
    .where(eq(assets.id, assetId))
    .get();

  // Hard delete is reachable only from the trash: refuse a live holding.
  if (!row || row.deletedAt === null) {
    return 0;
  }

  const ownership = await db
    .select({ memberId: assetOwnerships.memberId, shareBps: assetOwnerships.shareBps })
    .from(assetOwnerships)
    .where(eq(assetOwnerships.assetId, assetId))
    .all();
  const operations =
    row.type === "investment"
      ? await db
          .select({
            id: assetOperations.id,
            kind: assetOperations.kind,
            executedAt: assetOperations.executedAt,
            units: assetOperations.units,
            pricePerUnit: assetOperations.pricePerUnit,
            currency: assetOperations.currency,
            feesMinor: assetOperations.feesMinor,
          })
          .from(assetOperations)
          .where(eq(assetOperations.assetId, assetId))
          .all()
      : [];

  // No FK points at the warning overrides, so clear them by hand; the asset
  // row's FK cascades take ownerships, investment metadata, operations, and
  // the price cache. Frozen snapshot_holdings are intentionally never touched
  // (ADR 0008).
  await db.delete(warningOverrides).where(eq(warningOverrides.entityId, assetId)).run();
  // Drop the holding's agent-view public id on HARD delete only (#335); a
  // soft-delete/trash keeps it so a restore stays stable.
  await db
    .delete(agentViewPublicIds)
    .where(
      and(
        eq(agentViewPublicIds.entityType, "holding"),
        eq(agentViewPublicIds.entityId, assetId),
      ),
    )
    .run();
  const result = await db.delete(assets).where(eq(assets.id, assetId)).run();

  await ctx.writeAuditEntry("hard_delete_asset", "asset", assetId, {
    name: row.name,
    operations,
    ownership,
    type: row.type,
  });

  return result.rowsAffected;
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
