/**
 * Schema migration v67 (#1528, ADR 0100): `assets.available_from` lands on a
 * pre-existing database and on a fresh one built from `schemaSql`, with the same
 * shape in both — the ladder and the fresh schema drifting apart is how a column
 * ends up existing only for new workspaces (ADR 0002).
 *
 * The migration deliberately backfills NOTHING, and this is the one place where
 * that is not just caution. Both pension-plan entries on the real book are ALTAS
 * BY EXTERNAL TRANSFER (#1518): the row carries the day of the paperwork, and a
 * movilización inherits the seniority of the contributions that generated it —
 * which live outside the book entirely. Deriving from the row date would print
 * «bloqueado hasta 2035» over money that may be withdrawable today, inventing in
 * the direction opposite to the bug, and through the same door as #1490.
 */
import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

/** A pre-v67 database: the full fresh schema minus the new column, pinned at 66. */
async function seedV66(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(schemaSql.replace(/[ \t]*`available_from` text,\n/g, ""));
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (66)");
  await client.executeMultiple(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier, instrument) VALUES
      ('a_pp', 'Plan de pensiones', 'manual', 'EUR', 497955, 'term-locked', 'pension_plan');

    INSERT INTO asset_operations (id, asset_id, kind, executed_at, units, price_per_unit, currency) VALUES
      ('op_traspaso_externo', 'a_pp', 'buy', '2025-12-05', '1', '4979.55', 'EUR');
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

async function availableFrom(client: Client, id: string): Promise<unknown> {
  return (
    await client.execute({
      sql: "SELECT available_from AS d FROM assets WHERE id = ?",
      args: [id],
    })
  ).rows[0]!.d;
}

describe("schema migration v67 (declared availability date, #1528)", () => {
  test("an existing database gains the column", async () => {
    const client = await seedV66();

    await migrate(client);

    expect(
      columnNames((await client.execute("PRAGMA table_info(assets)")).rows),
    ).toContain("available_from");
    expect(await schemaVersion(client)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(70);
  });

  test("no date is derived from the ledger — an alta por traspaso externo reads null", async () => {
    const client = await seedV66();

    await migrate(client);

    // La fila dice 05-12-2025 y esa NO es la antigüedad de las aportaciones: es el
    // día del traspaso. Sin declaración, «nadie lo ha dicho».
    expect(await availableFrom(client, "a_pp")).toBeNull();
  });

  test("a second run is a no-op", async () => {
    const client = await seedV66();

    await migrate(client);
    await migrate(client);

    expect(await schemaVersion(client)).toBe(SCHEMA_VERSION);
    expect(await availableFrom(client, "a_pp")).toBeNull();
  });

  test("fresh schemaSql carries the same column", async () => {
    const client = openLibsqlClient(":memory:");

    await client.executeMultiple(schemaSql);

    expect(
      columnNames((await client.execute("PRAGMA table_info(assets)")).rows),
    ).toContain("available_from");
  });
});
