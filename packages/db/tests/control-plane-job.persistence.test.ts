/**
 * Durable job queue in the control plane (PRD #999 S3, #887, #1063): the two
 * concerns a real (file-backed) database adds on top of the in-memory behavioral
 * suite (`src/job-queue.test.ts`):
 *
 *   1. The MIGRATION ladder creates the `job` table on an existing v2 control plane
 *      and bumps `CP_SCHEMA_VERSION`.
 *   2. DURABILITY: an enqueued job — and its lease/complete transitions — survive a
 *      full store close/reopen. This is what "durable" means; the whole point of S3.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlPlaneStore } from "@db/control-plane";
import {
  CP_SCHEMA_VERSION,
  migrateControlPlane,
  readControlPlaneSchemaVersion,
  writeControlPlaneSchemaVersion,
} from "@db/control-plane-migrate";
import { openLibsqlClient } from "@db/libsql-client";
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, test } from "vitest";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
});

function tempDbUrl(): string {
  const dir = mkdtempSync(join(tmpdir(), "worthline-cp-job-"));
  tempDirs.push(dir);
  return `file:${join(dir, "control-plane.sqlite")}`;
}

async function tableNames(client: Client): Promise<string[]> {
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  return result.rows.map((row) => String(row["name"]));
}

describe("control-plane job migration", () => {
  test("a v2 control plane gains the `job` table and bumps to the current version", async () => {
    const url = tempDbUrl();
    const legacy = openLibsqlClient({ url });
    // Simulate an existing v2 control plane: version set, no `job` table yet.
    await writeControlPlaneSchemaVersion(legacy, 2);
    expect(await tableNames(legacy)).not.toContain("job");

    await migrateControlPlane(legacy);

    expect(await readControlPlaneSchemaVersion(legacy)).toBe(CP_SCHEMA_VERSION);
    expect(CP_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
    expect(await tableNames(legacy)).toContain("job");
    // The single-flight arbiter index is present.
    const indexes = await legacy.execute(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'job'",
    );
    expect(indexes.rows.map((row) => String(row["name"]))).toContain("job_active_dedupe");

    legacy.close();
  });
});

describe("control-plane job durability across reopen", () => {
  test("an enqueued job and its lease/complete transitions survive a close/reopen", async () => {
    const url = tempDbUrl();

    const cp1 = await createControlPlaneStore({ url });
    const { job } = await cp1.enqueueJob({
      kind: "source-sync",
      dedupeKey: "source-sync:s1",
      workspaceId: "ws1",
      payload: { sourceId: "s1", n: 42 },
    });
    cp1.close();

    // Reopen: the durable row is still pending with its payload intact.
    const cp2 = await createControlPlaneStore({ url });
    const reread = await cp2.readJob(job.id);
    expect(reread).toMatchObject({ status: "pending", workspaceId: "ws1" });
    expect(reread!.payload).toEqual({ sourceId: "s1", n: 42 });

    // Lease + complete, then close again.
    const now = new Date().toISOString();
    const leased = await cp2.leaseJob({ owner: "w1", leaseMs: 60_000, now });
    expect(leased!.id).toBe(job.id);
    await cp2.completeJob(leased!.id);
    cp2.close();

    // The terminal state persisted.
    const cp3 = await createControlPlaneStore({ url });
    expect((await cp3.readJob(job.id))!.status).toBe("done");
    cp3.close();
  });
});
