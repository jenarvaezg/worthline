/**
 * Synchronous sync-job executor (PRD #999 S2, #1062).
 *
 * Pure unit tests for the kind-agnostic core: dispatch by `kind`, single-flight
 * by `dedupeKey`, and faithful surfacing of the typed retriable/non-retriable
 * outcome. Handlers are fakes — no DB — so these pin the executor's contract in
 * isolation. `source-sync`'s behavioral equivalence to S1 is covered by the
 * store-level suites (`sync-run.persistence.test.ts`, `connected-source-seams.test.ts`),
 * which route through this executor unchanged.
 */

import { describe, expect, test } from "vitest";
import {
  sourceSyncDescriptor as buildSourceSyncDescriptor,
  createSyncJobExecutor,
  dailyCaptureDescriptor,
  dailyCaptureRunKey,
  type SyncJobDescriptor,
  type SyncJobResult,
  sourceSyncDedupeKey,
} from "./sync-job";

/** A deferred promise so a test can hold a job "in flight" across an await. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const sourceSyncDescriptor = (
  overrides: { dedupeKey?: string; sourceId?: string } = {},
): SyncJobDescriptor => ({
  dedupeKey: overrides.dedupeKey ?? `source-sync:${overrides.sourceId ?? "src1"}`,
  kind: "source-sync",
  payload: {
    positions: [],
    sourceId: overrides.sourceId ?? "src1",
    syncedAt: "2026-07-01T09:00:00.000Z",
    trigger: "manual",
  },
});

describe("createSyncJobExecutor — dispatch + outcomes", () => {
  test("happy path: dispatches to the kind's handler and returns its `ok`", async () => {
    const seen: string[] = [];
    const executor = createSyncJobExecutor({
      "source-sync": {
        run: async (payload) => {
          seen.push(payload.sourceId);
          return { status: "ok" };
        },
      },
    });

    const result = await executor.runSyncJob(sourceSyncDescriptor({ sourceId: "srcA" }));

    expect(result).toEqual({ status: "ok" });
    expect(seen).toEqual(["srcA"]);
  });

  test("surfaces a RETRIABLE typed error verbatim", async () => {
    const error = { code: "outage", message: "provider down", retriable: true };
    const executor = createSyncJobExecutor({
      "source-sync": { run: async () => ({ cause: null, error, status: "error" }) },
    });

    const result = await executor.runSyncJob(sourceSyncDescriptor());

    expect(result).toEqual({ cause: null, error, status: "error" });
  });

  test("surfaces a NON-RETRIABLE typed error verbatim", async () => {
    const error = { code: "bad_config", message: "revoked key", retriable: false };
    const executor = createSyncJobExecutor({
      "source-sync": { run: async () => ({ cause: null, error, status: "error" }) },
    });

    const result = await executor.runSyncJob(sourceSyncDescriptor());

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.retriable).toBe(false);
  });

  test("a handler that THROWS is normalized to a non-retriable typed error (never rethrown)", async () => {
    const boom = new Error("kaboom");
    const executor = createSyncJobExecutor({
      "source-sync": {
        run: async () => {
          throw boom;
        },
      },
    });

    const result = await executor.runSyncJob(sourceSyncDescriptor());

    expect(result).toEqual({
      cause: boom,
      error: { code: "sync_job_handler_threw", message: "kaboom", retriable: false },
      status: "error",
    });
  });

  test("throws for a kind with no registered handler (a programming error)", async () => {
    const executor = createSyncJobExecutor({});
    await expect(executor.runSyncJob(sourceSyncDescriptor())).rejects.toThrow(
      /no sync-job handler/i,
    );
  });
});

describe("createSyncJobExecutor — single-flight by dedupeKey", () => {
  test("a second job with the same key while the first is in flight is skipped", async () => {
    const gate = deferred();
    let runs = 0;
    const executor = createSyncJobExecutor({
      "source-sync": {
        run: async () => {
          runs += 1;
          await gate.promise;
          return { status: "ok" };
        },
      },
    });

    const first = executor.runSyncJob(sourceSyncDescriptor({ dedupeKey: "k" }));
    // The second overlaps the first (same key, first not yet resolved).
    const second = await executor.runSyncJob(sourceSyncDescriptor({ dedupeKey: "k" }));

    expect(second).toEqual({ reason: "in-flight", status: "skipped" });
    expect(runs).toBe(1);

    gate.resolve();
    expect(await first).toEqual({ status: "ok" });
  });

  test("different keys run concurrently — neither blocks the other", async () => {
    const gate = deferred();
    let runs = 0;
    const executor = createSyncJobExecutor({
      "source-sync": {
        run: async () => {
          runs += 1;
          await gate.promise;
          return { status: "ok" };
        },
      },
    });

    const a = executor.runSyncJob(sourceSyncDescriptor({ dedupeKey: "a" }));
    const b = executor.runSyncJob(sourceSyncDescriptor({ dedupeKey: "b" }));

    // Both handlers started before either resolved (no single-flight across keys).
    expect(runs).toBe(2);
    gate.resolve();
    expect(await Promise.all([a, b])).toEqual([{ status: "ok" }, { status: "ok" }]);
  });

  test("the key is released after completion — a later job with the same key runs again", async () => {
    let runs = 0;
    const executor = createSyncJobExecutor({
      "source-sync": {
        run: async () => {
          runs += 1;
          return { status: "ok" };
        },
      },
    });

    await executor.runSyncJob(sourceSyncDescriptor({ dedupeKey: "k" }));
    await executor.runSyncJob(sourceSyncDescriptor({ dedupeKey: "k" }));

    // Sequential (non-overlapping) calls both run — single-flight guards overlap only.
    expect(runs).toBe(2);
  });

  test("the key is released even when the handler throws", async () => {
    let runs = 0;
    const executor = createSyncJobExecutor({
      "source-sync": {
        run: async () => {
          runs += 1;
          throw new Error("fail");
        },
      },
    });

    await executor.runSyncJob(sourceSyncDescriptor({ dedupeKey: "k" }));
    const second = await executor.runSyncJob(sourceSyncDescriptor({ dedupeKey: "k" }));

    expect(runs).toBe(2);
    expect(second.status).toBe("error");
  });
});

describe("createSyncJobExecutor — the contract admits `daily-capture` (S4 wiring aside)", () => {
  test("a daily-capture descriptor routes to a daily-capture handler by shape alone", async () => {
    const seen: string[] = [];
    const executor = createSyncJobExecutor({
      "daily-capture": {
        run: async (payload) => {
          seen.push(payload.runKey);
          return { status: "ok" };
        },
      },
    });

    const descriptor: SyncJobDescriptor = {
      dedupeKey: "2026-07-01:am",
      kind: "daily-capture",
      payload: { now: "2026-07-01T09:00:00.000Z", runKey: "2026-07-01:am" },
    };
    const result: SyncJobResult = await executor.runSyncJob(descriptor);

    expect(result).toEqual({ status: "ok" });
    expect(seen).toEqual(["2026-07-01:am"]);
  });
});

describe("descriptor builders + run-key derivation (S4 #1064)", () => {
  test("sourceSyncDescriptor keys single-flight by source id", () => {
    const descriptor = buildSourceSyncDescriptor({
      positions: [],
      sourceId: "src_1",
      syncedAt: "2026-07-17T09:00:00.000Z",
      trigger: "manual",
    });
    expect(descriptor.kind).toBe("source-sync");
    expect(descriptor.dedupeKey).toBe(sourceSyncDedupeKey("src_1"));
    expect(descriptor.dedupeKey).toBe("source-sync:src_1");
  });

  test("dailyCaptureRunKey splits am/pm at the 15:00 UTC cutoff", () => {
    expect(dailyCaptureRunKey("2026-07-17T09:00:00.000Z")).toBe("2026-07-17:am");
    expect(dailyCaptureRunKey("2026-07-17T14:59:59.000Z")).toBe("2026-07-17:am");
    expect(dailyCaptureRunKey("2026-07-17T15:00:00.000Z")).toBe("2026-07-17:pm");
    expect(dailyCaptureRunKey("2026-07-17T21:00:00.000Z")).toBe("2026-07-17:pm");
  });

  test("dailyCaptureDescriptor pins `now` and makes the run key its dedupe key", () => {
    const now = "2026-07-17T21:07:30.000Z";
    const descriptor = dailyCaptureDescriptor(now);
    expect(descriptor.kind).toBe("daily-capture");
    expect(descriptor.dedupeKey).toBe("2026-07-17:pm");
    expect(descriptor.payload).toEqual({ now, runKey: "2026-07-17:pm" });
  });

  test("the pinned `now` keeps the dedupe key stable across a late drain past the cutoff", () => {
    // Enqueued at 14:59 (am pass); a worker draining at 15:30 must NOT recompute a
    // pm key — the payload carries the enqueue-time key so idempotency composes.
    const descriptor = dailyCaptureDescriptor("2026-07-17T14:59:00.000Z");
    expect(descriptor.dedupeKey).toBe("2026-07-17:am");
    expect(descriptor.payload).toMatchObject({ runKey: "2026-07-17:am" });
    // The would-be drain-time key differs — proving why we pin.
    expect(dailyCaptureRunKey("2026-07-17T15:30:00.000Z")).toBe("2026-07-17:pm");
  });
});
