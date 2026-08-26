import type { Client } from "@libsql/client";

/** Tables owned by the durable job port (#887, PRD #999 S3). */
export const JOB_SCHEMA = `
CREATE TABLE IF NOT EXISTS job (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  workspace_id TEXT,
  payload_json TEXT NOT NULL DEFAULT 'null',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- At most one ACTIVE job per dedupe_key: the arbiter for single-flight. Partial so
-- a terminal (done/dead) job never blocks a fresh enqueue of the same key.
CREATE UNIQUE INDEX IF NOT EXISTS job_active_dedupe
  ON job(dedupe_key) WHERE status IN ('pending', 'leased');
-- The lease/claim scan: ready jobs ordered by eligibility.
CREATE INDEX IF NOT EXISTS job_ready ON job(status, run_after);
`;

/** Default delivery cap for a durable job (#887): after this many leases a further
 *  failure is terminal (`dead`). Overridable per-enqueue. */
export const DEFAULT_JOB_MAX_ATTEMPTS = 5;

/**
 * A durable job's lifecycle state (#887, PRD #999 S3). `pending` is eligible to be
 * leased once its `runAfter` passes; `leased` is held by a worker until the lease
 * lapses (then it is reclaimable — crash recovery); `done`/`dead` are terminal
 * (acked success / gave up after a non-retriable error or exhausted attempts).
 */
export type JobStatus = "pending" | "leased" | "done" | "dead";

/**
 * A structured, retriable-classified failure recorded on a job — the SAME
 * `{ code, message, retriable }` shape as S1's `SyncRunError` / S2's `SyncJobError`,
 * kept structural here so the control plane never imports the workspace-side job
 * contract. The queue decides re-enqueue from `retriable` without re-parsing a
 * free-text message.
 */
export interface JobError {
  code: string;
  message: string;
  retriable: boolean;
}

/**
 * One durable job row (#887, PRD #999 S3): the TECHNICAL state of a unit of sync
 * work, in the control plane beside the other coordination tables
 * (`daily_capture_runs`, `connected_source_sync_usage`). Its OBSERVABLE outcome
 * lives in the workspace's `sync_run` (S1) — this row is the queue's bookkeeping,
 * never the user-facing record (1 job ↔ 1 sync_run). `payload` is opaque to the
 * store (stored verbatim as JSON, exactly like a maintainer-alert payload); the
 * queue layer (`job-queue.ts`) owns its shape.
 */
export interface JobRecord {
  id: string;
  kind: string;
  dedupeKey: string;
  /** The workspace this job targets, or null for a fleet-wide job (daily capture). */
  workspaceId: string | null;
  payload: unknown;
  status: JobStatus;
  /** Delivery attempts so far — incremented on each lease, so a crash-loop is bounded. */
  attempts: number;
  /** Delivery cap: once `attempts` reaches it, a further failure is terminal (`dead`). */
  maxAttempts: number;
  /** Earliest time this job may be leased (ISO). Enqueue sets `now`; a retry pushes it out (backoff). */
  runAfter: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastError: JobError | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueJobInput {
  kind: string;
  dedupeKey: string;
  workspaceId?: string | null;
  payload: unknown;
  /** Delivery cap; defaults to {@link DEFAULT_JOB_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Earliest lease time (ISO); defaults to {@link now}. */
  runAfter?: string;
  /** The reference "now" (ISO) — injectable so tests are deterministic, matching
   *  the other job primitives. Defaults to the wall clock. */
  now?: string;
}

export interface EnqueueJobResult {
  job: JobRecord;
  /**
   * True when a NEW row was inserted; false when an ACTIVE (`pending`/`leased`)
   * job of the same `dedupeKey` already existed and this enqueue collapsed onto it
   * (single-flight). A terminal predecessor never blocks a fresh enqueue.
   */
  enqueued: boolean;
}

export interface LeaseJobInput {
  /** The worker's stable lease-owner id. */
  owner: string;
  /** How long the lease is held before it lapses (ms). */
  leaseMs: number;
  /** The reference "now" (ISO) — injectable so tests are deterministic. */
  now: string;
}

export interface RenewJobLeaseInput {
  jobId: string;
  owner: string;
  leaseMs: number;
  now: string;
}

export interface FailJobInput {
  jobId: string;
  error: JobError;
  now: string;
  /** ms until a retriable failure becomes eligible again (backoff). Ignored when terminal. */
  retryDelayMs?: number;
  /**
   * The caller's lease-owner id. When set, the failure is applied ONLY if the job
   * is still leased to this owner — a worker whose lease already lapsed (another
   * worker reclaimed the job) must not stomp the new owner's state. Omit to force.
   */
  owner?: string;
}

/** Durable job queue (#887, PRD #999 S3). */
export interface JobStore {
  /**
   * Durably enqueue a job (#887, PRD #999 S3). Single-flight by `dedupeKey`: if an
   * ACTIVE (`pending`/`leased`) job of the same key already exists, no row is
   * inserted and that job is returned with `enqueued: false`. A terminal
   * (`done`/`dead`) predecessor never blocks a fresh enqueue.
   */
  enqueueJob(input: EnqueueJobInput): Promise<EnqueueJobResult>;
  /**
   * Atomically lease the next ready job for a worker (#887): the oldest job that is
   * `pending`, OR whose `leased` lease has expired (crash recovery), with
   * `runAfter <= now`. Marks it `leased`, stamps the owner + `now + leaseMs` expiry,
   * and increments `attempts` (so a redelivery from a lapsed lease is bounded by
   * `maxAttempts`). Returns null when nothing is ready. Safe under concurrent
   * workers: a guarded UPDATE means only one worker wins a given row.
   */
  leaseJob(input: LeaseJobInput): Promise<JobRecord | null>;
  /** Extend a held lease iff still owned by `owner`; returns false when the lease was lost. */
  renewJobLease(input: RenewJobLeaseInput): Promise<boolean>;
  /**
   * Mark a job `done` (terminal success) and release its lease. Pass `owner` to ack
   * ONLY while still holding the lease — a worker whose lease lapsed (the job was
   * reclaimed) must not ack the new owner's run. Omit to force (unconditional).
   */
  completeJob(jobId: string, owner?: string): Promise<void>;
  /**
   * Record a job failure (#887): if the error is `retriable` and attempts remain
   * (`attempts < maxAttempts`), the job returns to `pending` with
   * `runAfter = now + retryDelayMs` (backoff); otherwise it is `dead`. The typed
   * error is stored as `lastError` either way. Returns the updated job. Throws when
   * the job id is unknown.
   */
  failJob(input: FailJobInput): Promise<JobRecord>;
  /** Read one job by id, or null when unknown. */
  readJob(jobId: string): Promise<JobRecord | null>;
  /** Every job, newest first — observability / tests. */
  listJobs(): Promise<JobRecord[]>;
  /**
   * The greatest `dedupeKey` of this kind strictly below `before`, or null when
   * there is none. Missed-pass detection's baseline (#1339): the daily-capture
   * dedupe key IS the pass-qualified run key, and every invocation enqueues
   * before it does anything else, so this answers "which pass was last INVOKED"
   * — including passes that were invoked and then failed, which finalization
   * cannot distinguish from passes that never arrived. `before` excludes the
   * caller's own row, which it has necessarily already written.
   */
  readLatestJobDedupeKey(input: { kind: string; before: string }): Promise<string | null>;
}

/** True when a job INSERT tripped the active-dedupe index (single-flight, #887). */
function isJobDedupeConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed:\s*job\.dedupe_key|job_active_dedupe/i.test(message);
}

function toJob(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row["id"]),
    kind: String(row["kind"]),
    dedupeKey: String(row["dedupe_key"]),
    workspaceId: row["workspace_id"] == null ? null : String(row["workspace_id"]),
    payload: JSON.parse(String(row["payload_json"] ?? "null")),
    status: String(row["status"]) as JobStatus,
    attempts: Number(row["attempts"]),
    maxAttempts: Number(row["max_attempts"]),
    runAfter: String(row["run_after"]),
    leaseOwner: row["lease_owner"] == null ? null : String(row["lease_owner"]),
    leaseExpiresAt:
      row["lease_expires_at"] == null ? null : String(row["lease_expires_at"]),
    lastError:
      row["last_error_json"] == null
        ? null
        : (JSON.parse(String(row["last_error_json"])) as JobError),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

/** ISO string `ms` milliseconds after the reference `now`. */
function isoPlusMs(now: string, ms: number): string {
  return new Date(new Date(now).getTime() + ms).toISOString();
}

export function createJobStore(client: Client, newId: () => string): JobStore {
  return {
    async enqueueJob({
      kind,
      dedupeKey,
      workspaceId,
      payload,
      maxAttempts,
      runAfter,
      now,
    }) {
      const id = newId();
      const stamp = now ?? new Date().toISOString();
      try {
        await client.execute({
          sql: `INSERT INTO job
                  (id, kind, dedupe_key, workspace_id, payload_json, status,
                   attempts, max_attempts, run_after)
                VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
          args: [
            id,
            kind,
            dedupeKey,
            workspaceId ?? null,
            JSON.stringify(payload ?? null),
            maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS,
            runAfter ?? stamp,
          ],
        });
      } catch (error) {
        // Single-flight: the active-dedupe index rejected the insert because a
        // pending/leased job of this key already exists — collapse onto it.
        if (isJobDedupeConflict(error)) {
          const existing = await client.execute({
            sql: `SELECT * FROM job
                  WHERE dedupe_key = ? AND status IN ('pending', 'leased')
                  LIMIT 1`,
            args: [dedupeKey],
          });
          if (existing.rows.length > 0) {
            return { job: toJob(existing.rows[0]!), enqueued: false };
          }
        }
        throw error;
      }
      const created = await client.execute({
        sql: "SELECT * FROM job WHERE id = ?",
        args: [id],
      });
      return { job: toJob(created.rows[0]!), enqueued: true };
    },
    async leaseJob({ owner, leaseMs, now }) {
      const expiresAt = isoPlusMs(now, leaseMs);
      // Bounded claim loop: pick the oldest ready candidate, then try to claim it
      // with a guarded UPDATE carrying the SAME readiness predicate. If a concurrent
      // worker won the row first, its status is already `leased` with a future
      // expiry, so the predicate no longer matches (0 rows) and we pick the next
      // candidate. Bounded so contention churn can never spin forever.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const candidate = await client.execute({
          sql: `SELECT id FROM job
                WHERE run_after <= ?
                  AND (status = 'pending'
                       OR (status = 'leased' AND lease_expires_at < ?))
                ORDER BY run_after ASC, created_at ASC, rowid ASC
                LIMIT 1`,
          args: [now, now],
        });
        if (candidate.rows.length === 0) return null;
        const id = String(candidate.rows[0]!["id"]);
        const claim = await client.execute({
          sql: `UPDATE job
                SET status = 'leased', lease_owner = ?, lease_expires_at = ?,
                    attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                  AND run_after <= ?
                  AND (status = 'pending'
                       OR (status = 'leased' AND lease_expires_at < ?))`,
          args: [owner, expiresAt, id, now, now],
        });
        if (claim.rowsAffected > 0) {
          const leased = await client.execute({
            sql: "SELECT * FROM job WHERE id = ?",
            args: [id],
          });
          return toJob(leased.rows[0]!);
        }
      }
      return null;
    },
    async renewJobLease({ jobId, owner, leaseMs, now }) {
      const result = await client.execute({
        sql: `UPDATE job SET lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND status = 'leased' AND lease_owner = ?`,
        args: [isoPlusMs(now, leaseMs), jobId, owner],
      });
      return result.rowsAffected > 0;
    },
    async completeJob(jobId, owner) {
      await client.execute({
        sql: `UPDATE job
              SET status = 'done', lease_owner = NULL, lease_expires_at = NULL,
                  last_error_json = NULL, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?${owner === undefined ? "" : " AND lease_owner = ?"}`,
        args: owner === undefined ? [jobId] : [jobId, owner],
      });
    },
    async failJob({ jobId, error, now, retryDelayMs, owner }) {
      const existing = await client.execute({
        sql: "SELECT * FROM job WHERE id = ?",
        args: [jobId],
      });
      if (existing.rows.length === 0) {
        throw new Error(`Job "${jobId}" not found.`);
      }
      const job = toJob(existing.rows[0]!);
      // Lost-lease guard: a worker whose lease already lapsed (another worker owns
      // the job now) must not stomp the new owner's state — its failure is a no-op.
      if (owner !== undefined && job.leaseOwner !== owner) {
        return job;
      }
      const canRetry = error.retriable && job.attempts < job.maxAttempts;
      if (canRetry) {
        await client.execute({
          sql: `UPDATE job
                SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
                    run_after = ?, last_error_json = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?`,
          args: [isoPlusMs(now, retryDelayMs ?? 0), JSON.stringify(error), jobId],
        });
      } else {
        await client.execute({
          sql: `UPDATE job
                SET status = 'dead', lease_owner = NULL, lease_expires_at = NULL,
                    last_error_json = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?`,
          args: [JSON.stringify(error), jobId],
        });
      }
      const updated = await client.execute({
        sql: "SELECT * FROM job WHERE id = ?",
        args: [jobId],
      });
      return toJob(updated.rows[0]!);
    },
    async readJob(jobId) {
      const result = await client.execute({
        sql: "SELECT * FROM job WHERE id = ?",
        args: [jobId],
      });
      return result.rows.length > 0 ? toJob(result.rows[0]!) : null;
    },
    async listJobs() {
      const result = await client.execute(
        "SELECT * FROM job ORDER BY created_at DESC, rowid DESC",
      );
      return result.rows.map((row) => toJob(row));
    },
    async readLatestJobDedupeKey({ kind, before }) {
      // Ordered by the key itself, not by `created_at`: the key names the pass the
      // job is ABOUT, and a late invocation (routinely up to +58 min, #1339) can
      // create a row for an older pass after a newer one.
      const result = await client.execute({
        sql: `SELECT dedupe_key FROM job
              WHERE kind = ? AND dedupe_key < ?
              ORDER BY dedupe_key DESC
              LIMIT 1`,
        args: [kind, before],
      });
      const row = result.rows[0];
      return row ? String(row["dedupe_key"]) : null;
    },
  };
}
