/**
 * The lightweight durable queue (PRD #999 S3, #887, #1063). Three layers under test:
 *
 *   1. The durable job PRIMITIVES on the control-plane store (enqueue single-flight,
 *      lease + attempt counting, lease-expiry recovery, typed retry-vs-dead, renew).
 *   2. The QUEUE + WORKER over that contract (drain → runSyncJob → ack/fail), plus
 *      idempotency (a redelivered/done job never re-runs) and the two adapters'
 *      parity (local no-transport vs hosted Vercel-Queues doorbell).
 *   3. The demonstrable CYCLE end-to-end: enqueue a `source-sync` job → a worker
 *      leases it → runs it through the S2 executor (`store.command.runSyncJob`) →
 *      the outcome is observable in the workspace `sync_run` (its derived
 *      `last_sync_at`) and the coin-ripple side effect landed.
 *
 * Local runs with NO Redis or external infra — every store here is in-memory SQLite.
 */

import type { CoinPosition } from "@worthline/domain";
import { describe, expect, it, vi } from "vitest";
import type { ControlPlaneStore, JobError, JobRecord } from "./control-plane";
import { createInMemoryControlPlaneStore } from "./control-plane";
import type { SourcePositionInput, WorthlineStore } from "./index";
import { createInMemoryStore } from "./index";
import {
  createJobQueue,
  createSyncJobWorker,
  createVercelQueueTransport,
  type QueueTransport,
} from "./job-queue";
import type { SyncJobDescriptor, SyncJobResult } from "./sync-job";

const OWNER = "worker-1";
const LEASE_MS = 60_000;

/** A deterministic ISO clock: `at(0)` is the base, `at(n)` is n ms later. */
const BASE_EPOCH = Date.parse("2026-07-17T09:00:00.000Z");
function at(offsetMs: number): string {
  return new Date(BASE_EPOCH + offsetMs).toISOString();
}

const retriableError: JobError = {
  code: "sync_persist_failed",
  message: "transient outage",
  retriable: true,
};
const permanentError: JobError = {
  code: "sync_config_error",
  message: "bad credentials",
  retriable: false,
};

function sourceSyncDescriptor(sourceId: string): SyncJobDescriptor {
  return {
    kind: "source-sync",
    dedupeKey: `source-sync:${sourceId}`,
    payload: {
      sourceId,
      positions: [],
      syncedAt: at(0),
      trigger: "manual",
    },
  };
}

// ── Layer 1: durable job primitives (control plane) ─────────────────────────

describe("control-plane job primitives — enqueue + single-flight dedupe", () => {
  it("inserts a pending job and reads it back", async () => {
    const store = await createInMemoryControlPlaneStore();
    const { job, enqueued } = await store.enqueueJob({
      kind: "source-sync",
      dedupeKey: "source-sync:s1",
      workspaceId: "ws1",
      payload: { sourceId: "s1" },
      runAfter: at(0),
    });

    expect(enqueued).toBe(true);
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(0);
    expect(job.workspaceId).toBe("ws1");
    expect(job.payload).toEqual({ sourceId: "s1" });
    expect(await store.readJob(job.id)).toMatchObject({ id: job.id, status: "pending" });

    store.close();
  });

  it("collapses a second active enqueue of the same dedupe_key (single-flight)", async () => {
    const store = await createInMemoryControlPlaneStore();
    const first = await store.enqueueJob({
      kind: "source-sync",
      dedupeKey: "source-sync:s1",
      payload: { n: 1 },
      runAfter: at(0),
    });
    const second = await store.enqueueJob({
      kind: "source-sync",
      dedupeKey: "source-sync:s1",
      payload: { n: 2 },
      runAfter: at(0),
    });

    expect(second.enqueued).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.payload).toEqual({ n: 1 }); // the ORIGINAL, not the re-enqueue
    expect((await store.listJobs()).length).toBe(1);

    store.close();
  });

  it("allows a fresh enqueue once the predecessor is terminal", async () => {
    const store = await createInMemoryControlPlaneStore();
    const first = await store.enqueueJob({
      kind: "source-sync",
      dedupeKey: "source-sync:s1",
      payload: {},
      runAfter: at(0),
    });
    const leased = await store.leaseJob({ owner: OWNER, leaseMs: LEASE_MS, now: at(0) });
    await store.completeJob(leased!.id);

    const second = await store.enqueueJob({
      kind: "source-sync",
      dedupeKey: "source-sync:s1",
      payload: {},
      runAfter: at(0),
    });
    expect(second.enqueued).toBe(true);
    expect(second.job.id).not.toBe(first.job.id);

    store.close();
  });
});

describe("control-plane job primitives — lease, recovery, renew", () => {
  it("leases the oldest ready job, stamps the lease, and counts the attempt", async () => {
    const store = await createInMemoryControlPlaneStore();
    const a = await store.enqueueJob({
      kind: "source-sync",
      dedupeKey: "a",
      payload: {},
      runAfter: at(0),
    });
    await store.enqueueJob({
      kind: "source-sync",
      dedupeKey: "b",
      payload: {},
      runAfter: at(10),
    });

    const leased = await store.leaseJob({ owner: OWNER, leaseMs: LEASE_MS, now: at(20) });
    expect(leased!.id).toBe(a.job.id); // oldest run_after first
    expect(leased!.status).toBe("leased");
    expect(leased!.attempts).toBe(1);
    expect(leased!.leaseOwner).toBe(OWNER);
    expect(leased!.leaseExpiresAt).toBe(at(20 + LEASE_MS));

    store.close();
  });

  it("returns null when nothing is ready and skips future run_after jobs", async () => {
    const store = await createInMemoryControlPlaneStore();
    await store.enqueueJob({
      kind: "source-sync",
      dedupeKey: "future",
      payload: {},
      runAfter: at(5_000),
    });

    expect(
      await store.leaseJob({ owner: OWNER, leaseMs: LEASE_MS, now: at(0) }),
    ).toBeNull();
    // Eligible once now passes run_after.
    expect(
      await store.leaseJob({ owner: OWNER, leaseMs: LEASE_MS, now: at(5_000) }),
    ).not.toBeNull();

    store.close();
  });

  it("does not re-lease a live lease but recovers an expired one (crash recovery)", async () => {
    const store = await createInMemoryControlPlaneStore();
    await store.enqueueJob({
      kind: "source-sync",
      dedupeKey: "a",
      payload: {},
      runAfter: at(0),
    });

    const first = await store.leaseJob({ owner: "w1", leaseMs: LEASE_MS, now: at(0) });
    // A live lease blocks a second worker.
    expect(
      await store.leaseJob({ owner: "w2", leaseMs: LEASE_MS, now: at(LEASE_MS - 1) }),
    ).toBeNull();
    // Past expiry, another worker reclaims it (attempts bumps again).
    const recovered = await store.leaseJob({
      owner: "w2",
      leaseMs: LEASE_MS,
      now: at(LEASE_MS + 1),
    });
    expect(recovered!.id).toBe(first!.id);
    expect(recovered!.leaseOwner).toBe("w2");
    expect(recovered!.attempts).toBe(2);

    store.close();
  });

  it("renews a held lease only for the current owner", async () => {
    const store = await createInMemoryControlPlaneStore();
    const { job } = await store.enqueueJob({
      kind: "source-sync",
      dedupeKey: "a",
      payload: {},
      runAfter: at(0),
    });
    await store.leaseJob({ owner: "w1", leaseMs: LEASE_MS, now: at(0) });

    expect(
      await store.renewJobLease({
        jobId: job.id,
        owner: "w1",
        leaseMs: LEASE_MS,
        now: at(30_000),
      }),
    ).toBe(true);
    expect((await store.readJob(job.id))!.leaseExpiresAt).toBe(at(30_000 + LEASE_MS));
    expect(
      await store.renewJobLease({
        jobId: job.id,
        owner: "intruder",
        leaseMs: LEASE_MS,
        now: at(40_000),
      }),
    ).toBe(false);

    store.close();
  });
});

describe("control-plane job primitives — complete + typed retries", () => {
  async function leasedJob(store: ControlPlaneStore, maxAttempts?: number) {
    await store.enqueueJob({
      kind: "source-sync",
      dedupeKey: "a",
      payload: {},
      runAfter: at(0),
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
    });
    return (await store.leaseJob({ owner: OWNER, leaseMs: LEASE_MS, now: at(0) }))!;
  }

  it("completeJob marks the job done and it is no longer leasable", async () => {
    const store = await createInMemoryControlPlaneStore();
    const job = await leasedJob(store);
    await store.completeJob(job.id);

    expect((await store.readJob(job.id))!.status).toBe("done");
    expect(
      await store.leaseJob({ owner: OWNER, leaseMs: LEASE_MS, now: at(100) }),
    ).toBeNull();

    store.close();
  });

  it("failJob re-pends a retriable error with backoff and keeps attempts", async () => {
    const store = await createInMemoryControlPlaneStore();
    const job = await leasedJob(store);

    const failed = await store.failJob({
      jobId: job.id,
      error: retriableError,
      now: at(1_000),
      retryDelayMs: 5_000,
    });
    expect(failed.status).toBe("pending");
    expect(failed.attempts).toBe(1); // preserved from the lease
    expect(failed.runAfter).toBe(at(6_000)); // now + backoff
    expect(failed.leaseOwner).toBeNull();
    expect(failed.lastError).toEqual(retriableError);

    store.close();
  });

  it("failJob kills a non-retriable error immediately", async () => {
    const store = await createInMemoryControlPlaneStore();
    const job = await leasedJob(store);

    const failed = await store.failJob({
      jobId: job.id,
      error: permanentError,
      now: at(1_000),
    });
    expect(failed.status).toBe("dead");
    expect(failed.lastError).toEqual(permanentError);

    store.close();
  });

  it("failJob kills a retriable error once attempts are exhausted", async () => {
    const store = await createInMemoryControlPlaneStore();
    // maxAttempts 1: the single lease already used the only attempt.
    const job = await leasedJob(store, 1);
    expect(job.attempts).toBe(1);

    const failed = await store.failJob({
      jobId: job.id,
      error: retriableError,
      now: at(1_000),
    });
    expect(failed.status).toBe("dead"); // retriable, but attempts (1) >= maxAttempts (1)

    store.close();
  });
});

// ── Layer 2: queue + worker ──────────────────────────────────────────────────

/** A runJob stub that records its calls and returns a scripted result. */
function stubRunner(result: SyncJobResult | (() => SyncJobResult)) {
  const calls: SyncJobDescriptor[] = [];
  const runJob = async (job: {
    descriptor: SyncJobDescriptor;
  }): Promise<SyncJobResult> => {
    calls.push(job.descriptor);
    return typeof result === "function" ? result() : result;
  };
  return { calls, runJob };
}

/**
 * Enqueue a pending job at the deterministic `at(0)` (via the injectable `now`
 * seam) so a worker clocked at `at(0)` can lease it.
 */
function enqueuePending(
  store: ControlPlaneStore,
  descriptor: SyncJobDescriptor,
  opts: { maxAttempts?: number } = {},
) {
  return store.enqueueJob({
    kind: descriptor.kind,
    dedupeKey: descriptor.dedupeKey,
    payload: descriptor.payload,
    now: at(0),
    ...(opts.maxAttempts === undefined ? {} : { maxAttempts: opts.maxAttempts }),
  });
}

describe("sync job worker — drain outcomes", () => {
  it("is idle when nothing is enqueued", async () => {
    const store = await createInMemoryControlPlaneStore();
    const worker = createSyncJobWorker({
      store,
      owner: OWNER,
      leaseMs: LEASE_MS,
      ...stubRunner({ status: "ok" }),
      clock: () => at(0),
    });
    expect(await worker.drainOnce()).toEqual({ status: "idle" });
    store.close();
  });

  it("leases, runs, and acks a job (done)", async () => {
    const store = await createInMemoryControlPlaneStore();
    const descriptor = sourceSyncDescriptor("s1");
    const { job } = await enqueuePending(store, descriptor);

    const runner = stubRunner({ status: "ok" });
    const worker = createSyncJobWorker({
      store,
      owner: OWNER,
      leaseMs: LEASE_MS,
      runJob: runner.runJob,
      clock: () => at(0),
    });

    expect(await worker.drainOnce()).toEqual({ status: "done", jobId: job.id });
    expect(runner.calls).toEqual([descriptor]);
    expect((await store.readJob(job.id))!.status).toBe("done");

    store.close();
  });

  it("acks a skipped (no-op) result without retrying", async () => {
    const store = await createInMemoryControlPlaneStore();
    const { job } = await enqueuePending(store, sourceSyncDescriptor("s1"));

    const worker = createSyncJobWorker({
      store,
      owner: OWNER,
      leaseMs: LEASE_MS,
      ...stubRunner({ status: "skipped", reason: "no-op" }),
      clock: () => at(0),
    });

    expect(await worker.drainOnce()).toEqual({
      status: "skipped",
      jobId: job.id,
      reason: "no-op",
    });
    expect((await store.readJob(job.id))!.status).toBe("done");

    store.close();
  });

  it("re-pends a retriable failure (retried) and kills a non-retriable one (dead)", async () => {
    const store = await createInMemoryControlPlaneStore();

    const retryable = await enqueuePending(store, sourceSyncDescriptor("s1"));
    const worker = createSyncJobWorker({
      store,
      owner: OWNER,
      leaseMs: LEASE_MS,
      runJob: async () => ({
        status: "error",
        error: retriableError,
        cause: new Error("x"),
      }),
      backoff: () => 5_000,
      clock: () => at(0),
    });
    expect(await worker.drainOnce()).toMatchObject({ status: "retried", attempts: 1 });
    expect((await store.readJob(retryable.job.id))!.runAfter).toBe(at(5_000));

    const permanent = await enqueuePending(store, sourceSyncDescriptor("s2"));
    const worker2 = createSyncJobWorker({
      store,
      owner: OWNER,
      leaseMs: LEASE_MS,
      runJob: async () => ({
        status: "error",
        error: permanentError,
        cause: new Error("x"),
      }),
      clock: () => at(0),
    });
    expect(await worker2.drainOnce()).toMatchObject({ status: "dead" });
    expect((await store.readJob(permanent.job.id))!.status).toBe("dead");

    store.close();
  });

  it("kills a job whose runJob throws unexpectedly (never wedges as leased)", async () => {
    const store = await createInMemoryControlPlaneStore();
    const { job } = await enqueuePending(store, sourceSyncDescriptor("s1"));

    const worker = createSyncJobWorker({
      store,
      owner: OWNER,
      leaseMs: LEASE_MS,
      runJob: async () => {
        throw new Error("no handler");
      },
      clock: () => at(0),
    });

    const outcome = await worker.drainOnce();
    expect(outcome.status).toBe("dead");
    const dead = await store.readJob(job.id);
    expect(dead!.status).toBe("dead");
    expect(dead!.lastError?.code).toBe("sync_job_run_threw");

    store.close();
  });

  it("respects the attempt limit across retries (retried → dead)", async () => {
    const store = await createInMemoryControlPlaneStore();
    const { job } = await enqueuePending(store, sourceSyncDescriptor("s1"), {
      maxAttempts: 2,
    });

    const worker = createSyncJobWorker({
      store,
      owner: OWNER,
      leaseMs: LEASE_MS,
      runJob: async () => ({
        status: "error",
        error: retriableError,
        cause: new Error("x"),
      }),
      backoff: () => 0, // eligible immediately, so runToIdle drives it to death
      clock: () => at(0),
    });

    const outcomes = await worker.runToIdle();
    expect(outcomes.map((o) => o.status)).toEqual(["retried", "dead"]);
    expect((await store.readJob(job.id))!.status).toBe("dead");

    store.close();
  });
});

describe("sync job worker — lease heartbeat", () => {
  it("renews the lease while a slow runJob is in flight", async () => {
    vi.useFakeTimers();
    try {
      const leased: JobRecord = {
        id: "j1",
        kind: "source-sync",
        dedupeKey: "source-sync:s1",
        workspaceId: "ws1",
        payload: { sourceId: "s1" },
        status: "leased",
        attempts: 1,
        maxAttempts: 5,
        runAfter: at(0),
        leaseOwner: OWNER,
        leaseExpiresAt: at(LEASE_MS),
        lastError: null,
        createdAt: at(0),
        updatedAt: at(0),
      };
      let renewCount = 0;
      let leaseHandedOut = false;
      const fakeStore = {
        leaseJob: async () => (leaseHandedOut ? null : ((leaseHandedOut = true), leased)),
        completeJob: async () => undefined,
        failJob: async () => leased,
        renewJobLease: async () => {
          renewCount += 1;
          return true;
        },
      };

      let resolveRun: (r: SyncJobResult) => void = () => {};
      const worker = createSyncJobWorker({
        store: fakeStore,
        owner: OWNER,
        leaseMs: LEASE_MS,
        renewIntervalMs: 1_000,
        runJob: () => new Promise<SyncJobResult>((resolve) => (resolveRun = resolve)),
      });

      const pending = worker.drainOnce();
      await vi.advanceTimersByTimeAsync(2_500); // fires the 1s heartbeat ~twice
      expect(renewCount).toBeGreaterThanOrEqual(2);

      resolveRun({ status: "ok" });
      expect(await pending).toEqual({ status: "done", jobId: "j1" });

      // The heartbeat stops once the job settles.
      const settledAt = renewCount;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(renewCount).toBe(settledAt);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sync job worker — at-least-once idempotency", () => {
  it("never re-runs a completed job on redelivery", async () => {
    const store = await createInMemoryControlPlaneStore();
    const { job } = await enqueuePending(store, sourceSyncDescriptor("s1"));

    const runner = stubRunner({ status: "ok" });
    const worker = createSyncJobWorker({
      store,
      owner: OWNER,
      leaseMs: LEASE_MS,
      runJob: runner.runJob,
      clock: () => at(0),
    });

    expect(await worker.drainOnce()).toMatchObject({ status: "done" });
    // A redelivered doorbell (or a second worker tick): the done job is terminal,
    // so there is nothing ready — the effect never duplicates.
    expect(await worker.drainOnce()).toEqual({ status: "idle" });
    expect(runner.calls.length).toBe(1);
    expect((await store.listJobs()).filter((j) => j.id === job.id).length).toBe(1);

    store.close();
  });
});

describe("queue adapters — local vs Vercel-Queues parity over one contract", () => {
  it("reaches the same terminal state; only the hosted adapter rings a doorbell", async () => {
    const descriptor = sourceSyncDescriptor("s1");

    // LOCAL: no transport, pull-drained.
    const localStore = await createInMemoryControlPlaneStore();
    const localQueue = createJobQueue({ store: localStore });
    const localOut = await localQueue.enqueue({ descriptor, workspaceId: "ws1" });

    // HOSTED: same contract, a doorbell transport injected.
    const hostedStore = await createInMemoryControlPlaneStore();
    const published: string[] = [];
    const transport: QueueTransport = {
      publish: async ({ jobId }) => {
        published.push(jobId);
      },
    };
    const hostedQueue = createJobQueue({ store: hostedStore, transport });
    const hostedOut = await hostedQueue.enqueue({ descriptor, workspaceId: "ws1" });

    // The persisted rows are identical up to id/timestamps.
    const shape = (j: typeof localOut.job) => ({
      kind: j.kind,
      dedupeKey: j.dedupeKey,
      workspaceId: j.workspaceId,
      payload: j.payload,
      status: j.status,
      attempts: j.attempts,
    });
    expect(shape(hostedOut.job)).toEqual(shape(localOut.job));

    // Only the hosted adapter rang the doorbell.
    expect(published).toEqual([hostedOut.job.id]);

    // The SAME worker drains both to `done` (default real clock ≥ the enqueue's run_after).
    for (const store of [localStore, hostedStore]) {
      const worker = createSyncJobWorker({
        store,
        owner: OWNER,
        leaseMs: LEASE_MS,
        ...stubRunner({ status: "ok" }),
      });
      expect(await worker.drainOnce()).toMatchObject({ status: "done" });
    }

    localStore.close();
    hostedStore.close();
  });

  it("createVercelQueueTransport publishes the job-id to the topic", async () => {
    const producer = { enqueue: vi.fn(async () => undefined) };
    const transport = createVercelQueueTransport(producer, "sync-jobs");
    await transport.publish({ jobId: "job-42" });
    expect(producer.enqueue).toHaveBeenCalledWith("sync-jobs", { jobId: "job-42" });
  });
});

// ── Layer 3: the demonstrable cycle, end-to-end into sync_run ────────────────

const MEMBER_ID = "mJ";

function coin(
  externalId: string,
  purchaseDate: string,
  valueMinor: number,
): SourcePositionInput {
  const position: Omit<CoinPosition, "id" | "sourceId"> = {
    kind: "coin",
    catalogueId: `cat-${externalId}`,
    currency: "EUR",
    externalId,
    finenessMillis: null,
    grade: "unc",
    issueId: null,
    liquidityTier: "illiquid",
    metal: "silver",
    metalValueMinor: null,
    name: `Coin ${externalId}`,
    numismaticFetchedAt: null,
    numismaticValueMinor: valueMinor,
    obverseThumbUrl: null,
    purchaseDate,
    purchasePriceMinor: null,
    quantity: 1,
    weightGrams: null,
    year: null,
  };
  return position;
}

async function seedWorkspaceWithCoinSource(
  store: WorthlineStore,
): Promise<{ sourceId: string; assetId: string }> {
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "fund",
    liquidityTier: "market",
    name: "Fondo indexado",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
  // A backdated buy that GENERATES a snapshot the coin can ripple into.
  await store.command.recordInvestmentOperation(
    {
      assetId: "fund",
      currency: "EUR",
      executedAt: "2024-03-01",
      feesMinor: 0,
      id: "op1",
      kind: "buy",
      pricePerUnit: "100",
      units: "10",
    },
    { today: "2026-06-15" },
  );
  return store.connectedSources.connect({
    adapter: "numista",
    credentialsJson: JSON.stringify({ apiKey: "secret" }),
    label: "Colección Numista",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
}

describe("durable queue → S2 executor → observable sync_run (the demonstrable cycle)", () => {
  it("enqueue → lease → runSyncJob → ack; last_sync_at derives and the ripple lands", async () => {
    const control = await createInMemoryControlPlaneStore();
    const store = await createInMemoryStore();
    const { sourceId } = await seedWorkspaceWithCoinSource(store);

    // The single-workspace resolver S4 will generalize: route every job to this store.
    const queue = createJobQueue({ store: control });
    const worker = createSyncJobWorker({
      store: control,
      owner: OWNER,
      leaseMs: LEASE_MS,
      runJob: ({ descriptor }) => store.command.runSyncJob(descriptor),
    });

    const syncedAt = "2026-06-15T10:00:00.000Z";
    await queue.enqueue({
      workspaceId: "ws1",
      descriptor: {
        kind: "source-sync",
        dedupeKey: `source-sync:${sourceId}`,
        payload: {
          sourceId,
          positions: [coin("c1", "2024-02-01", 300_00)],
          syncedAt,
          trigger: "manual",
        },
      },
    });

    const outcome = await worker.drainOnce();
    expect(outcome.status).toBe("done");

    // Observable in sync_run: last_sync_at is DERIVED from the latest `ok` run (S1).
    const source = await store.connectedSources.readSource(sourceId);
    expect(source!.lastSyncAt).toBe(syncedAt);

    // The sync actually executed: the coin's frozen value rippled into the snapshot.
    const gross = (await store.snapshots.readSnapshots()).find(
      (snap) => snap.dateKey === "2024-03-01",
    )?.grossAssets.amountMinor;
    expect(gross).toBe(10 * 100_00 + 300_00);

    // A redelivery drains to idle — the effect never duplicates.
    expect(await worker.drainOnce()).toEqual({ status: "idle" });

    control.close();
    store.close();
  });

  it("crash-before-ack: lease recovery re-runs without duplicating the effect", async () => {
    const control = await createInMemoryControlPlaneStore();
    const store = await createInMemoryStore();
    const { sourceId } = await seedWorkspaceWithCoinSource(store);

    const descriptor: SyncJobDescriptor = {
      kind: "source-sync",
      dedupeKey: `source-sync:${sourceId}`,
      payload: {
        sourceId,
        positions: [coin("c1", "2024-02-01", 300_00)],
        syncedAt: "2026-06-15T10:00:00.000Z",
        trigger: "manual",
      },
    };
    await control.enqueueJob({
      kind: descriptor.kind,
      dedupeKey: descriptor.dedupeKey,
      workspaceId: "ws1",
      payload: descriptor.payload,
      now: at(0),
    });

    const grossAt = async () =>
      (await store.snapshots.readSnapshots()).find((s) => s.dateKey === "2024-03-01")
        ?.grossAssets.amountMinor;

    // Worker A leases and executes, then "crashes" before acking (lease 1s).
    const a = await control.leaseJob({ owner: "A", leaseMs: 1_000, now: at(0) });
    expect(a!.attempts).toBe(1);
    expect((await store.command.runSyncJob(descriptor)).status).toBe("ok");
    expect(await grossAt()).toBe(10 * 100_00 + 300_00);

    // The lease lapses; worker B recovers the SAME job (attempt 2) and re-executes.
    const b = await control.leaseJob({ owner: "B", leaseMs: 60_000, now: at(2_000) });
    expect(b!.id).toBe(a!.id);
    expect(b!.attempts).toBe(2);
    expect((await store.command.runSyncJob(descriptor)).status).toBe("ok");

    // At-least-once, but idempotent: c1 was already mirrored, so it never re-ripples
    // — the effect does not double.
    expect(await grossAt()).toBe(10 * 100_00 + 300_00);

    // A's late ack is a no-op (it lost the lease to B); B acks cleanly.
    await control.completeJob(a!.id, "A");
    expect((await control.readJob(a!.id))!.status).toBe("leased");
    await control.completeJob(b!.id, "B");
    expect((await control.readJob(b!.id))!.status).toBe("done");

    control.close();
    store.close();
  });
});
