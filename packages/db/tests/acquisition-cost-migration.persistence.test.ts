/**
 * Schema migration v64 (#1441): `assets.acquisition_cost_minor` lands on a
 * pre-existing database and on a fresh one built from `schemaSql`, with the same
 * shape in both — the ladder and the fresh schema drifting apart is how a column
 * ends up existing only for new workspaces (ADR 0002).
 *
 * The migration deliberately backfills NOTHING. Every property already on the
 * book carries an acquisition anchor that mixes value and cost (Yeles: 48.000 €
 * appraised, 53.354,55 € disbursed the same day), so copying that figure into the
 * cost column would seal the confusion as data. Old properties read `null` and
 * show no return until the owner types the total off the escritura.
 */
import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

/** A pre-v64 database: the full fresh schema minus the new column, pinned at 63. */
async function seedV63(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(
    schemaSql.replace(/[ \t]*`acquisition_cost_minor` integer,\n/g, ""),
  );
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (63)");
  await client.executeMultiple(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier, instrument) VALUES
      ('a_yeles', 'Yeles', 'real_estate', 'EUR', 4800000, 'illiquid', 'property');

    INSERT INTO asset_valuations (id, asset_id, valuation_date, value_minor, adjusts_prior_curve) VALUES
      ('v_yeles', 'a_yeles', '1998-03-12', 4800000, 1);
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

async function acquisitionCost(client: Client, id: string): Promise<unknown> {
  return (
    await client.execute({
      sql: "SELECT acquisition_cost_minor AS c FROM assets WHERE id = ?",
      args: [id],
    })
  ).rows[0]!.c;
}

describe("schema migration v64 (housing acquisition cost, #1441)", () => {
  test("an existing database gains the column", async () => {
    const client = await seedV63();

    await migrate(client);

    expect(
      columnNames((await client.execute("PRAGMA table_info(assets)")).rows),
    ).toContain("acquisition_cost_minor");
    expect(await schemaVersion(client)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(67);
  });

  test("no backfill from the acquisition anchor — an old property reads null", async () => {
    const client = await seedV63();

    await migrate(client);

    // The anchor says 48.000 € and the migration leaves the cost empty on purpose:
    // that anchor is a VALUE, and the disbursement was 53.354,55 €.
    expect(await acquisitionCost(client, "a_yeles")).toBeNull();
  });

  test("a second run is a no-op", async () => {
    const client = await seedV63();

    await migrate(client);
    await migrate(client);

    expect(await schemaVersion(client)).toBe(SCHEMA_VERSION);
    expect(await acquisitionCost(client, "a_yeles")).toBeNull();
  });

  test("fresh schemaSql carries the same column", async () => {
    const client = openLibsqlClient(":memory:");

    await client.executeMultiple(schemaSql);

    expect(
      columnNames((await client.execute("PRAGMA table_info(assets)")).rows),
    ).toContain("acquisition_cost_minor");
  });
});
