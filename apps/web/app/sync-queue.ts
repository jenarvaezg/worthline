import { randomUUID } from "node:crypto";
import { buildDailyCaptureDeps } from "@web/api/cron/snapshot/daily-capture-deps";
import { openAuthorizedStore } from "@web/principal";
import type { StoreTarget } from "@web/store-resolver";
import {
  type ControlPlaneStore,
  createControlPlaneStore,
  createJobQueue,
  createSyncJobWorker,
  createVercelQueueTransport,
  DEFAULT_JOB_LEASE_MS,
  type DrainOutcome,
  dailyCaptureJobOutcome,
  type EnqueueJobResult,
  type EnqueueSyncJobInput,
  type QueueTransport,
  type RunnableJob,
  runDailyCapture,
  type SyncJobDescriptor,
  type SyncJobResult,
  syncJobErrorFromCause,
  type VercelQueueProducer,
  type WorthlineStore,
} from "@worthline/db";

/**
 * The app-edge wiring for the durable sync queue (PRD #999 S4, #1064). S3 (#1063)
 * built the transport-agnostic queue + worker in `@worthline/db`; here the real
 * triggers (connect / manual refresh / daily-capture cron) route onto it.
 *
 * Two run modes, chosen by whether a doorbell transport is configured — the queue
 * contract is identical either way (#887, "cola swappable sin tocar el contrato"):
 *
 *   - PULL (default, zero-infra): no transport. Every enqueue drains the durable
 *     `job` table IN-PROCESS via `worker.runToIdle()`, so local — and hosted
 *     without Vercel Queues — runs the whole chain (enqueue → lease → execute → ack)
 *     with NO Redis. The twice-daily snapshot cron's drain doubles as the sweep that
 *     recovers any job a crashed drain left `leased` (its lease lapses, the next
 *     drain re-leases it).
 *   - PUSH (opt-in): a {@link QueueTransport} rings a Vercel Queues doorbell on a
 *     fresh enqueue; the push consumer route (`/api/queue/consume`) drains. The
 *     doorbell is best-effort — correctness lives in the `job` table — so a lost
 *     signal only delays work until the next drain, never corrupts it.
 *
 * The durable queue engages only when a control plane is configured (hosted, and
 * logged-in dev). Pure single-user local (no control plane, so no `job` table)
 * falls back to the pre-S4 inline path — see {@link enqueueSourceSyncOrInline}.
 */

type Env = Record<string, string | undefined>;

/** True when a control plane (thus the durable `job` table) is reachable. */
export function isDurableQueueConfigured(env: Env = process.env): boolean {
  return Boolean(env.WORTHLINE_CONTROL_PLANE_DB_URL);
}

function openControlPlane(env: Env): Promise<ControlPlaneStore> {
  const url = env.WORTHLINE_CONTROL_PLANE_DB_URL;
  if (!url) {
    throw new Error("Durable job queue requires WORTHLINE_CONTROL_PLANE_DB_URL.");
  }
  return createControlPlaneStore({
    url,
    ...(env.WORTHLINE_DB_AUTH_TOKEN ? { authToken: env.WORTHLINE_DB_AUTH_TOKEN } : {}),
  });
}

/**
 * The optional Vercel Queues doorbell. Constructed ONLY when a topic is configured
 * AND a producer binding is injected; otherwise undefined, so the queue runs in
 * PULL mode (drain in-process) — the zero-infra default (Redis never required).
 * The producer is the hand-written port S3 defined so `@worthline/db` takes no
 * `@vercel/queue` dependency; the hosted deployment injects the real binding here.
 */
function resolveTransport(
  env: Env,
  producer?: VercelQueueProducer,
): QueueTransport | undefined {
  const topic = env.WORTHLINE_QUEUE_TOPIC;
  if (!topic || !producer) return undefined;
  return createVercelQueueTransport(producer, topic);
}

/**
 * Open the target workspace store as a `system` actor (like the cron), resolving
 * its per-workspace database URL from the control plane by id. This is how a
 * leased `source-sync` job reaches the workspace whose `sync_run` it must update.
 */
async function openWorkspaceStoreById(
  env: Env,
  workspaceId: string,
): Promise<WorthlineStore> {
  const controlPlane = await openControlPlane(env);
  let dbUrl: string | null = null;
  try {
    const workspace = await controlPlane.getWorkspaceWithOwner(workspaceId);
    dbUrl = workspace?.dbUrl ?? null;
  } finally {
    controlPlane.close();
  }
  if (!dbUrl) {
    throw new Error(`Durable sync job targets unknown workspace ${workspaceId}.`);
  }
  return openAuthorizedStore({
    kind: "system",
    options: {
      url: dbUrl,
      ...(env.WORTHLINE_DB_AUTH_TOKEN ? { authToken: env.WORTHLINE_DB_AUTH_TOKEN } : {}),
    },
  });
}

/** Seams the worker's `runJob` router needs, injectable so it is unit-testable. */
export interface SyncJobResolverDeps {
  /** Open the workspace store for a leased `source-sync` job. */
  openWorkspaceStore: (workspaceId: string) => Promise<WorthlineStore>;
  /** Run the fleet daily capture pinned to the job's enqueue-time `now`. */
  runDailyCaptureFor: (
    now: string,
  ) => Promise<Awaited<ReturnType<typeof runDailyCapture>>>;
}

/**
 * Route one leased job to its executor, dispatching by kind. NEVER throws for a
 * job failure — it returns a typed {@link SyncJobResult} so the worker/store decide
 * ack-vs-retry from `retriable` (an uncaught throw would be treated as a
 * non-retriable defect). Infra failures (opening the workspace/control plane) are
 * caught as RETRIABLE so a transient outage retries instead of dying.
 */
export function createSyncJobResolver(
  deps: SyncJobResolverDeps,
): (job: RunnableJob) => Promise<SyncJobResult> {
  return async (job) => {
    if (job.descriptor.kind === "daily-capture") {
      return dailyCaptureJobOutcome(
        await deps.runDailyCaptureFor(job.descriptor.payload.now),
      );
    }

    // source-sync: run it through the workspace's S2 executor (owns the sync_run).
    if (job.workspaceId === null) {
      return {
        cause: null,
        error: {
          code: "source_sync_missing_workspace",
          message: "source-sync job carries no workspace id",
          retriable: false,
        },
        status: "error",
      };
    }
    try {
      const store = await deps.openWorkspaceStore(job.workspaceId);
      try {
        return await store.command.runSyncJob(job.descriptor);
      } finally {
        store.close();
      }
    } catch (cause) {
      return {
        cause,
        error: syncJobErrorFromCause(cause, {
          code: "source_sync_open_failed",
          retriable: true,
        }),
        status: "error",
      };
    }
  };
}

/** Drain every ready job to idle on a fresh worker — the pull-mode + sweep recipe. */
function drainToIdle(
  controlPlane: ControlPlaneStore,
  resolver: (job: RunnableJob) => Promise<SyncJobResult>,
  owner: string,
  leaseMs: number,
): Promise<DrainOutcome[]> {
  return createSyncJobWorker({
    leaseMs,
    owner,
    renewIntervalMs: 0,
    runJob: resolver,
    store: controlPlane,
  }).runToIdle();
}

/** The seams {@link enqueueSyncJob} needs — injectable for tests, env-wired in prod. */
export interface SyncQueueDeps {
  openControlPlane: () => Promise<ControlPlaneStore>;
  resolver: (job: RunnableJob) => Promise<SyncJobResult>;
  transport?: QueueTransport;
  owner: string;
  leaseMs?: number;
}

/**
 * Durably enqueue a sync job and, in PULL mode (no transport), drain the queue
 * in-process so the whole chain completes without external infra. In PUSH mode the
 * doorbell was rung by the queue; the consumer drains, so this returns immediately.
 */
export async function enqueueSyncJob(
  input: EnqueueSyncJobInput,
  deps: SyncQueueDeps,
): Promise<EnqueueJobResult> {
  const controlPlane = await deps.openControlPlane();
  try {
    const queue = createJobQueue({
      store: controlPlane,
      ...(deps.transport ? { transport: deps.transport } : {}),
    });
    const result = await queue.enqueue(input);

    if (!deps.transport) {
      await drainToIdle(
        controlPlane,
        deps.resolver,
        deps.owner,
        deps.leaseMs ?? DEFAULT_JOB_LEASE_MS,
      );
    }
    return result;
  } finally {
    controlPlane.close();
  }
}

/** A production sync-queue bound to the environment. */
export interface ProductionSyncQueue {
  /** Enqueue (+ drain in PULL mode) any sync job. */
  enqueue: (input: EnqueueSyncJobInput) => Promise<EnqueueJobResult>;
  /** Drain every ready job to idle — the push consumer + cron sweep entry point. */
  drain: () => Promise<DrainOutcome[]>;
}

/** Assemble the env-wired production queue: real control plane, resolver, transport. */
export function productionSyncQueue(env: Env = process.env): ProductionSyncQueue {
  const resolver = createSyncJobResolver({
    openWorkspaceStore: (workspaceId) => openWorkspaceStoreById(env, workspaceId),
    runDailyCaptureFor: (now) => runDailyCapture(buildDailyCaptureDeps(env, { now })),
  });
  const transport = resolveTransport(env);
  // A per-invocation lease owner: leases keep two concurrent drains (or a doorbell
  // consumer racing a pull drain) from both running the same job.
  const owner = `web-${randomUUID()}`;
  const deps: SyncQueueDeps = {
    openControlPlane: () => openControlPlane(env),
    owner,
    resolver,
    ...(transport ? { transport } : {}),
  };
  return {
    enqueue: (input) => enqueueSyncJob(input, deps),
    drain: async () => {
      const controlPlane = await openControlPlane(env);
      try {
        return await drainToIdle(controlPlane, resolver, owner, DEFAULT_JOB_LEASE_MS);
      } finally {
        controlPlane.close();
      }
    },
  };
}

/**
 * Enqueue a `source-sync` job for a connect/manual trigger, OR run it inline when
 * the durable queue is unavailable (S4 #1064). The durable path engages for an
 * authenticated request with a control plane configured — the job routes through a
 * worker that opens the workspace and updates its `sync_run`. Pure single-user
 * local (no control plane) and any non-authenticated target fall back to the exact
 * pre-S4 inline persist, so dev with zero infra is unchanged.
 *
 * The manual-refresh throttle is enforced by the caller BEFORE this runs, so
 * enqueuing never bypasses it.
 */
export async function enqueueSourceSyncOrInline(params: {
  descriptor: SyncJobDescriptor;
  target: StoreTarget;
  /** The pre-S4 inline persist over the request's own store (the fallback path). */
  runInline: () => Promise<void>;
  env?: Env;
}): Promise<void> {
  const env = params.env ?? process.env;
  if (params.target.kind === "authenticated" && isDurableQueueConfigured(env)) {
    await productionSyncQueue(env).enqueue({
      descriptor: params.descriptor,
      workspaceId: params.target.workspaceId,
    });
    return;
  }
  await params.runInline();
}
