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
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";

/** A pre-v26 DB at user_version 25: current schema minus the new asset column. */
function seedV25(): Database.Database {
  const db = new Database(":memory:");
  // Build the current full schema, then DROP the connected_source_id column from
  // assets to simulate a pre-v26 shape (SQLite supports DROP COLUMN ≥ 3.35).
  db.exec(schemaSql);
  db.exec("ALTER TABLE assets DROP COLUMN connected_source_id;");
  db.pragma("user_version = 25");

  db.exec(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier, instrument)
      VALUES ('a_binance', 'Binance', 'manual', 'EUR', 0, 'market', 'crypto');
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier, instrument)
      VALUES ('a_cash', 'Cuenta', 'cash', 'EUR', 100000, 'cash', 'current_account');
    INSERT INTO connected_sources (id, adapter, label, asset_id, credentials_json)
      VALUES ('s_binance', 'binance', 'Binance', 'a_binance', '{}');
  `);
  return db;
}

function assetColumns(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info(assets)").all() as { name: string }[]).map(
    (c) => c.name,
  );
}

describe("v26 assets.connected_source_id migration (ADR 0016/0021, #248)", () => {
  test("adds the column and backfills the connected source's materialized asset", () => {
    const db = seedV25();
    expect(assetColumns(db)).not.toContain("connected_source_id");

    migrate(db);

    expect(assetColumns(db)).toContain("connected_source_id");

    const binance = db
      .prepare("SELECT connected_source_id AS sid FROM assets WHERE id = 'a_binance'")
      .get() as { sid: string | null };
    expect(binance.sid).toBe("s_binance");

    // A hand-maintained asset is NOT linked to any source.
    const cash = db
      .prepare("SELECT connected_source_id AS sid FROM assets WHERE id = 'a_cash'")
      .get() as { sid: string | null };
    expect(cash.sid).toBeNull();

    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });

  test("a second migrate is a no-op (idempotent) and a fresh store skips the ALTER", () => {
    const db = seedV25();
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    db.close();

    const fresh = createInMemoryStore();
    expect(() => fresh.close()).not.toThrow();
  });
});
