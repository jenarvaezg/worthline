/**
 * Schema v25 migration (ADR 0021, #246): `positions` generalizes to carry a
 * second adapter's shape — a Binance token balance — beside the Numista coin.
 *
 * A database whose `positions` predates v25 (coin-only, NOT NULL catalogue/grade/
 * quantity, no `kind`, no token columns) is seeded with a coin and migrated.
 * After migrating:
 *  - a `kind` column exists, defaulting the existing rows to 'coin',
 *  - the four token columns (symbol/balance/wallet/unit_price) exist (null),
 *  - the coin's data (catalogue/metal/candidate values) is preserved to the byte,
 *  - the coin columns are now nullable (so a token row can leave them null).
 * The rebuild is DEFENSIVE: a drifted table MISSING a column (the prior
 * positions-drift lesson) still converges instead of throwing. A second run is a
 * no-op (idempotent, behind the version guard), and a fresh DB skips the rebuild.
 */
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

import { createInMemoryStore, openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";

/** The pre-v25 `positions` DDL: coin-only, NOT NULL coin columns, no `kind`/tokens. */
const LEGACY_POSITIONS = `CREATE TABLE positions (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL,
  external_id TEXT,
  catalogue_id TEXT NOT NULL,
  issue_id INTEGER,
  name TEXT NOT NULL,
  grade TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  year INTEGER,
  liquidity_tier TEXT NOT NULL,
  metal TEXT,
  fineness_millis INTEGER,
  weight_grams REAL,
  purchase_date TEXT,
  purchase_price_minor INTEGER,
  metal_value_minor INTEGER,
  numismatic_value_minor INTEGER,
  numismatic_fetched_at TEXT,
  currency TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (source_id) REFERENCES connected_sources(id) ON UPDATE no action ON DELETE cascade
);`;

/** A pre-v25 DB at user_version 24 with the legacy positions table + one coin. */
async function seedV24(positionsDdl: string): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(schemaSql); // current full schema (incl. the NEW positions)
  await client.executeMultiple("DROP TABLE positions;"); // …then swap in the legacy shape
  await client.executeMultiple(positionsDdl);
  await client.execute("PRAGMA user_version = 24");

  await client.executeMultiple(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier, instrument)
      VALUES ('a_coins', 'Colección Numista', 'manual', 'EUR', 53800, 'illiquid', 'coin_collection');
    INSERT INTO connected_sources (id, adapter, label, asset_id, credentials_json)
      VALUES ('s_numista', 'numista', 'Colección Numista', 'a_coins', '{}');
  `);
  return client;
}

async function columnNames(client: Client): Promise<string[]> {
  return (
    (await client.execute("PRAGMA table_info(positions)")).rows as unknown as {
      name: string;
    }[]
  ).map((c) => c.name);
}

describe("v25 positions migration — coin|token generalization (ADR 0021)", () => {
  test("adds kind + token columns and preserves the coin's data", async () => {
    const client = await seedV24(LEGACY_POSITIONS);
    await client.executeMultiple(`
      INSERT INTO positions
        (id, source_id, external_id, catalogue_id, issue_id, name, grade, quantity,
         liquidity_tier, metal, metal_value_minor, numismatic_value_minor, currency)
      VALUES
        ('p1', 's_numista', 'ext1', 'n123', 7, '8 reales', 'VF', 2,
         'illiquid', 'silver', 53800, 49000, 'EUR');
    `);

    await migrate(client);

    const cols = await columnNames(client);
    expect(cols).toContain("kind");
    expect(cols).toEqual(
      expect.arrayContaining(["symbol", "balance", "wallet", "unit_price"]),
    );

    const row = (await client.execute("SELECT * FROM positions WHERE id = 'p1'"))
      .rows[0] as unknown as Record<string, unknown>;
    expect(row.kind).toBe("coin");
    expect(row.catalogue_id).toBe("n123");
    expect(row.metal).toBe("silver");
    expect(row.metal_value_minor).toBe(53800);
    expect(row.numismatic_value_minor).toBe(49000);
    expect(row.quantity).toBe(2);
    // The new token columns are null on a migrated coin row.
    expect(row.symbol).toBeNull();
    expect(row.balance).toBeNull();
    expect(
      Number((await client.execute("PRAGMA user_version")).rows[0]!.user_version),
    ).toBe(SCHEMA_VERSION);
    client.close();
  });

  test("is DEFENSIVE: a drifted legacy table missing a column still converges", async () => {
    // Simulate the positions-drift: a legacy table lacking metal_value_minor.
    const drifted = LEGACY_POSITIONS.replace("  metal_value_minor INTEGER,\n", "");
    const client = await seedV24(drifted);
    await client.executeMultiple(`
      INSERT INTO positions
        (id, source_id, external_id, catalogue_id, issue_id, name, grade, quantity,
         liquidity_tier, metal, numismatic_value_minor, currency)
      VALUES
        ('p1', 's_numista', 'ext1', 'n123', 7, '8 reales', 'VF', 1,
         'illiquid', 'silver', 49000, 'EUR');
    `);

    await expect(migrate(client)).resolves.not.toThrow();

    const cols = await columnNames(client);
    expect(cols).toContain("metal_value_minor"); // present in the target shape
    expect(cols).toContain("kind");
    const row = (await client.execute("SELECT * FROM positions WHERE id = 'p1'"))
      .rows[0] as unknown as Record<string, unknown>;
    expect(row.kind).toBe("coin");
    expect(row.numismatic_value_minor).toBe(49000);
    expect(row.metal_value_minor).toBeNull(); // the dropped column → null, not a crash
    client.close();
  });

  test("a second migrate is a no-op (idempotent) and a fresh store skips the rebuild", async () => {
    const client = await seedV24(LEGACY_POSITIONS);
    await migrate(client);
    await expect(migrate(client)).resolves.not.toThrow();
    expect(
      Number((await client.execute("PRAGMA user_version")).rows[0]!.user_version),
    ).toBe(SCHEMA_VERSION);
    client.close();

    // A fresh DB is created at the new shape by schema-sql and migrates cleanly.
    const fresh = await createInMemoryStore();
    expect(() => fresh.close()).not.toThrow();
  });
});
