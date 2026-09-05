/**
 * Schema migration v66 (#1518): `asset_operations.transfer_seniority_at` lands on a
 * pre-existing database and on a fresh one built from `schemaSql`, with the same
 * shape in both — the ladder and the fresh schema drifting apart is how a column
 * ends up existing only for new workspaces (ADR 0002).
 *
 * The migration backfills NOTHING, and the second test is the whole argument. The
 * only date available to derive from is `executed_at`, and that is precisely the
 * lie the column exists to stop: a movilización carries the seniority of the
 * aportaciones that funded it, and those sit in another institution's ledger.
 * Jorge's two entries are dated dic-2025 and ene-2026 for capital aportado years
 * before; seeded from the row they would tell #1528 «bloqueado hasta 2035» about
 * money that may be rescatable today.
 */
import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

/** A pre-v66 database: the full fresh schema minus the new column, pinned at 65. */
async function seedV65(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(
    schemaSql.replace(/[ \t]*`transfer_seniority_at` text,\n/g, ""),
  );
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (65)");
  await client.executeMultiple(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier, instrument) VALUES
      ('a_n5459', 'MyInvestor Cartera Permanente PP', 'investment', 'EUR', 9546, 'term-locked', 'pension_plan');

    INSERT INTO asset_operations
      (id, asset_id, kind, executed_at, units, price_per_unit, currency, source, transfer_id, transfer_cost_minor)
    VALUES
      ('op_externa', 'a_n5459', 'transfer_in', '2026-01-23', '7.836', '12.182580', 'EUR', 'manual', 'trf_ext', 9546);
  `);
  return client;
}

function columnNames(rows: unknown): string[] {
  return (rows as Array<{ name: string }>).map((c) => c.name);
}

async function schemaVersion(client: Client): Promise<number> {
  return Number(
    (await client.execute("SELECT version FROM schema_meta")).rows[0]!.version,
  );
}

async function seniority(client: Client, id: string): Promise<unknown> {
  return (
    await client.execute({
      args: [id],
      sql: "SELECT transfer_seniority_at AS s FROM asset_operations WHERE id = ?",
    })
  ).rows[0]!.s;
}

describe("schema migration v66 (la antigüedad heredada, #1518)", () => {
  test("an existing database gains the column", async () => {
    const client = await seedV65();

    await migrate(client);

    expect(
      columnNames((await client.execute("PRAGMA table_info(asset_operations)")).rows),
    ).toContain("transfer_seniority_at");
    expect(await schemaVersion(client)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(70);
  });

  test("sin backfill: la entrada externa de enero sigue muda sobre su antigüedad", async () => {
    const client = await seedV65();

    await migrate(client);

    // 23-01-2026 es el día en que el dinero LLEGÓ. Copiarlo aquí diría que esas
    // participaciones nacieron ese día, que es justo lo contrario de lo que una
    // movilización significa.
    expect(await seniority(client, "op_externa")).toBeNull();
  });

  test("a second run is a no-op", async () => {
    const client = await seedV65();

    await migrate(client);
    await migrate(client);

    expect(await schemaVersion(client)).toBe(SCHEMA_VERSION);
    expect(await seniority(client, "op_externa")).toBeNull();
  });

  test("fresh schemaSql carries the same column", async () => {
    const client = openLibsqlClient(":memory:");

    await client.executeMultiple(schemaSql);

    expect(
      columnNames((await client.execute("PRAGMA table_info(asset_operations)")).rows),
    ).toContain("transfer_seniority_at");
  });
});
