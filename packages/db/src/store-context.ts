import type {
  DecimalString,
  InvestmentOperation,
  OwnershipShare,
  Workspace,
} from "@worthline/domain";
import type { Database as DatabaseConnection } from "better-sqlite3";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { randomUUID } from "node:crypto";

import {
  assetOperations,
  assetOwnerships,
  assetPriceCache,
  investmentAssets,
} from "./schema";

/**
 * Shared substrate for every extracted *-Store (R1–R5 of the architectural
 * refactor, PRD #120). One StoreContext is built per WorthlineStore lifetime in
 * buildStore and threaded into each focused store factory, so the SQLite
 * connection, the drizzle instance, id generation, transaction wrapping, audit
 * logging, and the per-unit-of-work workspace cache are owned in exactly one
 * place and never duplicated across the slices.
 */
export interface StoreContext {
  /** The raw better-sqlite3 connection — for prepared statements and as the
   *  transaction owner. Shared so every store writes through the same handle. */
  readonly sqlite: DatabaseConnection;
  /** A drizzle query builder bound to the shared connection. */
  db: () => ReturnType<typeof drizzle>;
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
  readWorkspace: (sqlite: DatabaseConnection) => Workspace | null,
): StoreContext {
  // Per-unit-of-work workspace cache: the workspace only changes on membership
  // writes, so memoize it for the store's (short) lifetime and invalidate on
  // those writes. A single page render then reads it once instead of many times.
  let cachedWorkspace: Workspace | null | undefined;

  return {
    sqlite,
    db: () => drizzle(sqlite),
    newId: () => randomUUID(),
    transaction: (work) => sqlite.transaction(work)(),
    writeAuditEntry: (action, entityType, entityId, details = {}) => {
      sqlite
        .prepare(
          `INSERT INTO audit_log (id, action, entity_type, entity_id, details_json)
           VALUES (@id, @action, @entityType, @entityId, @detailsJson)`,
        )
        .run({
          action,
          detailsJson: JSON.stringify(details),
          entityId,
          entityType,
          id: randomUUID(),
        });
    },
    getWorkspace: () => {
      if (cachedWorkspace === undefined) {
        cachedWorkspace = readWorkspace(sqlite);
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

export function readAllOperations(
  sqlite: DatabaseConnection,
): Map<string, InvestmentOperation[]> {
  const rows = drizzle(sqlite)
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

export function readInvestmentMeta(
  sqlite: DatabaseConnection,
): Map<string, InvestmentMeta> {
  const rows = drizzle(sqlite)
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

export function readAllPriceCache(
  sqlite: DatabaseConnection,
): Map<string, { price: string }> {
  const rows = drizzle(sqlite).select().from(assetPriceCache).all();

  return rows.reduce((map, row) => {
    map.set(row.assetId, { price: row.price });
    return map;
  }, new Map<string, { price: string }>());
}

/** Group flat ownership rows into a map keyed by their owning entity id. */
export function groupOwnershipByOwner<
  Row extends { memberId: string; shareBps: number },
>(rows: Row[], ownerIdOf: (row: Row) => string): Map<string, OwnershipShare[]> {
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
export function readAssetOwnerships(
  sqlite: DatabaseConnection,
): Map<string, OwnershipShare[]> {
  const rows = drizzle(sqlite)
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
