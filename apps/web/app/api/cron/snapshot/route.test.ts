import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The snapshot cron now ENQUEUES a `daily-capture` job (PRD #999 S4, #1064) rather
 * than running the fleet capture inline. This suite pins the route's own
 * responsibility: the `CRON_SECRET` gate and enqueuing exactly one daily-capture
 * job keyed by the pass-qualified run key. The enqueue → worker → capture chain
 * (and its idempotency under redelivery) is covered at the queue level in
 * `packages/db/src/daily-capture-queue.test.ts`.
 */

const { enqueue } = vi.hoisted(() => ({ enqueue: vi.fn() }));

vi.mock("@web/sync-queue", () => ({
  productionSyncQueue: () => ({ enqueue, drain: vi.fn() }),
}));

import { dailyCaptureDescriptor } from "@worthline/db";
import { GET, POST } from "./route";

const URL = "http://localhost:3000/api/cron/snapshot";
const SECRET = "s3cr3t";

function bearer(token: string): Request {
  return new Request(URL, { headers: { Authorization: `Bearer ${token}` } });
}

describe("/api/cron/snapshot", () => {
  const original = process.env.CRON_SECRET;
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    enqueue.mockReset();
    enqueue.mockResolvedValue({
      enqueued: true,
      job: { id: "job_1", dedupeKey: "dk", status: "pending" },
    });
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  test("rejects a request with no Authorization (401) and never enqueues", async () => {
    const res = await GET(new Request(URL));
    expect(res.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("rejects a wrong bearer secret (401)", async () => {
    const res = await GET(bearer("wrong"));
    expect(res.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("fails closed when CRON_SECRET is unset (401 even with a bearer)", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(bearer(SECRET));
    expect(res.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("with the secret, enqueues exactly one daily-capture job keyed by the run key (200)", async () => {
    const before = new Date().toISOString();
    const res = await GET(bearer(SECRET));
    const after = new Date().toISOString();

    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);

    const input = enqueue.mock.calls[0]![0];
    expect(input.workspaceId).toBeNull();
    expect(input.descriptor.kind).toBe("daily-capture");
    // The descriptor is built from the route's own wall clock — its dedupe key is
    // the pass-qualified run key, and its payload pins that same instant.
    expect(input.descriptor.dedupeKey).toBe(dailyCaptureDescriptor(before).dedupeKey);
    expect(input.descriptor.payload.now >= before).toBe(true);
    expect(input.descriptor.payload.now <= after).toBe(true);

    expect(await res.json()).toEqual({
      dedupeKey: "dk",
      enqueued: true,
      jobId: "job_1",
      status: "pending",
    });
  });

  test("POST is also accepted for a manual token-holder trigger", async () => {
    const res = await POST(bearer(SECRET));
    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
