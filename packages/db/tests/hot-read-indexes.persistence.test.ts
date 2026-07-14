/**
 * Hot-read index coverage (#201).
 *
 * The performance audit (#200) flagged a set of per-holding / per-entity reads
 * that scanned the full table as a workspace grows. This test pins the FIX at
 * the storage boundary: it proves — via `EXPLAIN QUERY PLAN` — that each hot read
 * now resolves through a covering index instead of a full table scan, and that
 * the migration / runtime schema declare those indexes consistently.
 *
 * The queries below are copied to match exactly what the stores execute:
 *   - operations-store.readOperations: asset_operations WHERE asset_id
 *     ORDER BY executed_at, occurred_at, id
 *   - index.readAuditLog (by entity):   audit_log WHERE entity_id ORDER BY created_at
 *   - index.readTrash (assets):         assets WHERE deleted_at IS NOT NULL ORDER BY name
 *   - index.readTrash (liabilities):    liabilities WHERE deleted_at IS NOT NULL ORDER BY name
 *
 * These are pure read-shape assertions: the FIGURES the stores return are
 * unchanged (covered by the existing persistence/wiring suites) — only the query
 * plan changes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLibsqlClient } from "@db/index";
import { migrate } from "@db/migrate";
import type { Client, InValue } from "@libsql/client";
import { afterEach, describe, expect, test } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/** A freshly migrated, file-backed database — the runtime path the app uses. */
async function freshDatabase(): Promise<Client> {
  const dataDir = mkdtempSync(join(tmpdir(), "worthline-hot-read-"));
  tempDirs.push(dataDir);
  const client = openLibsqlClient(join(dataDir, "worthline.sqlite"));
  await migrate(client);
  return client;
}

/** The single-line query-plan text for a statement, joined for easy matching. */
async function queryPlan(
  client: Client,
  sql: string,
  ...params: InValue[]
): Promise<string> {
  const rows = (await client.execute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args: params }))
    .rows as unknown as {
    detail: string;
  }[];
  return rows.map((r) => r.detail).join("\n");
}

async function indexNames(client: Client, table: string): Promise<string[]> {
  return (
    await client.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?",
      args: [table],
    })
  ).rows.map((row) => (row as unknown as { name: string }).name);
}

describe("hot-read indexes (#201)", () => {
  test("declares the four hot-read indexes on a fresh database", async () => {
    const client = await freshDatabase();
    try {
      expect(await indexNames(client, "asset_operations")).toContain(
        "asset_operations_asset_executed_idx",
      );
      expect(await indexNames(client, "audit_log")).toContain(
        "audit_log_entity_created_idx",
      );
      expect(await indexNames(client, "assets")).toContain("assets_deleted_at_idx");
      expect(await indexNames(client, "liabilities")).toContain(
        "liabilities_deleted_at_idx",
      );
    } finally {
      client.close();
    }
  });

  test("operation reads by investment use an index, not a full scan", async () => {
    const client = await freshDatabase();
    try {
      const plan = await queryPlan(
        client,
        "SELECT * FROM asset_operations WHERE asset_id = ? ORDER BY executed_at, occurred_at, id",
        "asset_x",
      );
      expect(plan).toContain("USING INDEX asset_operations_asset_executed_idx");
      expect(plan).not.toContain("SCAN asset_operations");
    } finally {
      client.close();
    }
  });

  test("audit-log reads by entity use an index, not a full scan", async () => {
    const client = await freshDatabase();
    try {
      const plan = await queryPlan(
        client,
        "SELECT * FROM audit_log WHERE entity_id = ? ORDER BY created_at",
        "asset_x",
      );
      expect(plan).toContain("USING INDEX audit_log_entity_created_idx");
      expect(plan).not.toContain("SCAN audit_log");
    } finally {
      client.close();
    }
  });

  // NOTE on the trash plans: a PARTIAL index reads as "SCAN <table> USING INDEX
  // <name>" — that "SCAN" is a scan of the (tiny) partial index covering only the
  // trashed rows, NOT the full holdings table, and it is pre-sorted by name. The
  // proof the optimization landed is therefore (a) it USES the partial index and
  // (b) there is no "USE TEMP B-TREE FOR ORDER BY" and no bare table scan.
  test("trash reads for assets use the partial index, not a full scan + sort", async () => {
    const client = await freshDatabase();
    try {
      const plan = await queryPlan(
        client,
        "SELECT id, name FROM assets WHERE deleted_at IS NOT NULL ORDER BY name",
      );
      expect(plan).toContain("USING INDEX assets_deleted_at_idx");
      expect(plan).not.toContain("USE TEMP B-TREE");
      // A bare full-table scan would read "SCAN assets" with no index suffix.
      expect(plan).not.toMatch(/SCAN assets(?! USING INDEX)/);
    } finally {
      client.close();
    }
  });

  test("trash reads for liabilities use the partial index, not a full scan + sort", async () => {
    const client = await freshDatabase();
    try {
      const plan = await queryPlan(
        client,
        "SELECT id, name FROM liabilities WHERE deleted_at IS NOT NULL ORDER BY name",
      );
      expect(plan).toContain("USING INDEX liabilities_deleted_at_idx");
      expect(plan).not.toContain("USE TEMP B-TREE");
      expect(plan).not.toMatch(/SCAN liabilities(?! USING INDEX)/);
    } finally {
      client.close();
    }
  });
});
