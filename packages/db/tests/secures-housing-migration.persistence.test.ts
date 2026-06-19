/**
 * Schema v16 migration (#180, ADR 0008): the secures_housing backfill on frozen
 * snapshot-holding rows.
 *
 * A database whose snapshot_holdings predate the v16 column is seeded with frozen
 * rows for a mortgage securing a housing asset, an unassociated loan, and an
 * asset, plus a snapshot. After migrating, secures_housing is backfilled to 1
 * only for the liability row whose live liability is associated to a current
 * housing asset (instrument = 'property' / real_estate / primary residence) — the
 * same pragmatic "current classification" basis the liquidity_tier denormalization
 * uses. The snapshot's five frozen figures stay byte-identical (this migration
 * touches no figure) and user_version reaches SCHEMA_VERSION. A second run is a
 * no-op (idempotent), behind the `version < 16` guard.
 */
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";

function seedV15(): Database.Database {
  const db = new Database(":memory:");
  // Genuinely pre-v16: strip the secures_housing column so migrate() exercises
  // the real legacy-DB path — ALTER TABLE ADD COLUMN then backfill — not merely a
  // backfill of an already-present column.
  db.exec(
    schemaSql.replace(/[ \t]*`secures_housing` integer DEFAULT 0 NOT NULL,\n/g, ""),
  );
  db.pragma("user_version = 15");

  db.exec(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier, instrument) VALUES
      ('a_home', 'Piso', 'real_estate', 'EUR', 300000, 'illiquid', 'property'),
      ('a_cash', 'Caja', 'cash', 'EUR', 10000, 'cash', 'current_account');

    INSERT INTO liabilities (id, name, type, currency, current_balance_minor, associated_asset_id) VALUES
      ('l_mortgage', 'Hipoteca', 'mortgage', 'EUR', 200000, 'a_home'),
      ('l_cash_pledge', 'Pignoración', 'debt', 'EUR', 5000, 'a_cash'),
      ('l_loan', 'Préstamo', 'debt', 'EUR', 3000, NULL);

    INSERT INTO snapshots
      (id, scope_id, scope_label, captured_at, date_key, month_key, currency,
       total_net_worth_minor, liquid_net_worth_minor, housing_equity_minor,
       gross_assets_minor, debts_minor)
    VALUES
      ('snap1', 'household', 'Casa', '2025-01-01T12:00:00.000Z', '2025-01-01', '2025-01',
       'EUR', 102000, 5000, 100000, 310000, 208000);

    INSERT INTO snapshot_holdings (id, snapshot_id, holding_id, kind, label, liquidity_tier, value_minor) VALUES
      ('sh_home', 'snap1', 'a_home', 'asset', 'Piso', 'illiquid', 300000),
      ('sh_cash', 'snap1', 'a_cash', 'asset', 'Caja', 'cash', 10000),
      ('sh_mortgage', 'snap1', 'l_mortgage', 'liability', 'Hipoteca', NULL, 200000),
      ('sh_pledge', 'snap1', 'l_cash_pledge', 'liability', 'Pignoración', 'cash', 5000),
      ('sh_loan', 'snap1', 'l_loan', 'liability', 'Préstamo', NULL, 3000);
  `);

  return db;
}

const securesHousing = (db: Database.Database, id: string) =>
  (
    db
      .prepare("SELECT secures_housing AS s FROM snapshot_holdings WHERE id = ?")
      .get(id) as { s: number }
  ).s;

const FIGURE_COLUMNS = [
  "total_net_worth_minor",
  "liquid_net_worth_minor",
  "housing_equity_minor",
  "gross_assets_minor",
  "debts_minor",
] as const;

describe("secures-housing schema migration (v16)", () => {
  test("backfills secures_housing=1 only for a debt securing a housing asset", () => {
    const db = seedV15();
    migrate(db);

    // The mortgage secures the housing asset → frozen 1.
    expect(securesHousing(db, "sh_mortgage")).toBe(1);
    // A debt secured against the cash account (non-housing) → 0.
    expect(securesHousing(db, "sh_pledge")).toBe(0);
    // An unassociated loan → 0.
    expect(securesHousing(db, "sh_loan")).toBe(0);
    // Assets never secure housing → 0.
    expect(securesHousing(db, "sh_home")).toBe(0);
    expect(securesHousing(db, "sh_cash")).toBe(0);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });

  test("adds the secures_housing column (the legacy ALTER path)", () => {
    const db = seedV15();
    const hasColumn = () =>
      (
        db.prepare("PRAGMA table_info(snapshot_holdings)").all() as Array<{
          name: string;
        }>
      ).some((c) => c.name === "secures_housing");

    expect(hasColumn()).toBe(false); // genuinely pre-v16: column absent
    migrate(db);
    expect(hasColumn()).toBe(true);
  });

  test("touches no frozen snapshot figure", () => {
    const db = seedV15();
    const select = `SELECT ${FIGURE_COLUMNS.join(", ")} FROM snapshots WHERE id = 'snap1'`;
    const before = db.prepare(select).get();

    migrate(db);

    expect(db.prepare(select).get()).toEqual(before);
  });

  test("is idempotent on a second run", () => {
    const db = seedV15();
    migrate(db);

    const before = db
      .prepare("SELECT id, secures_housing FROM snapshot_holdings ORDER BY id")
      .all();
    migrate(db); // a second run sits behind `version < 16` → no-op
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(
      db.prepare("SELECT id, secures_housing FROM snapshot_holdings ORDER BY id").all(),
    ).toEqual(before);
  });
});
