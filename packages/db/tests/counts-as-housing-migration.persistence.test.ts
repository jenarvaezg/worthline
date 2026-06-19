/**
 * Schema v17 migration (#181, ADR 0008): the counts_as_housing backfill on frozen
 * snapshot-holding ASSET rows — the asset-side complement of the v16
 * secures_housing migration.
 *
 * A database whose snapshot_holdings predate the v17 column (but already carry the
 * v16 secures_housing column) is seeded with frozen rows for a housing asset, a
 * non-housing asset, and three liabilities, plus a snapshot. After migrating,
 * counts_as_housing is backfilled to 1 only for the ASSET row whose live asset is
 * a current housing asset (instrument = 'property' / real_estate / primary
 * residence) — the same pragmatic "current classification" basis isHousingAsset
 * uses. Liabilities and non-housing assets stay 0. The snapshot's five frozen
 * figures stay byte-identical (this migration touches no figure) and user_version
 * reaches SCHEMA_VERSION. A second run is a no-op (idempotent), behind the
 * `version < 17` guard.
 */
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";

function seedV16(): Database.Database {
  const db = new Database(":memory:");
  // Genuinely pre-v17: strip ONLY the counts_as_housing column (keep
  // secures_housing, which v16 already added) so migrate() exercises the real
  // legacy-DB path — ALTER TABLE ADD COLUMN then backfill — not merely a backfill
  // of an already-present column.
  db.exec(
    schemaSql.replace(/[ \t]*`counts_as_housing` integer DEFAULT 0 NOT NULL,\n/g, ""),
  );
  db.pragma("user_version = 16");

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

const countsAsHousing = (db: Database.Database, id: string) =>
  (
    db
      .prepare("SELECT counts_as_housing AS c FROM snapshot_holdings WHERE id = ?")
      .get(id) as { c: number }
  ).c;

const FIGURE_COLUMNS = [
  "total_net_worth_minor",
  "liquid_net_worth_minor",
  "housing_equity_minor",
  "gross_assets_minor",
  "debts_minor",
] as const;

describe("counts-as-housing schema migration (v17)", () => {
  test("backfills counts_as_housing=1 only for an asset row that is a housing asset", () => {
    const db = seedV16();
    migrate(db);

    // The real-estate / property asset → frozen 1.
    expect(countsAsHousing(db, "sh_home")).toBe(1);
    // A non-housing (cash) asset → 0.
    expect(countsAsHousing(db, "sh_cash")).toBe(0);
    // Liabilities never count as a housing asset → 0, even the mortgage on the home.
    expect(countsAsHousing(db, "sh_mortgage")).toBe(0);
    expect(countsAsHousing(db, "sh_pledge")).toBe(0);
    expect(countsAsHousing(db, "sh_loan")).toBe(0);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });

  test("adds the counts_as_housing column (the legacy ALTER path)", () => {
    const db = seedV16();
    const hasColumn = () =>
      (
        db.prepare("PRAGMA table_info(snapshot_holdings)").all() as Array<{
          name: string;
        }>
      ).some((c) => c.name === "counts_as_housing");

    expect(hasColumn()).toBe(false); // genuinely pre-v17: column absent
    migrate(db);
    expect(hasColumn()).toBe(true);
  });

  test("touches no frozen snapshot figure", () => {
    const db = seedV16();
    const select = `SELECT ${FIGURE_COLUMNS.join(", ")} FROM snapshots WHERE id = 'snap1'`;
    const before = db.prepare(select).get();

    migrate(db);

    expect(db.prepare(select).get()).toEqual(before);
  });

  test("is idempotent on a second run", () => {
    const db = seedV16();
    migrate(db);

    const before = db
      .prepare("SELECT id, counts_as_housing FROM snapshot_holdings ORDER BY id")
      .all();
    migrate(db); // a second run sits behind `version < 17` → no-op
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(
      db.prepare("SELECT id, counts_as_housing FROM snapshot_holdings ORDER BY id").all(),
    ).toEqual(before);
  });
});
