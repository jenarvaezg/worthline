/**
 * App-edge durable sync queue wiring (PRD #999 S4, #1064).
 *
 * Covers the NEW seam this slice adds on top of S3's queue/worker:
 *   - the worker's `runJob` RESOLVER that dispatches a leased job by kind
 *     (source-sync → the workspace's S2 executor; daily-capture → the fleet run),
 *     including its typed handling of infra failures;
 *   - the PULL-mode enqueue → drain-in-process chain that lets local run the whole
 *     cycle (enqueue → lease → execute → ack) with NO Redis, landing an observable
 *     `sync_run`;
 *   - the durable-vs-inline decision that keeps single-user local (no control
 *     plane) on the pre-S4 inline path.
 *
 * Every store is in-memory SQLite. The push (Vercel Queues) transport is config —
 * exercised via the contract parity tests in `packages/db/src/job-queue.test.ts`.
 */

import type { StoreTarget } from "@web/store-resolver";
import {
  type ControlPlaneStore,
  createInMemoryControlPlaneStore,
  createInMemoryStore,
  dailyCaptureDescriptor,
  type RunnableJob,
  sourceSyncDescriptor,
  type WorthlineStore,
} from "@worthline/db";
import { describe, expect, it, vi } from "vitest";
import {
  createSyncJobResolver,
  enqueueSourceSyncOrInline,
  enqueueSyncJob,
  type SyncQueueDeps,
} from "./sync-queue";

/** Wrap a store so a `close()` from the code under test cannot tear down the shared fixture. */
function keepOpen<T extends { close: () => void }>(store: T): T {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "close") return () => {};
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function seededWorkspaceWithSource(): Promise<{
  store: WorthlineStore;
  sourceId: string;
}> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  const { sourceId } = await store.connectedSources.connect({
    adapter: "numista",
    credentialsJson: JSON.stringify({ apiKey: "secret" }),
    label: "Colección Numista",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });
  return { store, sourceId };
}

const AUTHENTICATED: StoreTarget = {
  dbUrl: "libsql://ws1",
  kind: "authenticated",
  token: "grp",
  workspaceId: "ws1",
};

describe("createSyncJobResolver — dispatch by kind", () => {
  it("routes a source-sync job to the workspace store's S2 executor (produces sync_run)", async () => {
    const { store, sourceId } = await seededWorkspaceWithSource();
    const resolver = createSyncJobResolver({
      openWorkspaceStore: async () => keepOpen(store),
      runDailyCaptureFor: async () => {
        throw new Error("not a daily-capture job");
      },
    });

    const syncedAt = "2026-07-17T10:00:00.000Z";
    const job = {
      descriptor: sourceSyncDescriptor({
        positions: [],
        sourceId,
        syncedAt,
        trigger: "manual",
      }),
      job: {} as RunnableJob["job"],
      workspaceId: "ws1",
    };
    const result = await resolver(job);

    expect(result).toEqual({ status: "ok" });
    // Observable: last_sync_at derives from the ok run (S1).
    expect((await store.connectedSources.readSource(sourceId))!.lastSyncAt).toBe(
      syncedAt,
    );

    store.close();
  });

  it("a source-sync job with no workspace is a NON-retriable error (a routing defect)", async () => {
    const resolver = createSyncJobResolver({
      openWorkspaceStore: async () => {
        throw new Error("should not open");
      },
      runDailyCaptureFor: async () => {
        throw new Error("no");
      },
    });
    const result = await resolver({
      descriptor: sourceSyncDescriptor({
        positions: [],
        sourceId: "s1",
        syncedAt: "2026-07-17T10:00:00.000Z",
        trigger: "manual",
      }),
      job: {} as RunnableJob["job"],
      workspaceId: null,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("source_sync_missing_workspace");
      expect(result.error.retriable).toBe(false);
    }
  });

  it("a failure opening the workspace is a RETRIABLE error (a transient outage, not dead)", async () => {
    const resolver = createSyncJobResolver({
      openWorkspaceStore: async () => {
        throw new Error("control plane unreachable");
      },
      runDailyCaptureFor: async () => {
        throw new Error("no");
      },
    });
    const result = await resolver({
      descriptor: sourceSyncDescriptor({
        positions: [],
        sourceId: "s1",
        syncedAt: "2026-07-17T10:00:00.000Z",
        trigger: "manual",
      }),
      job: {} as RunnableJob["job"],
      workspaceId: "ws1",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("source_sync_open_failed");
      expect(result.error.retriable).toBe(true);
    }
  });

  it("routes a daily-capture job through the fleet run and maps its outcome", async () => {
    const runDailyCaptureFor = vi.fn(async (now: string) => ({
      total: 1,
      captured: 1,
      failures: [],
      benchmarkFailures: [],
      sourceSyncFailures: [],
      dateKey: now.slice(0, 10),
    }));
    const resolver = createSyncJobResolver({
      openWorkspaceStore: async () => {
        throw new Error("not a source-sync job");
      },
      runDailyCaptureFor,
    });
    const now = "2026-07-17T21:00:00.000Z";
    const result = await resolver({
      descriptor: dailyCaptureDescriptor(now),
      job: {} as RunnableJob["job"],
      workspaceId: null,
    });
    expect(result).toEqual({ status: "ok" });
    expect(runDailyCaptureFor).toHaveBeenCalledWith(now);
  });
});

describe("enqueueSyncJob — PULL mode drains the full chain in-process (no Redis)", () => {
  it("enqueue → in-process drain → sync_run: the source-sync completes with zero infra", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { store, sourceId } = await seededWorkspaceWithSource();

    const deps: SyncQueueDeps = {
      openControlPlane: async () => keepOpen(cp),
      owner: "test-worker",
      resolver: createSyncJobResolver({
        openWorkspaceStore: async () => keepOpen(store),
        runDailyCaptureFor: async () => {
          throw new Error("not a daily-capture job");
        },
      }),
      // no transport → pull mode
    };

    const syncedAt = "2026-07-17T10:00:00.000Z";
    const result = await enqueueSyncJob(
      {
        descriptor: sourceSyncDescriptor({
          positions: [],
          sourceId,
          syncedAt,
          trigger: "connect",
        }),
        workspaceId: "ws1",
      },
      deps,
    );

    expect(result.enqueued).toBe(true);
    // The job drained in-process: it is terminal `done`, and the sync ran.
    expect((await cp.readJob(result.job.id))!.status).toBe("done");
    expect((await store.connectedSources.readSource(sourceId))!.lastSyncAt).toBe(
      syncedAt,
    );

    store.close();
    cp.close();
  });

  it("does NOT drain in-process when a transport is configured (the consumer will)", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const resolver = vi.fn(async () => ({ status: "ok" }) as const);
    const publish = vi.fn(async () => {});

    const result = await enqueueSyncJob(
      {
        descriptor: sourceSyncDescriptor({
          positions: [],
          sourceId: "s1",
          syncedAt: "2026-07-17T10:00:00.000Z",
          trigger: "manual",
        }),
        workspaceId: "ws1",
      },
      {
        openControlPlane: async () => keepOpen(cp),
        owner: "test-worker",
        resolver,
        transport: { publish },
      },
    );

    expect(publish).toHaveBeenCalledWith({ jobId: result.job.id });
    expect(resolver).not.toHaveBeenCalled(); // push mode: no in-process drain
    expect((await cp.readJob(result.job.id))!.status).toBe("pending");

    cp.close();
  });
});

describe("enqueueSourceSyncOrInline — durable when a control plane exists, else inline", () => {
  const sourceSync = sourceSyncDescriptor({
    positions: [],
    sourceId: "s1",
    syncedAt: "2026-07-17T10:00:00.000Z",
    trigger: "manual",
  });

  it("runs inline for a non-authenticated (local) target — the pre-S4 path", async () => {
    const runInline = vi.fn(async () => {});
    await enqueueSourceSyncOrInline({
      descriptor: sourceSync,
      env: { WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://cp" },
      runInline,
      target: { kind: "local" },
    });
    expect(runInline).toHaveBeenCalledTimes(1);
  });

  it("runs inline for an authenticated target when NO control plane is configured", async () => {
    const runInline = vi.fn(async () => {});
    await enqueueSourceSyncOrInline({
      descriptor: sourceSync,
      env: {}, // no WORTHLINE_CONTROL_PLANE_DB_URL → durable queue unavailable
      runInline,
      target: AUTHENTICATED,
    });
    expect(runInline).toHaveBeenCalledTimes(1);
  });
});
