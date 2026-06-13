/**
 * Schema v13 migration (ADR 0014, #148): the valuation_method backfill.
 *
 * A database whose holdings predate the v13 backfill (valuation_method NULL) is
 * seeded with one holding of each type / debt model plus a snapshot. After
 * migrating, valuation_method is backfilled from type/debt_model — cash/manual →
 * stored, investment → derived, real_estate → appreciating; amortizable →
 * amortized, revolving/informal → anchored, no model → stored — the snapshot's
 * five frozen figures stay byte-identical (this migration touches no figure), and
 * user_version reaches SCHEMA_VERSION.
 */
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { migrate, SCHEMA_VERSION } from "../src/migrate";
import { schemaSql } from "../src/schema-sql";

function seedV12(): Database.Database {
  const db = new Database(":memory:");
  db.exec(schemaSql);
  // Pretend this database predates the v13 backfill so migrate() runs only the
  // v13 step; the seeded rows leave valuation_method NULL for it to fill in.
  db.pragma("user_version = 12");

  db.exec(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier) VALUES
      ('a_cash', 'Caja', 'cash', 'EUR', 10000, 'cash'),
      ('a_car', 'Coche', 'manual', 'EUR', 20000, 'illiquid'),
      ('a_fund', 'Fondo', 'investment', 'EUR', 50000, 'market'),
      ('a_home', 'Piso', 'real_estate', 'EUR', 300000, 'illiquid');

    INSERT INTO liabilities (id, name, type, currency, current_balance_minor, debt_model) VALUES
      ('l_mortgage', 'Hipoteca', 'mortgage', 'EUR', 200000, 'amortizable'),
      ('l_card', 'Tarjeta', 'debt', 'EUR', 1500, 'revolving'),
      ('l_friend', 'Amigo', 'debt', 'EUR', 3000, 'informal'),
      ('l_plain', 'Suelta', 'debt', 'EUR', 500, NULL);

    INSERT INTO snapshots
      (id, scope_id, scope_label, captured_at, date_key, month_key, currency,
       total_net_worth_minor, liquid_net_worth_minor, housing_equity_minor,
       gross_assets_minor, debts_minor)
    VALUES
      ('snap1', 'household', 'Casa', '2025-01-01T12:00:00.000Z', '2025-01-01', '2025-01',
       'EUR', 180000, 9000, 120000, 390000, 210000);
  `);

  return db;
}

const assetMethod = (db: Database.Database, id: string) =>
  (db.prepare("SELECT valuation_method AS m FROM assets WHERE id = ?").get(id) as {
    m: string | null;
  }).m;

const liabilityMethod = (db: Database.Database, id: string) =>
  (db.prepare("SELECT valuation_method AS m FROM liabilities WHERE id = ?").get(id) as {
    m: string | null;
  }).m;

describe("valuation-method schema migration (v13)", () => {
  test("backfills asset valuation_method from type", () => {
    const db = seedV12();
    migrate(db);

    expect(assetMethod(db, "a_cash")).toBe("stored");
    expect(assetMethod(db, "a_car")).toBe("stored");
    expect(assetMethod(db, "a_fund")).toBe("derived");
    expect(assetMethod(db, "a_home")).toBe("appreciating");
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });

  test("backfills liability valuation_method from debt_model (no model → stored)", () => {
    const db = seedV12();
    migrate(db);

    expect(liabilityMethod(db, "l_mortgage")).toBe("amortized");
    expect(liabilityMethod(db, "l_card")).toBe("anchored");
    expect(liabilityMethod(db, "l_friend")).toBe("anchored");
    expect(liabilityMethod(db, "l_plain")).toBe("stored");
  });

  test("touches no frozen snapshot figure", () => {
    const db = seedV12();
    const select =
      "SELECT total_net_worth_minor, liquid_net_worth_minor, housing_equity_minor, " +
      "gross_assets_minor, debts_minor FROM snapshots WHERE id = 'snap1'";
    const before = db.prepare(select).get();

    migrate(db);

    expect(db.prepare(select).get()).toEqual(before);
  });
});
