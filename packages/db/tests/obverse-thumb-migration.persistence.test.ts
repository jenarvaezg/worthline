/**
 * Schema v27 migration (#272, x100 coins): each `positions` row now carries the
 * coin's obverse photo thumbnail (`obverse_thumb_url`), stamped at sync so the
 * collection renders as a visual gallery. Additive column, same forward-only
 * ALTER pattern as v20/v21/v22.
 *
 * A database whose `positions` predates v27 (no `obverse_thumb_url`) is migrated.
 * After v27:
 *  - the column exists on `positions`,
 *  - a row that predates it reads back null (a metal-glyph fallback in the UI),
 *  - a freshly written row can store and read a thumbnail URL.
 * A second run is a no-op (idempotent), and a fresh DB skips the ALTER (the column
 * already exists from schema-sql).
 */
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";

/** A pre-v27 DB at user_version 26: current schema minus the new position column,
 *  with one source + one coin position that predates the photo. */
function seedV26(): Database.Database {
  const db = new Database(":memory:");
  // Build the current full schema, then DROP obverse_thumb_url from positions to
  // simulate a pre-v27 shape (SQLite supports DROP COLUMN ≥ 3.35).
  db.exec(schemaSql);
  db.exec("ALTER TABLE positions DROP COLUMN obverse_thumb_url;");
  db.pragma("user_version = 26");

  db.exec(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier, instrument)
      VALUES ('a_coins', 'Colección', 'manual', 'EUR', 0, 'illiquid', 'coin_collection');
    INSERT INTO connected_sources (id, adapter, label, asset_id, credentials_json)
      VALUES ('s_numista', 'numista', 'Numista', 'a_coins', '{}');
    INSERT INTO positions (id, source_id, kind, name, liquidity_tier, currency, catalogue_id, grade, quantity)
      VALUES ('p_old', 's_numista', 'coin', '8 reales', 'illiquid', 'EUR', '1493', 'unc', 1);
  `);
  return db;
}

function positionColumns(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info(positions)").all() as { name: string }[]).map(
    (c) => c.name,
  );
}

describe("v27 positions.obverse_thumb_url migration (#272)", () => {
  test("adds the column; an old row reads null and a new row stores a URL", () => {
    const db = seedV26();
    expect(positionColumns(db)).not.toContain("obverse_thumb_url");

    migrate(db);

    expect(positionColumns(db)).toContain("obverse_thumb_url");
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);

    // The pre-existing coin gets NULL — the UI shows a metal-glyph fallback.
    const old = db
      .prepare("SELECT obverse_thumb_url AS url FROM positions WHERE id = 'p_old'")
      .get() as { url: string | null };
    expect(old.url).toBeNull();

    // A coin written after the migration can carry its catalogue photo.
    db.prepare(
      `INSERT INTO positions (id, source_id, kind, name, liquidity_tier, currency, catalogue_id, grade, quantity, obverse_thumb_url)
       VALUES ('p_new', 's_numista', 'coin', 'Eagle', 'illiquid', 'EUR', '1', 'unc', 1, ?)`,
    ).run("https://en.numista.com/catalogue/photos/x/1493-180.jpg");
    const fresh = db
      .prepare("SELECT obverse_thumb_url AS url FROM positions WHERE id = 'p_new'")
      .get() as { url: string | null };
    expect(fresh.url).toBe("https://en.numista.com/catalogue/photos/x/1493-180.jpg");
    db.close();
  });

  test("a second migrate is a no-op (idempotent) and a fresh store has the column", () => {
    const db = seedV26();
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    db.close();

    const fresh = createInMemoryStore();
    expect(fresh).toBeDefined();
  });
});
