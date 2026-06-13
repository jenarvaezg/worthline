/**
 * Schema v12 migration (ADR 0013): the liquidity-ladder recut.
 *
 * A pre-recut (v11) database is seeded with `retirement`/`housing` tiers on both
 * live assets and frozen snapshot-holding rows, plus a snapshot carrying its five
 * frozen figures. After migrating: the tiers are remapped (retirement → term-locked,
 * housing → illiquid) on both, while the snapshot's five frozen figures stay
 * byte-identical — re-tiering history must never alter a captured figure (ADR 0008).
 */
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { migrate, SCHEMA_VERSION } from "../src/migrate";
import { schemaSql } from "../src/schema-sql";

function seedV11(): Database.Database {
  const db = new Database(":memory:");
  db.exec(schemaSql);
  // Pretend this database predates the recut so migrate() runs only the v12 step.
  db.pragma("user_version = 11");

  db.exec(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier) VALUES
      ('a_pension', 'Plan', 'manual', 'EUR', 80000, 'retirement'),
      ('a_home', 'Piso', 'real_estate', 'EUR', 300000, 'housing'),
      ('a_cash', 'Caja', 'cash', 'EUR', 10000, 'cash');

    INSERT INTO snapshots
      (id, scope_id, scope_label, captured_at, date_key, month_key, currency,
       total_net_worth_minor, liquid_net_worth_minor, housing_equity_minor,
       gross_assets_minor, debts_minor)
    VALUES
      ('snap1', 'household', 'Casa', '2025-01-01T12:00:00.000Z', '2025-01-01', '2025-01',
       'EUR', 180000, 9000, 120000, 390000, 210000);

    INSERT INTO snapshot_holdings (id, snapshot_id, holding_id, kind, label, liquidity_tier, value_minor) VALUES
      ('sh_pension', 'snap1', 'a_pension', 'asset', 'Plan', 'retirement', 80000),
      ('sh_home', 'snap1', 'a_home', 'asset', 'Piso', 'housing', 300000),
      ('sh_cash', 'snap1', 'a_cash', 'asset', 'Caja', 'cash', 10000),
      ('sh_loan', 'snap1', 'l_loan', 'liability', 'Préstamo', NULL, 30000);
  `);

  return db;
}

const FIGURE_COLUMNS = [
  "total_net_worth_minor",
  "liquid_net_worth_minor",
  "housing_equity_minor",
  "gross_assets_minor",
  "debts_minor",
] as const;

describe("liquidity-ladder schema migration (v12)", () => {
  test("remaps live asset tiers retirement → term-locked and housing → illiquid", () => {
    const db = seedV11();
    migrate(db);

    const tierOf = (id: string) =>
      (
        db.prepare("SELECT liquidity_tier AS t FROM assets WHERE id = ?").get(id) as {
          t: string;
        }
      ).t;

    expect(tierOf("a_pension")).toBe("term-locked");
    expect(tierOf("a_home")).toBe("illiquid");
    expect(tierOf("a_cash")).toBe("cash");
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });

  test("remaps frozen snapshot-holding tiers, leaving null tiers untouched", () => {
    const db = seedV11();
    migrate(db);

    const tierOf = (id: string) =>
      (
        db
          .prepare("SELECT liquidity_tier AS t FROM snapshot_holdings WHERE id = ?")
          .get(id) as {
          t: string | null;
        }
      ).t;

    expect(tierOf("sh_pension")).toBe("term-locked");
    expect(tierOf("sh_home")).toBe("illiquid");
    expect(tierOf("sh_cash")).toBe("cash");
    expect(tierOf("sh_loan")).toBeNull();
  });

  test("the five frozen figures of an existing snapshot are byte-identical after the recut", () => {
    const db = seedV11();
    const select = `SELECT ${FIGURE_COLUMNS.join(", ")} FROM snapshots WHERE id = 'snap1'`;
    const before = db.prepare(select).get();

    migrate(db);

    const after = db.prepare(select).get();
    expect(after).toEqual(before);
    // And concretely, the seeded values are intact.
    expect(after).toEqual({
      total_net_worth_minor: 180000,
      liquid_net_worth_minor: 9000,
      housing_equity_minor: 120000,
      gross_assets_minor: 390000,
      debts_minor: 210000,
    });
  });
});
