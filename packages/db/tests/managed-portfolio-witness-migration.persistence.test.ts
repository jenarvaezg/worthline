import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

/**
 * v63 (#1550, ADR 0085): `managed_portfolios` learns the DECLARED BALANCE — the
 * last figure the owner read in the manager's app, kept as a reconciliation
 * witness. The three columns travel together and are NOT backfilled: no
 * pre-#1550 portfolio has a declared balance, and inventing one from the derived
 * total would be worthline careing its own figure against itself.
 */

const WITNESS_COLUMNS = ["declared_value_minor", "declared_currency", "declared_date"];

function columnNames(rows: Array<Record<string, unknown>>): string[] {
  return rows.map((row) => String(row["name"]));
}

async function seedV62(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (62)");
  await client.executeMultiple(`
    CREATE TABLE managed_portfolios (
      id TEXT PRIMARY KEY NOT NULL,
      scope_id TEXT NOT NULL,
      name TEXT NOT NULL,
      provider TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    INSERT INTO managed_portfolios (id, scope_id, name, provider) VALUES
      ('prt_metal', 'household', 'Cartera Indexada Metal', 'MyInvestor');
  `);
  return client;
}

describe("schema migration v63 (declared balance)", () => {
  test("adds the three witness columns and declares nothing on existing rows", async () => {
    const client = await seedV62();

    await migrate(client);

    const columns = columnNames(
      (await client.execute("PRAGMA table_info(managed_portfolios)")).rows,
    );
    for (const column of WITNESS_COLUMNS) {
      expect(columns).toContain(column);
    }

    const rows = await client.execute(
      "SELECT name, declared_value_minor, declared_currency, declared_date FROM managed_portfolios",
    );
    expect(rows.rows[0]).toEqual({
      declared_currency: null,
      declared_date: null,
      declared_value_minor: null,
      name: "Cartera Indexada Metal",
    });

    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(67);
  });

  test("a fresh schema already has the three columns", async () => {
    const client = openLibsqlClient(":memory:");

    await client.executeMultiple(schemaSql);

    const columns = columnNames(
      (await client.execute("PRAGMA table_info(managed_portfolios)")).rows,
    );
    for (const column of WITNESS_COLUMNS) {
      expect(columns).toContain(column);
    }
  });

  test("migrating twice is a no-op", async () => {
    const client = await seedV62();

    await migrate(client);
    await migrate(client);

    const columns = columnNames(
      (await client.execute("PRAGMA table_info(managed_portfolios)")).rows,
    );
    expect(columns.filter((name) => name === "declared_value_minor")).toHaveLength(1);
  });
});
