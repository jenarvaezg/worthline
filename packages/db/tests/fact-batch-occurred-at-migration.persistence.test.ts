import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { describe, expect, test } from "vitest";

const DATED_FACT_TABLES = [
  "asset_operations",
  "asset_valuations",
  "liability_balance_rebaselines",
  "liability_balance_anchors",
] as const;

describe("schema migration v50 (fact provenance and intraday ordering)", () => {
  test("adds fact_batch, nullable batch links, and operation occurred_at", async () => {
    const client = openLibsqlClient(":memory:");
    await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
    await client.execute("INSERT INTO schema_meta (version) VALUES (49)");
    for (const table of DATED_FACT_TABLES) {
      await client.execute(`CREATE TABLE ${table} (id TEXT PRIMARY KEY NOT NULL)`);
    }

    await migrate(client);

    const factBatchColumns = await client.execute("PRAGMA table_info(fact_batch)");
    expect(factBatchColumns.rows.map((row) => row.name)).toEqual([
      "id",
      "trigger",
      "connected_source_id",
      "sync_run_id",
      "created_at",
    ]);
    for (const table of DATED_FACT_TABLES) {
      const columns = await client.execute(`PRAGMA table_info(${table})`);
      expect(columns.rows.map((row) => row.name)).toContain("batch_id");
    }
    const operationColumns = await client.execute("PRAGMA table_info(asset_operations)");
    expect(operationColumns.rows.map((row) => row.name)).toContain("occurred_at");
    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(51);
  });
});
