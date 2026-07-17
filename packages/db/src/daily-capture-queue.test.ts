/**
 * Daily capture over the durable queue (PRD #999 S4, #1064).
 *
 * The cron no longer runs `runDailyCapture` inline — it enqueues a `daily-capture`
 * job (dedupeKey = the pass-qualified run key) that a worker drains. This suite
 * pins the CRITICAL invariant the migration must not break: at-least-once delivery
 * + the run-key idempotency guard + latest-wins capture must compose so a
 * redelivered job never captures twice. Everything is in-memory SQLite — no Redis.
 */

import { describe, expect, it, vi } from "vitest";
import { createInMemoryControlPlaneStore } from "./control-plane";
import { createInMemoryStore } from "./index";
import { createJobQueue, createSyncJobWorker, type RunnableJob } from "./job-queue";
import {
  type DailyCaptureFetchedPrice,
  type DailyCaptureWorkspace,
  dailyCaptureJobOutcome,
  type RunDailyCaptureDeps,
  runDailyCapture,
} from "./run-daily-capture";
import type { WorthlineStore } from "./store-types";
import { dailyCaptureDescriptor, type SyncJobResult } from "./sync-job";

const OWNER = "worker-1";
const LEASE_MS = 60_000;
const BASE_EPOCH = Date.parse("2026-07-17T09:00:00.000Z");
function at(offsetMs: number): string {
  return new Date(BASE_EPOCH + offsetMs).toISOString();
}

/** Keep a store open across `runDailyCapture`, which closes every store it opens. */
function keepOpen(store: WorthlineStore): WorthlineStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "close") return () => {};
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function seededWorkspace(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  return store;
}

/**
 * A fleet of ONE workspace with an in-memory run-key finalization guard (the
 * control-plane `daily_capture_runs` stand-in). `listAllWorkspaces` and
 * `fetchPrices` are spies so a redelivery that the run-key guard short-circuits is
 * observable: a skipped pass never re-enters the workspace loop.
 */
function makeFleet(store: WorthlineStore) {
  const finalized = new Set<string>();
  const listAllWorkspaces = vi.fn(
    async (): Promise<DailyCaptureWorkspace[]> => [{ id: "ws1", dbUrl: "mem://ws1" }],
  );
  const fetchPrices = vi.fn(async (): Promise<DailyCaptureFetchedPrice[]> => []);
  const makeDeps = (
    now: string,
    extra?: Partial<RunDailyCaptureDeps>,
  ): RunDailyCaptureDeps => ({
    now,
    listAllWorkspaces,
    openStore: async () => keepOpen(store),
    fetchPrices,
    isRunFinalized: async (runKey) => finalized.has(runKey),
    markRunFinalized: async (runKey) => {
      finalized.add(runKey);
    },
    ...extra,
  });
  return { finalized, listAllWorkspaces, fetchPrices, makeDeps };
}

describe("daily capture over the durable queue (S4 #1064)", () => {
  it("enqueue → worker → capture: the pass runs once and finalizes", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const store = await seededWorkspace();
    const { finalized, listAllWorkspaces, makeDeps } = makeFleet(store);

    const queue = createJobQueue({ store: cp });
    const runJob = async (job: RunnableJob): Promise<SyncJobResult> => {
      if (job.descriptor.kind !== "daily-capture") throw new Error("unexpected kind");
      return dailyCaptureJobOutcome(
        await runDailyCapture(makeDeps(job.descriptor.payload.now)),
      );
    };
    const worker = createSyncJobWorker({
      store: cp,
      owner: OWNER,
      leaseMs: LEASE_MS,
      renewIntervalMs: 0,
      runJob,
    });

    const now = at(0); // 09:00 → am pass
    const { job, enqueued } = await queue.enqueue({
      descriptor: dailyCaptureDescriptor(now),
      workspaceId: null,
    });
    expect(enqueued).toBe(true);
    expect(job.dedupeKey).toBe("2026-07-17:am");

    const outcomes = await worker.runToIdle();
    expect(outcomes).toEqual([{ status: "done", jobId: job.id }]);
    expect(listAllWorkspaces).toHaveBeenCalledTimes(1);
    expect(finalized.has("2026-07-17:am")).toBe(true);

    store.close();
    cp.close();
  });

  it("REDELIVERY is idempotent: a re-enqueued done pass short-circuits — no second capture", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const store = await seededWorkspace();
    const { listAllWorkspaces, fetchPrices, makeDeps } = makeFleet(store);

    const queue = createJobQueue({ store: cp });
    const runJob = async (job: RunnableJob): Promise<SyncJobResult> => {
      if (job.descriptor.kind !== "daily-capture") throw new Error("unexpected kind");
      return dailyCaptureJobOutcome(
        await runDailyCapture(makeDeps(job.descriptor.payload.now)),
      );
    };
    const worker = createSyncJobWorker({
      store: cp,
      owner: OWNER,
      leaseMs: LEASE_MS,
      renewIntervalMs: 0,
      runJob,
    });

    const descriptor = dailyCaptureDescriptor(at(0));
    // First delivery: runs, captures, finalizes.
    await queue.enqueue({ descriptor, workspaceId: null });
    expect(await worker.runToIdle()).toHaveLength(1);
    expect(listAllWorkspaces).toHaveBeenCalledTimes(1);

    // Redelivery: the pass is done (its dedupe index no longer blocks a NEW row),
    // so a fresh enqueue of the SAME run key inserts a new job. Draining it must
    // hit the run-key guard and SKIP — never re-entering the workspace loop.
    const second = await queue.enqueue({ descriptor, workspaceId: null });
    expect(second.enqueued).toBe(true);
    const redeliver = await worker.runToIdle();
    expect(redeliver).toEqual([
      { jobId: second.job.id, reason: "no-op", status: "skipped" },
    ]);
    // The run-key guard short-circuited BEFORE the fleet loop: no second enumeration.
    expect(listAllWorkspaces).toHaveBeenCalledTimes(1);
    expect(fetchPrices).not.toHaveBeenCalled(); // this fleet holds no priced assets

    store.close();
    cp.close();
  });

  it("double-fire within a pass collapses via single-flight (one job, not two)", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const queue = createJobQueue({ store: cp });
    const descriptor = dailyCaptureDescriptor(at(0));

    const first = await queue.enqueue({ descriptor, workspaceId: null });
    const second = await queue.enqueue({ descriptor, workspaceId: null });

    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false); // collapsed onto the in-flight pass
    expect(second.job.id).toBe(first.job.id);
    expect(await cp.listJobs()).toHaveLength(1);

    cp.close();
  });

  it("a partial capture failure is a RETRIABLE job outcome (un-finalized work the queue retries)", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const store = await seededWorkspace();
    const { makeDeps } = makeFleet(store);

    // A workspace whose store cannot open → runDailyCapture records a per-workspace
    // failure and does NOT finalize the pass.
    const deps = makeDeps(at(0), {
      openStore: async () => {
        throw new Error("workspace unreachable");
      },
    });
    const outcome = dailyCaptureJobOutcome(await runDailyCapture(deps));

    expect(outcome.status).toBe("error");
    if (outcome.status === "error") {
      expect(outcome.error.code).toBe("daily_capture_partial_failure");
      expect(outcome.error.retriable).toBe(true);
    }

    store.close();
    cp.close();
  });
});
