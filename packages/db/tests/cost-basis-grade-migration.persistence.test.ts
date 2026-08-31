/**
 * Schema migration v65 (#1505): `asset_operations.cost_basis_grade` lands on a
 * pre-existing database and on a fresh one built from `schemaSql`, with the same
 * shape in both — the ladder and the fresh schema drifting apart is how a column
 * ends up existing only for new workspaces (ADR 0002).
 *
 * The migration deliberately backfills NOTHING, and the second test is the whole
 * argument: Jorge's apertura and a real purchase made the same day are the SAME
 * row. Marking either by heuristic would hand a user a «sin coste real» over a
 * cost he actually declared, or leave the silent 0 € in place — the app cannot
 * answer this, only the owner can.
 */
import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

/** A pre-v65 database: the full fresh schema minus the new column, pinned at 64. */
async function seedV64(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(
    schemaSql.replace(/[ \t]*`cost_basis_grade` text,\n/g, ""),
  );
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (64)");
  await client.executeMultiple(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier, instrument) VALUES
      ('a_sxr1', 'iShares Core S&P 500', 'investment', 'EUR', 586575, 'liquid', 'etf');

    INSERT INTO asset_operations (id, asset_id, kind, executed_at, units, price_per_unit, currency, source) VALUES
      ('op_apertura', 'a_sxr1', 'buy', '2026-08-19', '27', '217.25', 'EUR', 'opening'),
      ('op_compra', 'a_sxr1', 'buy', '2026-08-19', '3', '217.25', 'EUR', 'manual');
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

async function grade(client: Client, id: string): Promise<unknown> {
  return (
    await client.execute({
      sql: "SELECT cost_basis_grade AS g FROM asset_operations WHERE id = ?",
      args: [id],
    })
  ).rows[0]!.g;
}

describe("schema migration v65 (el grado del coste, #1505)", () => {
  test("an existing database gains the column", async () => {
    const client = await seedV64();

    await migrate(client);

    expect(
      columnNames((await client.execute("PRAGMA table_info(asset_operations)")).rows),
    ).toContain("cost_basis_grade");
    expect(await schemaVersion(client)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(66);
  });

  test("sin backfill: la apertura vieja y la compra real quedan igual de mudas", async () => {
    const client = await seedV64();

    await migrate(client);

    // Las dos filas son idénticas salvo el `source`, y ese `source` no dice nada
    // del coste: una apertura CON coste declarado también lo lleva. Marcar por
    // heurística sería inventar la respuesta de un usuario.
    expect(await grade(client, "op_apertura")).toBeNull();
    expect(await grade(client, "op_compra")).toBeNull();
  });

  test("a second run is a no-op", async () => {
    const client = await seedV64();

    await migrate(client);
    await migrate(client);

    expect(await schemaVersion(client)).toBe(SCHEMA_VERSION);
    expect(await grade(client, "op_apertura")).toBeNull();
  });

  test("fresh schemaSql carries the same column", async () => {
    const client = openLibsqlClient(":memory:");

    await client.executeMultiple(schemaSql);

    expect(
      columnNames((await client.execute("PRAGMA table_info(asset_operations)")).rows),
    ).toContain("cost_basis_grade");
  });
});
