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
import type { Database as DatabaseConnection } from "better-sqlite3";
import { asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { randomUUID } from "node:crypto";

import {
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

/** The shared drizzle query builder type, bound to the better-sqlite3 driver. */
export type StoreDb = ReturnType<typeof drizzle>;

/**
 * Shared substrate for every extracted *-Store (R1–R5 of the architectural
 * refactor, PRD #120). One StoreContext is built per WorthlineStore lifetime in
 * buildStore and threaded into each focused store factory, so the SQLite
 * connection, the drizzle instance, id generation, transaction wrapping, audit
 * logging, and the per-unit-of-work workspace cache are owned in exactly one
 * place and never duplicated across the slices.
 *
 * STORE RULE (PRD #120 candidate 4, completed in R12): the store layer uses
 * Drizzle for everything — reads and writes alike, through the one shared
 * `db` instance. If a query genuinely cannot be expressed in Drizzle, drop to
 * raw SQL on `sqlite` and document why inline. The only standing exceptions are
 * `resetWorkspace` / `importWorkspace`'s table wipe (a DELETE over a runtime
 * list of table names, which Drizzle's typed builder cannot express) and the
 * schema setup in `migrate` (out of scope — not store reads/writes).
 */
export interface StoreContext {
  /** The raw better-sqlite3 connection — for prepared statements and as the
   *  transaction owner. Shared so every store writes through the same handle. */
  readonly sqlite: DatabaseConnection;
  /** A drizzle query builder bound to the shared connection. Built once per
   *  store lifetime and shared, so every slice writes through one instance. */
  readonly db: StoreDb;
  /** Id generator (randomUUID), injectable so slices never import crypto twice. */
  newId: () => string;
  /** Wrap a unit of work in a SQLite transaction and run it immediately. */
  transaction: <T>(work: () => T) => T;
  /** Append one row to the audit log. Shared concern (ADR audit trail). */
  writeAuditEntry: (
    action: string,
    entityType: string,
    entityId: string,
    details?: Record<string, unknown>,
  ) => void;
  /** The memoized workspace for this unit of work (null before initialization). */
  getWorkspace: () => Workspace | null;
  /** Drop the memoized workspace after a membership write. */
  invalidateWorkspace: () => void;
}

/**
 * Build the shared StoreContext for one store lifetime. `readWorkspace` is
 * injected (rather than imported) to avoid a cycle with index.ts, which owns
 * the workspace reader alongside the monolith.
 */
export function createStoreContext(
  sqlite: DatabaseConnection,
  readWorkspace: (db: StoreDb) => Workspace | null,
): StoreContext {
  // Per-unit-of-work workspace cache: the workspace only changes on membership
  // writes, so memoize it for the store's (short) lifetime and invalidate on
  // those writes. A single page render then reads it once instead of many times.
  let cachedWorkspace: Workspace | null | undefined;

  // One drizzle instance per store lifetime, bound to the shared connection.
  const db = drizzle(sqlite);

  return {
    sqlite,
    db,
    newId: () => randomUUID(),
    transaction: (work) => sqlite.transaction(work)(),
    writeAuditEntry: (action, entityType, entityId, details = {}) => {
      db.insert(auditLog)
        .values({
          action,
          detailsJson: JSON.stringify(details),
          entityId,
          entityType,
          id: randomUUID(),
        })
        .run();
    },
    getWorkspace: () => {
      if (cachedWorkspace === undefined) {
        cachedWorkspace = readWorkspace(db);
      }

      return cachedWorkspace;
    },
    invalidateWorkspace: () => {
      cachedWorkspace = undefined;
    },
  };
}

// ── Shared low-level readers ────────────────────────────────────────────────
// Pure (sqlite) readers shared across slices and the monolith (export,
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

export function readAllOperations(db: StoreDb): Map<string, InvestmentOperation[]> {
  const rows = db
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

export function readInvestmentMeta(db: StoreDb): Map<string, InvestmentMeta> {
  const rows = db
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

export function readAllPriceCache(db: StoreDb): Map<string, { price: string }> {
  const rows = db.select().from(assetPriceCache).all();

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
export function readAssetOwnerships(db: StoreDb): Map<string, OwnershipShare[]> {
  const rows = db
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
export function buildAssetProjectionContext(
  db: StoreDb,
  hasInvestments: boolean,
): AssetProjectionContext {
  const operationsByAsset = hasInvestments
    ? readAllOperations(db)
    : new Map<string, InvestmentOperation[]>();
  const metaByAsset = hasInvestments
    ? readInvestmentMeta(db)
    : new Map<string, InvestmentMeta>();
  const priceCacheByAsset = hasInvestments
    ? readAllPriceCache(db)
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
    ownershipByAsset: readAssetOwnerships(db),
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
export function readAssets(db: StoreDb, workspace: Workspace | null): ManualAsset[] {
  if (!workspace) {
    return [];
  }

  const rows = db
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
  const projectionContext = buildAssetProjectionContext(db, hasInvestments);

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
export function hardDeleteAssetTx(ctx: StoreContext, assetId: string): number {
  const { db } = ctx;
  const row = db
    .select({ name: assets.name, type: assets.type, deletedAt: assets.deletedAt })
    .from(assets)
    .where(eq(assets.id, assetId))
    .get();

  // Hard delete is reachable only from the trash: refuse a live holding.
  if (!row || row.deletedAt === null) {
    return 0;
  }

  const ownership = db
    .select({ memberId: assetOwnerships.memberId, shareBps: assetOwnerships.shareBps })
    .from(assetOwnerships)
    .where(eq(assetOwnerships.assetId, assetId))
    .all();
  const operations =
    row.type === "investment"
      ? db
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
  db.delete(warningOverrides).where(eq(warningOverrides.entityId, assetId)).run();
  const result = db.delete(assets).where(eq(assets.id, assetId)).run();

  ctx.writeAuditEntry("hard_delete_asset", "asset", assetId, {
    name: row.name,
    operations,
    ownership,
    type: row.type,
  });

  return result.changes;
}

/** All liability ownership rows in one query, grouped by liability id. Shared by
 *  the LiabilityStore (R3) and the monolith's export/historical reconstruction. */
export function readLiabilityOwnerships(db: StoreDb): Map<string, OwnershipShare[]> {
  const rows = db
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
export function readLiabilities(db: StoreDb, workspace: Workspace | null): Liability[] {
  if (!workspace) {
    return [];
  }

  const rows = db
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
  const ownershipByLiability = readLiabilityOwnerships(db);

  return rows.map((row) =>
    createLiability(workspace, {
      balanceMinor: row.balanceMinor,
      currency: row.currency,
      id: row.id,
      name: row.name,
      ownership: ownershipByLiability.get(row.id) ?? [],
      type: row.type,
      ...(row.associatedAssetId ? { associatedAssetId: row.associatedAssetId } : {}),
    }),
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
export function hardDeleteLiabilityTx(ctx: StoreContext, liabilityId: string): number {
  const { db } = ctx;
  const row = db
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

  const ownership = db
    .select({
      memberId: liabilityOwnerships.memberId,
      shareBps: liabilityOwnerships.shareBps,
    })
    .from(liabilityOwnerships)
    .where(eq(liabilityOwnerships.liabilityId, liabilityId))
    .all();

  // FK cascade takes the ownerships; clear the warning overrides by hand (no FK
  // points at them); snapshots stay frozen (ADR 0008).
  db.delete(warningOverrides).where(eq(warningOverrides.entityId, liabilityId)).run();
  const result = db.delete(liabilities).where(eq(liabilities.id, liabilityId)).run();

  ctx.writeAuditEntry("hard_delete_liability", "liability", liabilityId, {
    name: row.name,
    ownership,
    type: row.type,
  });

  return result.changes;
}
