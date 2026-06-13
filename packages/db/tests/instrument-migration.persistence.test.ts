/**
 * Schema v14 migration (ADR 0014, #149): the instrument backfill.
 *
 * A database whose holdings predate the v14 backfill (instrument NULL) is seeded
 * with one holding of each type / debt model plus a snapshot. After migrating,
 * instrument is backfilled from type / debt model — cash → current_account,
 * manual → other, a real-estate OR primary-residence asset → property, an
 * investment → pension_plan when priced by Finect else fund; a mortgage →
 * mortgage, a revolving debt → credit_card, every other debt → loan — the
 * snapshot's five frozen figures stay byte-identical (this migration touches no
 * figure), and user_version reaches SCHEMA_VERSION.
 */
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { migrate, SCHEMA_VERSION } from "../src/migrate";
import { schemaSql } from "../src/schema-sql";

function seedV13(): Database.Database {
  const db = new Database(":memory:");
  // Genuinely pre-v14: strip the instrument column so migrate() exercises the
  // real legacy-DB path — ALTER TABLE ADD COLUMN then backfill — not merely a
  // backfill of an already-present column.
  db.exec(schemaSql.replace(/[ \t]*`instrument` text,\n/g, ""));
  db.pragma("user_version = 13");

  db.exec(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier) VALUES
      ('a_cash', 'Caja', 'cash', 'EUR', 10000, 'cash'),
      ('a_car', 'Coche', 'manual', 'EUR', 20000, 'illiquid'),
      ('a_fund', 'Fondo', 'investment', 'EUR', 50000, 'market'),
      ('a_pension', 'Plan', 'investment', 'EUR', 40000, 'term-locked'),
      ('a_home', 'Piso', 'real_estate', 'EUR', 300000, 'illiquid');

    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier, is_primary_residence) VALUES
      ('a_residence', 'Vivienda', 'manual', 'EUR', 250000, 'illiquid', 1);

    -- The fine-grained investment instrument is read off the price provider.
    INSERT INTO investment_assets (asset_id, price_provider) VALUES
      ('a_fund', 'yahoo'),
      ('a_pension', 'finect');

    INSERT INTO liabilities (id, name, type, currency, current_balance_minor, debt_model) VALUES
      ('l_mortgage', 'Hipoteca', 'mortgage', 'EUR', 200000, 'amortizable'),
      ('l_loan', 'Préstamo', 'debt', 'EUR', 8000, 'amortizable'),
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

const assetInstrument = (db: Database.Database, id: string) =>
  (db.prepare("SELECT instrument AS i FROM assets WHERE id = ?").get(id) as {
    i: string | null;
  }).i;

const liabilityInstrument = (db: Database.Database, id: string) =>
  (db.prepare("SELECT instrument AS i FROM liabilities WHERE id = ?").get(id) as {
    i: string | null;
  }).i;

describe("instrument schema migration (v14)", () => {
  test("backfills asset instrument from type (+ provider for investments)", () => {
    const db = seedV13();
    migrate(db);

    expect(assetInstrument(db, "a_cash")).toBe("current_account");
    expect(assetInstrument(db, "a_car")).toBe("other");
    expect(assetInstrument(db, "a_fund")).toBe("fund");
    // An investment priced by Finect is a pension plan.
    expect(assetInstrument(db, "a_pension")).toBe("pension_plan");
    expect(assetInstrument(db, "a_home")).toBe("property");
    // A primary residence is a property even when its type isn't real_estate —
    // the backfill mirrors the runtime isHousingAsset boundary.
    expect(assetInstrument(db, "a_residence")).toBe("property");
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });

  test("backfills liability instrument from type + debt model", () => {
    const db = seedV13();
    migrate(db);

    expect(liabilityInstrument(db, "l_mortgage")).toBe("mortgage");
    expect(liabilityInstrument(db, "l_loan")).toBe("loan");
    expect(liabilityInstrument(db, "l_card")).toBe("credit_card");
    expect(liabilityInstrument(db, "l_friend")).toBe("loan");
    expect(liabilityInstrument(db, "l_plain")).toBe("loan");
  });

  test("touches no frozen snapshot figure", () => {
    const db = seedV13();
    const select =
      "SELECT total_net_worth_minor, liquid_net_worth_minor, housing_equity_minor, " +
      "gross_assets_minor, debts_minor FROM snapshots WHERE id = 'snap1'";
    const before = db.prepare(select).get();

    migrate(db);

    expect(db.prepare(select).get()).toEqual(before);
  });

  test("adds the instrument column to both tables (the legacy ALTER path)", () => {
    const db = seedV13();
    const hasColumn = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
        (c) => c.name === "instrument",
      );

    expect(hasColumn("assets")).toBe(false); // genuinely pre-v14: column absent
    migrate(db);
    expect(hasColumn("assets")).toBe(true);
    expect(hasColumn("liabilities")).toBe(true);
  });

  test("leaves no holding null and is idempotent on a second run", () => {
    const db = seedV13();
    migrate(db);

    const nullCount = () =>
      (
        db
          .prepare(
            "SELECT (SELECT COUNT(*) FROM assets WHERE instrument IS NULL) + " +
              "(SELECT COUNT(*) FROM liabilities WHERE instrument IS NULL) AS n",
          )
          .get() as { n: number }
      ).n;

    expect(nullCount()).toBe(0);

    const before = db.prepare("SELECT id, instrument FROM assets ORDER BY id").all();
    migrate(db); // a second run sits behind `version < 14` → no-op
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(db.prepare("SELECT id, instrument FROM assets ORDER BY id").all()).toEqual(before);
  });
});
