import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

/**
 * v59 (#1393): `asset_operations` learns the traspaso — `transfer_id` on both halves
 * of the pair, `transfer_cost_minor` on the incoming one. Existing rows keep both
 * NULL and nothing is backfilled: a pre-#1393 row is a buy or a sell, and it
 * genuinely knows nothing of a pair.
 */

function columnNames(rows: Array<Record<string, unknown>>): string[] {
  return rows.map((row) => String(row["name"]));
}

async function seedV58(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (58)");
  await client.executeMultiple(`
    CREATE TABLE assets (
      id TEXT PRIMARY KEY NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE TABLE asset_operations (
      id TEXT PRIMARY KEY NOT NULL,
      asset_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      executed_at TEXT NOT NULL,
      units TEXT NOT NULL,
      price_per_unit TEXT NOT NULL,
      currency TEXT NOT NULL,
      fees_minor INTEGER DEFAULT 0 NOT NULL,
      source TEXT DEFAULT 'manual' NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    INSERT INTO assets (id) VALUES ('fondo');
    INSERT INTO asset_operations (id, asset_id, kind, executed_at, units, price_per_unit, currency) VALUES
      ('old_op', 'fondo', 'buy', '2026-01-23', '10', '100.00', 'EUR');
  `);
  return client;
}

describe("schema migration v59 (traspaso columns)", () => {
  test("adds both columns and leaves existing rows untouched", async () => {
    const client = await seedV58();

    await migrate(client);

    const columns = columnNames(
      (await client.execute("PRAGMA table_info(asset_operations)")).rows,
    );
    expect(columns).toContain("transfer_id");
    expect(columns).toContain("transfer_cost_minor");

    const rows = await client.execute(
      "SELECT kind, transfer_id, transfer_cost_minor FROM asset_operations",
    );
    expect(rows.rows[0]).toEqual({
      kind: "buy",
      transfer_cost_minor: null,
      transfer_id: null,
    });

    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(66);
  });

  test("a fresh schema already has both columns", async () => {
    const client = openLibsqlClient(":memory:");

    await client.executeMultiple(schemaSql);

    const columns = columnNames(
      (await client.execute("PRAGMA table_info(asset_operations)")).rows,
    );
    expect(columns).toContain("transfer_id");
    expect(columns).toContain("transfer_cost_minor");
  });

  test("migrating twice is a no-op", async () => {
    const client = await seedV58();

    await migrate(client);
    await migrate(client);

    const columns = columnNames(
      (await client.execute("PRAGMA table_info(asset_operations)")).rows,
    );
    expect(columns.filter((name) => name === "transfer_id")).toHaveLength(1);
  });
});
