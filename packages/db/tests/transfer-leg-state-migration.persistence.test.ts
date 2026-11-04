/**
 * Schema migration v77 (#1882): `asset_operations.transfer_leg_state` lands on a
 * pre-existing database and on a fresh one built from `schemaSql`, with the same
 * shape in both (ADR 0002).
 *
 * The backfill reads only the ids the MyInvestor adapter mints for a leg with no
 * pair (#1878), so it marks exactly what the first start wrote before the column
 * existed — and nothing a person wrote by hand.
 */
import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

/** A pre-v77 database: the full fresh schema minus the new column, pinned at 76. */
async function seedV76(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(
    schemaSql.replace(/[ \t]*`transfer_leg_state` text,\n/g, ""),
  );
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (76)");
  await client.executeMultiple(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier, instrument) VALUES
      ('a_plan', 'Plan conectado', 'investment', 'EUR', 0, 'term-locked', 'pension_plan'),
      ('a_origen', 'Fondo origen', 'investment', 'EUR', 0, 'invested', 'fund'),
      ('a_destino', 'Fondo destino', 'investment', 'EUR', 0, 'invested', 'fund'),
      ('a_manual', 'Plan a mano', 'investment', 'EUR', 0, 'term-locked', 'pension_plan');

    INSERT INTO asset_operations
      (id, asset_id, kind, executed_at, units, price_per_unit, currency, source, transfer_id, transfer_cost_minor)
    VALUES
      ('op_ext', 'a_plan', 'transfer_in', '2026-01-14', '40.237', '17.43', 'EUR', 'connected', 'myinvestor-external:r1', 70133),
      ('op_in', 'a_destino', 'transfer_in', '2026-06-16', '41.3', '23.5116', 'EUR', 'connected', 'myinvestor-unpaired:r3', 97103),
      ('op_out', 'a_origen', 'transfer_out', '2026-06-11', '37', '26.41', 'EUR', 'connected', 'myinvestor-unpaired:r2', NULL),
      ('op_par_out', 'a_origen', 'transfer_out', '2026-02-03', '3.1', '24.07', 'EUR', 'connected', 'myinvestor-pair:r4:r5', NULL),
      ('op_par_in', 'a_destino', 'transfer_in', '2026-02-03', '3.4', '21.94', 'EUR', 'connected', 'myinvestor-pair:r4:r5', 6911),
      ('op_mano', 'a_manual', 'transfer_in', '2026-01-23', '7.836', '12.182580', 'EUR', 'manual', 'trf_ext', 9546);
  `);
  return client;
}

async function row(client: Client, id: string) {
  return (
    await client.execute({
      args: [id],
      sql: "SELECT kind, transfer_id, transfer_leg_state FROM asset_operations WHERE id = ?",
    })
  ).rows[0]!;
}

function columnNames(rows: unknown): string[] {
  return (rows as Array<{ name: string }>).map((c) => c.name);
}

describe("schema migration v77 (lo que debe una pata de traspaso, #1882)", () => {
  test("an existing database gains the column and the version", async () => {
    const client = await seedV76();

    await migrate(client);

    expect(
      columnNames((await client.execute("PRAGMA table_info(asset_operations)")).rows),
    ).toContain("transfer_leg_state");
    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(78);
  });

  test("the entries the connector wrote without an origin are marked pending", async () => {
    const client = await seedV76();

    await migrate(client);

    expect((await row(client, "op_ext")).transfer_leg_state).toBe("cost_pending");
    expect((await row(client, "op_in")).transfer_leg_state).toBe("cost_pending");
  });

  test("an unpaired outgoing leg becomes the sale it reads as, marked unpaired", async () => {
    const client = await seedV76();

    await migrate(client);

    expect(await row(client, "op_out")).toMatchObject({
      kind: "sell",
      transfer_id: null,
      transfer_leg_state: "unpaired_out",
    });
  });

  test("a paired traspaso and a hand-written entry are left alone", async () => {
    const client = await seedV76();

    await migrate(client);

    for (const id of ["op_par_out", "op_par_in", "op_mano"]) {
      expect((await row(client, id)).transfer_leg_state).toBeNull();
    }
    expect((await row(client, "op_par_out")).kind).toBe("transfer_out");
  });

  test("a second run is a no-op", async () => {
    const client = await seedV76();

    await migrate(client);
    await migrate(client);

    expect((await row(client, "op_out")).transfer_leg_state).toBe("unpaired_out");
  });

  test("fresh schemaSql carries the same column", async () => {
    const client = openLibsqlClient(":memory:");

    await client.executeMultiple(schemaSql);

    expect(
      columnNames((await client.execute("PRAGMA table_info(asset_operations)")).rows),
    ).toContain("transfer_leg_state");
  });
});
