/**
 * Schema v29 migration (#305): one-off prune of already-orphaned fossil backfill
 * snapshots.
 *
 * A backfilled snapshot (id prefix `histsnap_`, ADR 0012) exists on a date ONLY
 * because an investment operation made it an event date. Older builds never
 * removed such a snapshot when the operation(s) justifying its date were deleted,
 * so fossils accumulated. This migration clears them: prune ONLY `histsnap_%`
 * snapshots whose YYYY-MM-DD `date_key` matches NO `asset_operations.executed_at`.
 * A real daily capture (`snapshot_…`) is never touched, even on an op-less date;
 * a backfill on a date an operation still justifies survives. Frozen holding rows
 * of pruned snapshots go too. `user_version` reaches SCHEMA_VERSION; a second run
 * is a no-op behind the `version < 29` guard.
 */
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { migrate, SCHEMA_VERSION } from "../src/migrate";
import { schemaSql } from "../src/schema-sql";

function seedV28(): Database.Database {
  const db = new Database(":memory:");
  db.exec(schemaSql);
  db.pragma("user_version = 28");

  db.exec(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier) VALUES
      ('fund', 'Fondo', 'investment', 'EUR', 0, 'market');

    -- An operation on 2024-03-01 only: that date stays justified.
    INSERT INTO asset_operations (id, asset_id, kind, executed_at, units, price_per_unit, currency)
    VALUES ('op_mar', 'fund', 'buy', '2024-03-01', '5', '200', 'EUR');

    INSERT INTO snapshots
      (id, scope_id, scope_label, captured_at, date_key, month_key, currency,
       total_net_worth_minor, liquid_net_worth_minor, housing_equity_minor,
       gross_assets_minor, debts_minor)
    VALUES
      -- ORPHAN: a backfill on an op-less date → must be pruned.
      ('histsnap_household_2024-01-10', 'household', 'Casa', '2024-01-10T12:00:00.000Z',
       '2024-01-10', '2024-01', 'EUR', 100000, 100000, 0, 100000, 0),
      -- JUSTIFIED: a backfill on 2024-03-01, which still has op_mar → must survive.
      ('histsnap_household_2024-03-01', 'household', 'Casa', '2024-03-01T12:00:00.000Z',
       '2024-03-01', '2024-03', 'EUR', 100000, 100000, 0, 100000, 0),
      -- DAILY CAPTURE: a real snapshot_ id on an op-less date → must survive.
      ('snapshot_household_2024_02_15_7', 'household', 'Casa', '2024-02-15T20:00:00.000Z',
       '2024-02-15', '2024-02', 'EUR', 100000, 100000, 0, 100000, 0);

    INSERT INTO snapshot_holdings (id, snapshot_id, holding_id, kind, label, liquidity_tier, value_minor) VALUES
      ('sh_orphan', 'histsnap_household_2024-01-10', 'fund', 'asset', 'Fondo', 'market', 100000),
      ('sh_just',   'histsnap_household_2024-03-01', 'fund', 'asset', 'Fondo', 'market', 100000),
      ('sh_daily',  'snapshot_household_2024_02_15_7', 'cash', 'asset', 'Caja', 'cash', 100000);
  `);

  return db;
}

const snapshotIds = (db: Database.Database): string[] =>
  (db.prepare("SELECT id FROM snapshots ORDER BY id").all() as { id: string }[]).map(
    (r) => r.id,
  );

const holdingIds = (db: Database.Database): string[] =>
  (
    db.prepare("SELECT id FROM snapshot_holdings ORDER BY id").all() as {
      id: string;
    }[]
  ).map((r) => r.id);

describe("prune-orphaned-backfill schema migration (v29, #305)", () => {
  test("prunes the orphaned backfill snapshot and its frozen rows", () => {
    const db = seedV28();
    migrate(db);

    // The op-less backfill fossil is gone...
    expect(snapshotIds(db)).not.toContain("histsnap_household_2024-01-10");
    // ...along with its frozen holding row (cascade / explicit delete).
    expect(holdingIds(db)).not.toContain("sh_orphan");
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });

  test("keeps a backfill snapshot whose date an operation still justifies", () => {
    const db = seedV28();
    migrate(db);

    expect(snapshotIds(db)).toContain("histsnap_household_2024-03-01");
    expect(holdingIds(db)).toContain("sh_just");
  });

  test("never prunes a real daily-capture snapshot, even on an op-less date", () => {
    const db = seedV28();
    migrate(db);

    expect(snapshotIds(db)).toContain("snapshot_household_2024_02_15_7");
    expect(holdingIds(db)).toContain("sh_daily");
  });

  test("is idempotent on a second run", () => {
    const db = seedV28();
    migrate(db);

    const before = snapshotIds(db);
    migrate(db); // a second run sits behind `version < 29` → no-op
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(snapshotIds(db)).toEqual(before);
  });
});
