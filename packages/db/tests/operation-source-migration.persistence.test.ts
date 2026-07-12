import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

async function seedV42(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (42)");
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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    INSERT INTO assets (id, created_at) VALUES
      ('opened_asset', '2026-06-15T10:00:00Z'),
      ('manual_asset', '2026-06-15T10:00:00Z'),
      ('multi_asset', '2026-06-15T10:00:00Z');
    INSERT INTO asset_operations (id, asset_id, kind, executed_at, units, price_per_unit, currency) VALUES
      ('opening_op', 'opened_asset', 'buy', '2026-06-15', '10', '100', 'EUR'),
      ('manual_op', 'manual_asset', 'buy', '2024-01-10', '10', '100', 'EUR'),
      ('multi_opening_like', 'multi_asset', 'buy', '2026-06-15', '10', '100', 'EUR'),
      ('multi_other', 'multi_asset', 'buy', '2024-01-10', '1', '100', 'EUR');
  `);
  return client;
}

describe("schema migration v43 (operation source)", () => {
  test("adds source and backfills only the single buy on the asset creation day as opening", async () => {
    const client = await seedV42();

    await migrate(client);

    const rows = await client.execute(
      "SELECT id, source FROM asset_operations ORDER BY id",
    );

    expect(rows.rows).toEqual([
      { id: "manual_op", source: "manual" },
      { id: "multi_opening_like", source: "manual" },
      { id: "multi_other", source: "manual" },
      { id: "opening_op", source: "opening" },
    ]);
    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(48);
  });
});
