import type { EnqueueJobResult, JobError, JobRecord, JobStore } from "./control-plane";
import type { SyncJobDescriptor, SyncJobResult, SyncJobSkipReason } from "./sync-job";

/**
 * The lightweight durable queue (PRD #999 S3, decision #887). It puts DURABILITY
 * behind the same job contract S2 (#1062) introduced, WITHOUT making Redis — or any
 * external infrastructure — a requirement.
 *
 * The design is "queue as doorbell, DB as source of truth":
 *   - The authoritative state is the `job` table in the CONTROL PLANE (see
 *     control-plane.ts: `enqueueJob`/`leaseJob`/`completeJob`/`failJob`). Leases,
 *     typed retries, and single-flight dedupe all live there — always SQLite, so
 *     LOCAL runs with zero extra infra.
 *   - A {@link QueueTransport} is an optional DOORBELL that merely reduces latency
 *     by telling a worker "there is work now". A lost or duplicated signal only
 *     changes latency, never correctness: a worker always leases the next READY
 *     job, and lease-expiry recovery + the S4 cron sweep drain anything a missed
 *     doorbell left behind.
 *
 * The two adapters the slice calls for are the SAME {@link JobQueue} contract with
 * a different injected transport:
 *   - LOCAL:  `createJobQueue({ store })` — no transport; drain in-process by
 *             polling {@link SyncJobWorker.runToIdle}. Zero infra.
 *   - HOSTED: `createJobQueue({ store, transport: createVercelQueueTransport(...) })`
 *             — the doorbell is a Vercel Queues message whose push consumer calls
 *             {@link SyncJobWorker.drainOnce}.
 * Swapping adapters is swapping the transport; the contract does not change.
 *
 * The worker routes each leased job through `runSyncJob` (S2), whose handler owns
 * the observable `sync_run` lifecycle — so a job's outcome is observable there
 * (1 job ↔ 1 sync_run). Real triggers (cron/connect/manual) migrate onto this in
 * S4 (#1064); here a caller enqueues directly to demonstrate the cycle.
 */

/**
 * The transport that delivers a "there is work" doorbell to a worker (#887). NOT
 * the source of truth — the durable `job` table is — so it is fire-and-forget:
 * publish failures degrade latency, not correctness. Local needs none; hosted
 * publishes to Vercel Queues (see {@link createVercelQueueTransport}).
 */
export interface QueueTransport {
  publish(signal: { jobId: string }): Promise<void>;
}

/** The data a caller enqueues: a ready S2 descriptor plus its durable-queue metadata. */
export interface EnqueueSyncJobInput {
  descriptor: SyncJobDescriptor;
  /** The workspace this job targets, or null for a fleet-wide job (daily capture). */
  workspaceId?: string | null;
  /** Delivery cap; the store defaults it when omitted. */
  maxAttempts?: number;
}

/** The durable-queue producer contract — identical for the local and hosted adapters. */
export interface JobQueue {
  /**
   * Durably enqueue a sync job (single-flight by the descriptor's `dedupeKey`) and,
   * for a FRESH enqueue, ring the doorbell. A re-enqueue that collapsed onto an
   * in-flight job rings nothing — a worker already owns it.
   */
  enqueue(input: EnqueueSyncJobInput): Promise<EnqueueJobResult>;
}

export function createJobQueue(deps: {
  store: Pick<JobStore, "enqueueJob">;
  transport?: QueueTransport;
}): JobQueue {
  return {
    enqueue: async ({ descriptor, workspaceId, maxAttempts }) => {
      const result = await deps.store.enqueueJob({
        kind: descriptor.kind,
        dedupeKey: descriptor.dedupeKey,
        workspaceId: workspaceId ?? null,
        payload: descriptor.payload,
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
      });
      // Only ring for a freshly-inserted job: a re-enqueue that single-flight
      // collapsed onto an active job already has a worker on it.
      if (result.enqueued && deps.transport) {
        await deps.transport.publish({ jobId: result.job.id });
      }
      return result;
    },
  };
}

/** A leased job handed to the worker's {@link SyncJobWorkerDeps.runJob} router. */
export interface RunnableJob {
  /** The target workspace, or null for a fleet-wide job. */
  workspaceId: string | null;
  /** The reconstructed S2 descriptor to run. */
  descriptor: SyncJobDescriptor;
  /** The full durable job row (attempts, dedupeKey, …) for routing/observability. */
  job: JobRecord;
}

/** What one {@link SyncJobWorker.drainOnce} did. */
export type DrainOutcome =
  /** Nothing was ready to lease. */
  | { status: "idle" }
  /** The job ran and was acked (terminal success). */
  | { status: "done"; jobId: string }
  /** The handler had nothing to do (in-flight / no-op); acked, never retried. */
  | { status: "skipped"; jobId: string; reason: SyncJobSkipReason }
  /** A retriable failure with attempts left: returned to `pending` with backoff. */
  | { status: "retried"; jobId: string; error: JobError; attempts: number }
  /** A non-retriable failure or exhausted attempts: terminal `dead`. */
  | { status: "dead"; jobId: string; error: JobError };

export interface SyncJobWorkerDeps {
  /** The durable job primitives (control plane). */
  store: Pick<JobStore, "leaseJob" | "completeJob" | "failJob" | "renewJobLease">;
  /** This worker's stable lease-owner id. */
  owner: string;
  /** How long a lease is held before it lapses (ms). */
  leaseMs: number;
  /**
   * How often to renew the lease while `runJob` is in flight (ms) — the heartbeat
   * that keeps a slow job's lease alive so it is not reclaimed mid-run. Defaults to
   * a third of `leaseMs` (two renewals before a lapse). Pass 0 to disable (a
   * single-shot sub-second handler needs none).
   */
  renewIntervalMs?: number;
  /**
   * Route a leased job through the S2 executor for its target workspace. S4 (#1064)
   * wires the real resolver (open the workspace store by id → `store.command.runSyncJob`);
   * S3 injects it directly. Expected to return a typed {@link SyncJobResult} and NOT
   * throw for a job failure — an uncaught throw is treated as a non-retriable defect.
   */
  runJob: (job: RunnableJob) => Promise<SyncJobResult>;
  /** ms until a retriable failure's next attempt, given the new attempt count. */
  backoff?: (attempts: number) => number;
  /** Injectable clock (ISO now) so tests are deterministic. */
  clock?: () => string;
}

export interface SyncJobWorker {
  /** Lease one ready job, run it, ack/fail it. Returns `{ status: "idle" }` when nothing is ready. */
  drainOnce(): Promise<DrainOutcome>;
  /**
   * Drain until nothing more is ready (the local adapter's pull loop). A retriable
   * failure whose backoff pushes `run_after` into the future is not re-leased in the
   * same pass (so this always terminates); `maxJobs` is a hard backstop.
   */
  runToIdle(maxJobs?: number): Promise<DrainOutcome[]>;
}

/** A lease long enough to outlast a normal sync persist, short enough to recover a crash promptly. */
export const DEFAULT_JOB_LEASE_MS = 60_000;

/** Exponential backoff: 1s, 2s, 4s, … capped at 5 minutes. */
export function defaultJobBackoff(attempts: number): number {
  const baseMs = 1_000;
  const capMs = 5 * 60_000;
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempts - 1));
}

/**
 * Reconstruct the S2 descriptor from a leased durable job. The payload is opaque in
 * the store (verbatim JSON), so the `kind`↔`payload` correlation is re-asserted here
 * at the boundary — the one cast, mirroring the executor's own dispatch cast.
 */
function descriptorOf(job: JobRecord): SyncJobDescriptor {
  return {
    kind: job.kind,
    dedupeKey: job.dedupeKey,
    payload: job.payload,
  } as SyncJobDescriptor;
}

export function createSyncJobWorker(deps: SyncJobWorkerDeps): SyncJobWorker {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const backoff = deps.backoff ?? defaultJobBackoff;
  const renewIntervalMs =
    deps.renewIntervalMs ?? Math.max(1, Math.floor(deps.leaseMs / 3));

  /**
   * Keep a leased job's lease alive while `runJob` runs (the "renews" half of the
   * lease contract) — best-effort: a failed renewal only risks the job being
   * reclaimed, never a crash. Returns a stopper cleared in `finally`.
   */
  const startHeartbeat = (jobId: string): (() => void) => {
    if (renewIntervalMs <= 0) return () => {};
    const timer = setInterval(() => {
      void deps.store
        .renewJobLease({ jobId, owner: deps.owner, leaseMs: deps.leaseMs, now: clock() })
        .catch(() => {});
    }, renewIntervalMs);
    return () => clearInterval(timer);
  };

  const drainOnce = async (): Promise<DrainOutcome> => {
    const job = await deps.store.leaseJob({
      owner: deps.owner,
      leaseMs: deps.leaseMs,
      now: clock(),
    });
    if (!job) return { status: "idle" };

    const stopHeartbeat = startHeartbeat(job.id);
    let result: SyncJobResult;
    try {
      result = await deps.runJob({
        workspaceId: job.workspaceId,
        descriptor: descriptorOf(job),
        job,
      });
    } catch (cause) {
      stopHeartbeat();
      // runJob is expected to CAPTURE its own failures as a typed error result (the
      // S2 executor does). An uncaught throw — e.g. no handler registered for the
      // kind — is a defect: fail non-retriably so the job never wedges as `leased`
      // waiting for a lapse that would only redeliver the same throw.
      const error: JobError = {
        code: "sync_job_run_threw",
        message: cause instanceof Error ? cause.message : String(cause),
        retriable: false,
      };
      const failed = await deps.store.failJob({
        jobId: job.id,
        error,
        now: clock(),
        owner: deps.owner,
      });
      return { status: "dead", jobId: job.id, error: failed.lastError ?? error };
    }
    stopHeartbeat();

    if (result.status === "ok" || result.status === "skipped") {
      // `skipped` (in-flight / no-op) is a benign terminal success: there was
      // nothing to do, so acking is correct — retrying would only loop. Owner-scoped
      // so a worker whose lease lapsed cannot ack the run its successor is doing.
      await deps.store.completeJob(job.id, deps.owner);
      return result.status === "ok"
        ? { status: "done", jobId: job.id }
        : { status: "skipped", jobId: job.id, reason: result.reason };
    }

    // Typed failure: let the store decide retry-vs-dead by `retriable` + attempts.
    const failed = await deps.store.failJob({
      jobId: job.id,
      error: result.error,
      now: clock(),
      retryDelayMs: backoff(job.attempts),
      owner: deps.owner,
    });
    return failed.status === "pending"
      ? {
          status: "retried",
          jobId: job.id,
          error: result.error,
          attempts: failed.attempts,
        }
      : { status: "dead", jobId: job.id, error: result.error };
  };

  const runToIdle = async (maxJobs = 1_000): Promise<DrainOutcome[]> => {
    const outcomes: DrainOutcome[] = [];
    for (let i = 0; i < maxJobs; i += 1) {
      const outcome = await drainOnce();
      if (outcome.status === "idle") break;
      outcomes.push(outcome);
    }
    return outcomes;
  };

  return { drainOnce, runToIdle };
}

/**
 * The minimal Vercel Queues producer surface this adapter needs — a single
 * `enqueue(topic, message)`. Kept as a hand-written port so `packages/db` takes NO
 * hard dependency on `@vercel/queue`; the real binding (a thin wrapper over the SDK
 * producer) is created at the hosted edge (apps/web) and injected in S4. On the
 * consuming side, a Vercel push consumer (`handleCallback`) receives the `{ jobId }`
 * message and calls a {@link SyncJobWorker} — the doorbell, not the source of truth.
 */
export interface VercelQueueProducer {
  enqueue(topic: string, message: { jobId: string }): Promise<unknown>;
}

/** The hosted adapter's transport: publish the job-id doorbell to a Vercel Queues topic. */
export function createVercelQueueTransport(
  producer: VercelQueueProducer,
  topic: string,
): QueueTransport {
  return {
    publish: async ({ jobId }) => {
      await producer.enqueue(topic, { jobId });
    },
  };
}
