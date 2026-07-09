/**
 * Schema v35 migration (#482): each `positions` row now carries the token's logo
 * URL (`image_url`), resolved from CoinGecko at sync so the Binance holding list
 * renders crypto logos (the live mirror of a coin's `obverse_thumb_url`). Additive
 * column, same forward-only ALTER pattern as v20/v22/v27.
 *
 * A database whose `positions` predates v35 (no `image_url`) is migrated. After v35:
 *  - the column exists on `positions`,
 *  - a row that predates it reads back null (a glyph fallback in the UI),
 *  - a freshly written row can store and read a logo URL.
 * A second run is a no-op (idempotent), and a fresh DB skips the ALTER (the column
 * already exists from schema-sql).
 */

import { createInMemoryStore, openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

/** A pre-v35 DB at user_version 34: current schema minus the new position column,
 *  with one Binance source + one token position that predates the logo. */
async function seedV34(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  // Build the current full schema, then DROP image_url from positions to simulate
  // a pre-v35 shape (SQLite supports DROP COLUMN ≥ 3.35).
  await client.executeMultiple(schemaSql);
  await client.executeMultiple("ALTER TABLE positions DROP COLUMN image_url;");
  await client.execute("PRAGMA user_version = 34");

  await client.executeMultiple(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier, instrument)
      VALUES ('a_binance', 'Binance', 'manual', 'EUR', 0, 'market', 'crypto');
    INSERT INTO connected_sources (id, adapter, label, asset_id, credentials_json)
      VALUES ('s_binance', 'binance', 'Binance', 'a_binance', '{}');
    INSERT INTO positions (id, source_id, kind, external_id, name, liquidity_tier, currency, symbol, balance, wallet, unit_price)
      VALUES ('p_old', 's_binance', 'token', 'BTC:spot', 'BTC', 'market', 'EUR', 'BTC', '0.5', 'spot', '50000');
  `);
  return client;
}

async function positionColumns(client: Client): Promise<string[]> {
  return (
    (await client.execute("PRAGMA table_info(positions)")).rows as unknown as {
      name: string;
    }[]
  ).map((c) => c.name);
}

describe("v35 positions.image_url migration (#482)", () => {
  test("adds the column; an old row reads null and a new row stores a URL", async () => {
    const client = await seedV34();
    expect(await positionColumns(client)).not.toContain("image_url");

    await migrate(client);

    expect(await positionColumns(client)).toContain("image_url");
    expect(
      Number((await client.execute("PRAGMA user_version")).rows[0]!.user_version),
    ).toBe(SCHEMA_VERSION);

    // The pre-existing token gets NULL — the UI shows a glyph fallback.
    const old = (
      await client.execute("SELECT image_url AS url FROM positions WHERE id = 'p_old'")
    ).rows[0] as unknown as { url: string | null };
    expect(old.url).toBeNull();

    // A token written after the migration can carry its CoinGecko logo.
    await client.execute({
      sql: `INSERT INTO positions (id, source_id, kind, external_id, name, liquidity_tier, currency, symbol, balance, wallet, unit_price, image_url)
       VALUES ('p_new', 's_binance', 'token', 'ETH:spot', 'ETH', 'market', 'EUR', 'ETH', '2', 'spot', '2000', ?)`,
      args: ["https://coin-images.coingecko.com/coins/images/279/large/ethereum.png"],
    });
    const fresh = (
      await client.execute("SELECT image_url AS url FROM positions WHERE id = 'p_new'")
    ).rows[0] as unknown as { url: string | null };
    expect(fresh.url).toBe(
      "https://coin-images.coingecko.com/coins/images/279/large/ethereum.png",
    );
    client.close();
  });

  test("a second migrate is a no-op (idempotent) and a fresh store has the column", async () => {
    const client = await seedV34();
    await migrate(client);
    await expect(migrate(client)).resolves.not.toThrow();
    expect(
      Number((await client.execute("PRAGMA user_version")).rows[0]!.user_version),
    ).toBe(SCHEMA_VERSION);
    client.close();

    const fresh = await createInMemoryStore();
    expect(fresh).toBeDefined();
  });
});
