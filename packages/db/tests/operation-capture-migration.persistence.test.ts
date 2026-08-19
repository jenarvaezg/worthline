import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

/**
 * v54 (#1401): `asset_operations` learns to say which currency an apunte was CAPTURED
 * in. An existing row keeps all four columns NULL — the honest reading "this was
 * recorded as euros", not "the original was lost", so nothing is backfilled.
 */

function columnNames(rows: Array<Record<string, unknown>>): string[] {
  return rows.map((row) => String(row["name"]));
}

async function seedV53(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (53)");
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
    INSERT INTO assets (id) VALUES ('fidelity');
    INSERT INTO asset_operations (id, asset_id, kind, executed_at, units, price_per_unit, currency) VALUES
      ('old_op', 'fidelity', 'buy', '2026-01-23', '0.255', '8.00', 'EUR');
  `);
  return client;
}

describe("schema migration v54 (operation capture)", () => {
  test("adds the four capture columns and leaves existing rows untouched", async () => {
    const client = await seedV53();

    await migrate(client);

    const columns = columnNames(
      (await client.execute("PRAGMA table_info(asset_operations)")).rows,
    );
    expect(columns).toContain("capture_currency");
    expect(columns).toContain("capture_price_per_unit");
    expect(columns).toContain("capture_fees_minor");
    expect(columns).toContain("capture_eur_per_unit");

    const rows = await client.execute(
      `SELECT price_per_unit, currency, capture_currency, capture_price_per_unit,
              capture_fees_minor, capture_eur_per_unit
         FROM asset_operations`,
    );
    expect(rows.rows[0]).toEqual({
      capture_currency: null,
      capture_eur_per_unit: null,
      capture_fees_minor: null,
      capture_price_per_unit: null,
      currency: "EUR",
      price_per_unit: "8.00",
    });

    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(58);
  });

  test("a fresh schema already has the capture columns", async () => {
    const client = openLibsqlClient(":memory:");

    await client.executeMultiple(schemaSql);

    const columns = columnNames(
      (await client.execute("PRAGMA table_info(asset_operations)")).rows,
    );
    expect(columns).toContain("capture_currency");
    expect(columns).toContain("capture_eur_per_unit");
  });

  test("migrating twice is a no-op", async () => {
    const client = await seedV53();

    await migrate(client);
    await migrate(client);

    const columns = columnNames(
      (await client.execute("PRAGMA table_info(asset_operations)")).rows,
    );
    expect(columns.filter((name) => name === "capture_currency")).toHaveLength(1);
  });
});
