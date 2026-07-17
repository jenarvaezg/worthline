import { and, desc, eq, inArray, or, sql } from "drizzle-orm";

import { connectedSources, syncRuns } from "./schema";
import type { StoreContext } from "./store-context";

/**
 * The connected-source sync as an OBSERVABLE entity (#885 / PRD #999 S1). Each
 * sync attempt is one immutable row that walks `pending → running → ok | error`,
 * so the health-of-fetch signal is a first-class record rather than the mutable
 * `connected_sources.last_sync_at` column it used to hide behind. This separates
 * health-of-fetch (did the sync run and work?) from freshness-of-valuation, which
 * still lives — untouched — in `asset_price_cache.freshness_state`.
 *
 * The plano model (#885): 1 source = 1 run, no parent/child trees. The run is
 * opened by whoever triggers the sync (connect / manual / cron) — never the GET,
 * which is cache-only since #785/#895.
 */

/** What triggered the sync attempt. */
export type SyncTrigger = "cron" | "manual" | "connect";

/** The run's lifecycle state. `pending`/`running` are non-terminal (in-flight). */
export type SyncRunStatus = "pending" | "running" | "ok" | "error";

/**
 * A structured failure on an `error` run (#885). `retriable` tells a future queue
 * (S2/S3) whether re-enqueuing could succeed (a transient outage) or is pointless
 * (a permanent config error) without re-parsing a free-text message.
 */
export interface SyncRunError {
  code: string;
  message: string;
  retriable: boolean;
}

/** One persisted sync attempt. */
export interface SyncRun {
  id: string;
  sourceId: string;
  trigger: SyncTrigger;
  status: SyncRunStatus;
  error: SyncRunError | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
}

/**
 * How many runs to retain per source (#885 "últimos-N"). A run is a diagnostic
 * breadcrumb, not a ledger fact — the connector-health panel (#654) only needs a
 * short recent tail, so older runs are pruned on each finalize. Sized so the
 * twice-daily cron plus ad-hoc manual/connect syncs keep several days of history.
 */
export const SYNC_RUN_RETENTION_LIMIT = 20;

export interface SyncRunStore {
  /**
   * Open a run for a source and move it to `running`, enforcing single-flight: if
   * a run is already in flight (`pending`/`running`) for this source, NO new run
   * is opened and `null` is returned so the caller skips the sync (no storm of
   * overlapping runs). Otherwise returns the new run's id. Its own transaction,
   * committed independently of the sync's persist so a later persist failure
   * still leaves an observable run to finalize as `error` (never rolled away).
   */
  beginRun(params: {
    sourceId: string;
    trigger: SyncTrigger;
    at: string;
  }): Promise<{ runId: string } | null>;
  /**
   * Finalize a run as `ok` and derive `connected_sources.last_sync_at` from the
   * latest `ok` run (the run is the truth; the column is a cache). Prunes the
   * source's runs to the retention limit. Its own transaction.
   */
  finishRun(params: { runId: string; sourceId: string; at: string }): Promise<void>;
  /**
   * Finalize a run as `error` with a structured `{ code, message, retriable }`, so
   * a failure never leaves a `running` run dangling. Does NOT touch
   * `last_sync_at` (a failed fetch is not a successful sync). Prunes the source's
   * runs to the retention limit. Its own transaction.
   */
  failRun(params: {
    runId: string;
    sourceId: string;
    error: SyncRunError;
    at: string;
  }): Promise<void>;
  /** Every retained run for a source, newest first. */
  readRuns(sourceId: string): Promise<SyncRun[]>;
  /** The latest `ok` run's finish time for a source, or null if none has succeeded. */
  latestOkAt(sourceId: string): Promise<string | null>;
}

function rowToSyncRun(row: typeof syncRuns.$inferSelect): SyncRun {
  return {
    createdAt: row.createdAt ?? null,
    error: row.errorJson ? (JSON.parse(row.errorJson) as SyncRunError) : null,
    finishedAt: row.finishedAt,
    id: row.id,
    sourceId: row.sourceId,
    startedAt: row.startedAt,
    status: row.status,
    trigger: row.trigger,
  };
}

export function createSyncRunStore(ctx: StoreContext): SyncRunStore {
  const { db } = ctx;

  /** Prune a source's runs down to the newest {@link SYNC_RUN_RETENTION_LIMIT}. */
  const pruneRetention = async (sourceId: string): Promise<void> => {
    const ids = (
      await db
        .select({ id: syncRuns.id })
        .from(syncRuns)
        .where(eq(syncRuns.sourceId, sourceId))
        .orderBy(desc(syncRuns.createdAt), desc(syncRuns.id))
        .all()
    ).map((row) => row.id);

    const stale = ids.slice(SYNC_RUN_RETENTION_LIMIT);
    if (stale.length > 0) {
      await db.delete(syncRuns).where(inArray(syncRuns.id, stale)).run();
    }
  };

  const readRuns = async (sourceId: string): Promise<SyncRun[]> => {
    const rows = await db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.sourceId, sourceId))
      .orderBy(desc(syncRuns.createdAt), desc(syncRuns.id))
      .all();
    return rows.map(rowToSyncRun);
  };

  const latestOkAt = async (sourceId: string): Promise<string | null> => {
    const row = await db
      .select({ finishedAt: syncRuns.finishedAt })
      .from(syncRuns)
      .where(and(eq(syncRuns.sourceId, sourceId), eq(syncRuns.status, "ok")))
      .orderBy(desc(syncRuns.finishedAt))
      .limit(1)
      .get();
    return row?.finishedAt ?? null;
  };

  return {
    beginRun: ({ sourceId, trigger, at }) =>
      ctx.transaction(async () => {
        // Single-flight: an already in-flight run for this source blocks a second,
        // so two concurrent triggers never open overlapping runs (#885). Checked
        // and inserted in one transaction so the guard cannot race itself.
        //
        // LIMITATION (deferred to S3 #887, "leases"): the run wraps only the DB
        // persist — sub-second, no network — so a `running` run reflects an active
        // persist, not a long fetch. If a process is HARD-killed between this
        // commit and finalize (e.g. a serverless timeout mid-ripple), the run
        // stays `running` and blocks future syncs of this source until cleared.
        // S1 does not reap it; the durable queue's leases (#887) own crash
        // recovery. In-seam throws are always finalized (`failRun`), never left
        // dangling — only an uncatchable crash can wedge, and S3 unwedges it.
        const inFlight = await db
          .select({ id: syncRuns.id })
          .from(syncRuns)
          .where(
            and(
              eq(syncRuns.sourceId, sourceId),
              or(eq(syncRuns.status, "pending"), eq(syncRuns.status, "running")),
            ),
          )
          .get();
        if (inFlight) return null;

        const runId = ctx.newId();
        // Insert `pending`, then move to `running`: the modeled opening transition
        // (#885), atomic within this one committed transaction. `createdAt` is set
        // explicitly to the millisecond-precision trigger time rather than the
        // second-granularity CURRENT_TIMESTAMP default: it is the ordering key for
        // retention and the newest-first reads, and single-flight (one open run per
        // source) plus serial finalization make it distinct and monotonic per
        // source — a second-granularity default would tie burst runs and prune
        // arbitrarily.
        await db
          .insert(syncRuns)
          .values({ createdAt: at, id: runId, sourceId, status: "pending", trigger })
          .run();
        await db
          .update(syncRuns)
          .set({ status: "running", startedAt: at })
          .where(eq(syncRuns.id, runId))
          .run();
        return { runId };
      }),

    finishRun: ({ runId, sourceId, at }) =>
      ctx.transaction(async () => {
        await db
          .update(syncRuns)
          .set({ status: "ok", finishedAt: at, errorJson: null })
          .where(eq(syncRuns.id, runId))
          .run();

        // Derive the cached `last_sync_at` from the latest `ok` run (the run is the
        // truth; the column is a cache). `syncPositions` also stamps this column as
        // part of its own standalone contract (it has direct callers), so on the
        // happy path this re-writes the same value — but deriving it HERE is what
        // makes the run authoritative (#885): the column follows the run history,
        // not a value passed straight through. Freshness-of-valuation in
        // `asset_price_cache` is a separate axis and is never touched here.
        const derived = await latestOkAt(sourceId);
        if (derived !== null) {
          await db
            .update(connectedSources)
            .set({ lastSyncAt: derived, updatedAt: sql`CURRENT_TIMESTAMP` })
            .where(eq(connectedSources.id, sourceId))
            .run();
        }

        await pruneRetention(sourceId);
      }),

    failRun: ({ runId, sourceId, error, at }) =>
      ctx.transaction(async () => {
        await db
          .update(syncRuns)
          .set({ status: "error", finishedAt: at, errorJson: JSON.stringify(error) })
          .where(eq(syncRuns.id, runId))
          .run();
        await pruneRetention(sourceId);
      }),

    readRuns,
    latestOkAt,
  };
}
