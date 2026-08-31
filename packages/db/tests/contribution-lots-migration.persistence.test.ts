/**
 * Schema migration v69 (#1676, fase 2 de #1528): `contribution_lots` aterriza en una
 * base de datos que ya existía y en una recién creada desde `schemaSql`, con la MISMA
 * forma en las dos — que la escalera de migraciones y el esquema fresco se separen es
 * como una tabla acaba existiendo solo para los workspaces nuevos (ADR 0002).
 *
 * Y la tabla nace VACÍA. Es el mismo rechazo a rellenar que v66 y v67, y aquí tampoco
 * es prudencia: la única antigüedad que el libro tiene es la fecha del trámite de una
 * movilización externa (#1518), y la antigüedad heredada que v66 abrió dice desde
 * cuándo CUENTA la antigüedad, no desde cuándo se puede tocar el dinero. Ir de una a
 * otra exige la ventana normativa, que es una regla legal y no un hecho del libro: se
 * sugiere en la ficha, donde el dueño la confirma, y nunca se escribe a su espalda.
 */
import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

/** Una base de datos pre-v69: el esquema fresco sin la tabla nueva, pineada en 68. */
async function seedV68(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(
    schemaSql
      .replace(/CREATE TABLE `contribution_lots` \([\s\S]*?\);\n/, "")
      .replace(/CREATE INDEX `contribution_lots_asset_idx`[^\n]*\n/, ""),
  );
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (68)");
  await client.executeMultiple(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier, instrument) VALUES
      ('a_pp', 'Plan de pensiones', 'manual', 'EUR', 497955, 'term-locked', 'pension_plan');

    INSERT INTO asset_operations (id, asset_id, kind, executed_at, units, price_per_unit, currency, transfer_seniority_at) VALUES
      ('op_traspaso_externo', 'a_pp', 'buy', '2025-12-05', '1', '4979.55', 'EUR', '2014-03-01');
  `);
  return client;
}

async function schemaVersion(client: Client): Promise<number> {
  return Number(
    (await client.execute("SELECT version FROM schema_meta")).rows[0]!.version,
  );
}

async function lotCount(client: Client): Promise<number> {
  return Number(
    (await client.execute("SELECT COUNT(*) AS n FROM contribution_lots")).rows[0]!.n,
  );
}

describe("schema migration v69 (los lotes de aportación, #1676)", () => {
  test("una base de datos existente gana la tabla", async () => {
    const client = await seedV68();

    await migrate(client);

    const columns = (
      await client.execute("PRAGMA table_info(contribution_lots)")
    ).rows.map((column) => String(column["name"]));

    expect(columns).toEqual(
      expect.arrayContaining(["id", "asset_id", "available_from", "amount_minor"]),
    );
    expect(await schemaVersion(client)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(69);
  });

  // El corazón del ticket: la antigüedad está en la fila y AUN ASÍ no se escribe nada.
  test("sin backfill: la antigüedad heredada no se convierte en un lote", async () => {
    const client = await seedV68();

    await migrate(client);

    expect(await lotCount(client)).toBe(0);
  });

  test("una base de datos nueva trae la tabla y la escalera la deja igual", async () => {
    const fresh = openLibsqlClient(":memory:");
    await fresh.executeMultiple(schemaSql);
    await fresh.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
    await fresh.execute("INSERT INTO schema_meta (version) VALUES (0)");

    await migrate(fresh);

    expect(await lotCount(fresh)).toBe(0);
    expect(await schemaVersion(fresh)).toBe(SCHEMA_VERSION);
  });

  test("el borrado de un holding se lleva sus lotes por delante", async () => {
    const client = await seedV68();
    await migrate(client);

    await client.execute({
      sql: "INSERT INTO contribution_lots (id, asset_id, available_from, amount_minor) VALUES (?, ?, ?, ?)",
      args: ["lot_1", "a_pp", "2024-03-01", 400_000],
    });
    // El FK con `ON DELETE cascade` solo actúa con las claves foráneas encendidas.
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute("DELETE FROM assets WHERE id = 'a_pp'");

    expect(await lotCount(client)).toBe(0);
  });
});
