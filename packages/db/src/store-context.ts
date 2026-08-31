import { randomUUID } from "node:crypto";
import type { Client, InStatement, Transaction } from "@libsql/client";
import type { Workspace } from "@worthline/domain";

import { chunk } from "./chunk";
import { openDrizzle } from "./libsql-client";

import { auditLog } from "./schema";

/** The shared drizzle query builder type, bound to the libSQL driver. */
export type StoreDb = ReturnType<typeof openDrizzle>;

/** One row of the shared audit trail. */
export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
}

/**
 * Audit rows per batched INSERT. Five columns each, so this stays far below the
 * per-statement parameter cap while keeping a long import to a few round-trips.
 */
const AUDIT_ENTRIES_PER_INSERT = 100;

/**
 * Write statements per `batchWrites` chunk (#1532). Same order of magnitude as
 * the fact-insert groups of 50 — well under Turso's batch payload cap.
 */
const STATEMENTS_PER_BATCH = 50;

/** Queued work that runs just before the outermost transaction commits (#1532). */
export interface BeforeCommitHook {
  discard: () => void;
  flush: () => Promise<void>;
}

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
 * `wipeWorkspaceTables` (a DELETE over a runtime list of table names, which
 * Drizzle's typed builder cannot express — the one wipe `resetWorkspace` and
 * `importWorkspace` share) and the schema setup in `migrate` (out of scope —
 * not store reads/writes).
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
  /**
   * Run `flush` just before the outermost transaction commits (#1532). Nested
   * transactions share that commit. `discard` runs instead on rollback, so a
   * queued write never outlives a failed unit of work.
   */
  registerBeforeCommit: (hook: BeforeCommitHook) => void;
  /**
   * Execute write statements as a group (#1532). Remote (interactive tx):
   * `Transaction.batch` — one HTTP round-trip per chunk, no nested BEGIN.
   * Local (already inside hand-rolled BEGIN): sequential `execute` on the
   * shared connection — `Client.batch` would issue a nested BEGIN, and an
   * interactive tx on `:memory:` cannot see the in-memory database.
   */
  batchWrites: (stmts: readonly InStatement[]) => Promise<void>;
  /** Append one row to the audit log. Shared concern (ADR audit trail). */
  writeAuditEntry: (
    action: string,
    entityType: string,
    entityId: string,
    details?: Record<string, unknown>,
  ) => Promise<void>;
  /**
   * Append MANY rows to the audit log in batched statements (#1435) — the trail
   * still gets one row per fact, but a 42-fact import costs a handful of
   * round-trips instead of 42.
   */
  writeAuditEntries: (entries: readonly AuditEntry[]) => Promise<void>;
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
  //
  // Promise-memoized: the in-flight promise itself is cached, not the awaited
  // value. This prevents a race where two concurrent callers both pass the
  // `=== undefined` guard and fire two round-trips. Note: a rejected read caches
  // the rejection for the store lifetime — acceptable, since a failed workspace
  // read fails the whole render anyway.
  let cachedWorkspace: Promise<Workspace | null> | undefined;

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
  let beforeCommitHooks: BeforeCommitHook[] = [];

  const discardBeforeCommit = (): void => {
    const hooks = beforeCommitHooks;
    beforeCommitHooks = [];
    for (const hook of hooks) hook.discard();
  };

  const runBeforeCommit = async (): Promise<void> => {
    const hooks = beforeCommitHooks;
    beforeCommitHooks = [];
    try {
      for (const hook of hooks) await hook.flush();
    } catch (err) {
      for (const hook of hooks) hook.discard();
      throw err;
    }
  };

  /**
   * Grouped writes (#1532). Inside a remote interactive tx we use
   * `Transaction.batch` (one stream round-trip, no nested BEGIN). Locally we
   * already hold a hand-rolled BEGIN, so we `execute` on the shared connection
   * — `Client.batch` would BEGIN again, and an interactive tx on `:memory:`
   * would not see this database.
   */
  const batchWrites = async (stmts: readonly InStatement[]): Promise<void> => {
    if (stmts.length === 0) return;
    for (const group of chunk(stmts, STATEMENTS_PER_BATCH)) {
      if (isRemote && currentClient !== client) {
        await (currentClient as Transaction).batch(group);
      } else {
        for (const stmt of group) {
          await currentClient.execute(stmt);
        }
      }
    }
  };

  // REMOTE: one interactive tx (a single stream); redirect db/client onto it.
  const runRemoteTransaction = async <T>(work: () => T | Promise<T>): Promise<T> => {
    const tx = await client.transaction("write");
    currentClient = tx;
    currentDb = openDrizzle(tx as unknown as Client);
    try {
      const result = await work();
      await runBeforeCommit();
      await tx.commit();
      return result;
    } catch (err) {
      discardBeforeCommit();
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
      await runBeforeCommit();
      await client.execute("COMMIT");
      return result;
    } catch (err) {
      discardBeforeCommit();
      try {
        await client.execute("ROLLBACK");
      } catch {
        // A failed rollback must not mask the original error.
      }
      throw err;
    }
  };

  /**
   * Every audit write — one row or a whole batch — goes through here, in chunked
   * INSERTs (#1435). Reads `currentDb` at call time, so entries written inside a
   * remote transaction land on the transaction's connection.
   */
  const writeAuditEntries = async (entries: readonly AuditEntry[]): Promise<void> => {
    for (const group of chunk(entries, AUDIT_ENTRIES_PER_INSERT)) {
      await currentDb
        .insert(auditLog)
        .values(
          group.map(({ action, details = {}, entityId, entityType }) => ({
            action,
            detailsJson: JSON.stringify(details),
            entityId,
            entityType,
            id: randomUUID(),
          })),
        )
        .run();
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
    registerBeforeCommit: (hook) => {
      beforeCommitHooks.push(hook);
    },
    batchWrites,
    writeAuditEntry: (action, entityType, entityId, details = {}) =>
      writeAuditEntries([{ action, details, entityId, entityType }]),
    writeAuditEntries,
    getWorkspace: () => {
      if (cachedWorkspace === undefined) {
        cachedWorkspace = readWorkspace(currentDb);
      }

      return cachedWorkspace;
    },
    invalidateWorkspace: () => {
      cachedWorkspace = undefined;
    },
  };
}
