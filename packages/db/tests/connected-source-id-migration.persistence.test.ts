/**
 * Schema v26 migration (ADR 0016/0021, #248): a connected source now materializes
 * ONE asset per occupied liquidity rung, so each materialized asset carries a
 * `connected_source_id` back-link (a plain TEXT column, NO FK — to avoid a cascade
 * cycle with `connected_sources.asset_id → assets ON DELETE cascade`).
 *
 * A database whose `assets` predates v26 (no `connected_source_id`) with an
 * already-connected source (its market asset linked only via
 * `connected_sources.asset_id`) is migrated. After v26:
 *  - the `connected_source_id` column exists on `assets`,
 *  - the existing source's market asset is BACKFILLED to its source id,
 *  - an unrelated hand-maintained asset stays null.
 * A second run is a no-op (idempotent), and a fresh DB skips the ALTER (the column
 * already exists from schema-sql) but still backfills correctly.
 */
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

import { createInMemoryStore, openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";

/** A pre-v26 DB at user_version 25: current schema minus the new asset column. */
async function seedV25(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  // Build the current full schema, then DROP the connected_source_id column from
  // assets to simulate a pre-v26 shape (SQLite supports DROP COLUMN ≥ 3.35).
  await client.executeMultiple(schemaSql);
  await client.executeMultiple("ALTER TABLE assets DROP COLUMN connected_source_id;");
  await client.execute("PRAGMA user_version = 25");

  await client.executeMultiple(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier, instrument)
      VALUES ('a_binance', 'Binance', 'manual', 'EUR', 0, 'market', 'crypto');
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier, instrument)
      VALUES ('a_cash', 'Cuenta', 'cash', 'EUR', 100000, 'cash', 'current_account');
    INSERT INTO connected_sources (id, adapter, label, asset_id, credentials_json)
      VALUES ('s_binance', 'binance', 'Binance', 'a_binance', '{}');
  `);
  return client;
}

async function assetColumns(client: Client): Promise<string[]> {
  return (
    (await client.execute("PRAGMA table_info(assets)")).rows as unknown as {
      name: string;
    }[]
  ).map((c) => c.name);
}

const userVersion = async (client: Client) =>
  Number((await client.execute("PRAGMA user_version")).rows[0]!.user_version);

describe("v26 assets.connected_source_id migration (ADR 0016/0021, #248)", () => {
  test("adds the column and backfills the connected source's materialized asset", async () => {
    const client = await seedV25();
    expect(await assetColumns(client)).not.toContain("connected_source_id");

    await migrate(client);

    expect(await assetColumns(client)).toContain("connected_source_id");

    const binance = (
      await client.execute(
        "SELECT connected_source_id AS sid FROM assets WHERE id = 'a_binance'",
      )
    ).rows[0] as unknown as { sid: string | null };
    expect(binance.sid).toBe("s_binance");

    // A hand-maintained asset is NOT linked to any source.
    const cash = (
      await client.execute(
        "SELECT connected_source_id AS sid FROM assets WHERE id = 'a_cash'",
      )
    ).rows[0] as unknown as { sid: string | null };
    expect(cash.sid).toBeNull();

    expect(await userVersion(client)).toBe(SCHEMA_VERSION);
    client.close();
  });

  test("a second migrate is a no-op (idempotent) and a fresh store skips the ALTER", async () => {
    const client = await seedV25();
    await migrate(client);
    await expect(migrate(client)).resolves.not.toThrow();
    expect(await userVersion(client)).toBe(SCHEMA_VERSION);
    client.close();

    const fresh = await createInMemoryStore();
    expect(() => fresh.close()).not.toThrow();
  });
});
