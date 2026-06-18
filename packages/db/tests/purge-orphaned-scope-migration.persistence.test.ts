/**
 * Schema v30 migration (#306): one-off cleanup of already-orphaned scope
 * snapshots.
 *
 * A snapshot must exist only for a scope `listScopeOptions` currently offers
 * (ADR 0008 frozen history is per scope). Older builds dropped a scope — a mode
 * switch to individual, a disabled/removed member, a deleted group — without
 * removing that scope's snapshots, so orphaned-scope fossils accumulated. This
 * migration clears them, reproducing the runtime rule in SQL against the stored
 * workspace:
 *   - the `household` scope ALWAYS survives;
 *   - in `individual` mode only `household` is offered → every other scope is
 *     purged;
 *   - in `household` mode the active members (`disabled_at IS NULL`) and the
 *     groups are offered → snapshots on any other scope are purged.
 * Frozen holding rows of pruned snapshots go too; `user_version` reaches
 * SCHEMA_VERSION; a second run is a no-op behind the `version < 30` guard.
 */
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { migrate, SCHEMA_VERSION } from "../src/migrate";
import { schemaSql } from "../src/schema-sql";

function seedSnapshot(scopeId: string, suffix: string): string {
  return `
    INSERT INTO snapshots
      (id, scope_id, scope_label, captured_at, date_key, month_key, currency,
       total_net_worth_minor, liquid_net_worth_minor, housing_equity_minor,
       gross_assets_minor, debts_minor)
    VALUES
      ('snap_${suffix}', '${scopeId}', '${scopeId}', '2024-01-10T12:00:00.000Z',
       '2024-01-10', '2024-01', 'EUR', 100000, 100000, 0, 100000, 0);
    INSERT INTO snapshot_holdings (id, snapshot_id, holding_id, kind, label, liquidity_tier, value_minor)
      VALUES ('sh_${suffix}', 'snap_${suffix}', 'cash', 'asset', 'Caja', 'cash', 100000);
  `;
}

/** Household workspace: Jose active, Ana disabled, one group. */
function seedHouseholdV29(): Database.Database {
  const db = new Database(":memory:");
  db.exec(schemaSql);
  db.pragma("user_version = 29");

  db.exec(`
    INSERT INTO workspace (id, mode, base_currency) VALUES ('default', 'household', 'EUR');
    INSERT INTO members (id, name, disabled_at) VALUES
      ('mJ', 'Jose', NULL),
      ('mA', 'Ana', '2024-05-01T00:00:00.000Z');
    INSERT INTO member_groups (id, name) VALUES ('gP', 'Pareja');
  `);
  db.exec(seedSnapshot("household", "household")); // survives (always)
  db.exec(seedSnapshot("mJ", "mJ")); // survives (active member)
  db.exec(seedSnapshot("gP", "gP")); // survives (group)
  db.exec(seedSnapshot("mA", "mA")); // ORPHAN: member disabled → not offered
  db.exec(seedSnapshot("gGone", "gGone")); // ORPHAN: group no longer exists

  return db;
}

/** Individual workspace: only the household scope is ever offered. */
function seedIndividualV29(): Database.Database {
  const db = new Database(":memory:");
  db.exec(schemaSql);
  db.pragma("user_version = 29");

  db.exec(`
    INSERT INTO workspace (id, mode, base_currency) VALUES ('default', 'individual', 'EUR');
    INSERT INTO members (id, name, disabled_at) VALUES ('mJ', 'Jose', NULL);
  `);
  db.exec(seedSnapshot("household", "household")); // survives (always)
  db.exec(seedSnapshot("mJ", "mJ")); // ORPHAN: individual mode offers only household
  db.exec(seedSnapshot("gP", "gP")); // ORPHAN

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

describe("purge-orphaned-scope schema migration (v30, #306)", () => {
  test("household: prunes disabled-member and deleted-group scopes, keeps household / active member / group", () => {
    const db = seedHouseholdV29();
    migrate(db);

    expect(snapshotIds(db)).toEqual(["snap_gP", "snap_household", "snap_mJ"]);
    expect(holdingIds(db)).toEqual(["sh_gP", "sh_household", "sh_mJ"]);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });

  test("individual: prunes every scope but household", () => {
    const db = seedIndividualV29();
    migrate(db);

    expect(snapshotIds(db)).toEqual(["snap_household"]);
    expect(holdingIds(db)).toEqual(["sh_household"]);
  });

  test("never prunes the household scope", () => {
    const householdDb = seedHouseholdV29();
    migrate(householdDb);
    expect(snapshotIds(householdDb)).toContain("snap_household");

    const individualDb = seedIndividualV29();
    migrate(individualDb);
    expect(snapshotIds(individualDb)).toContain("snap_household");
  });

  test("is idempotent on a second run", () => {
    const db = seedHouseholdV29();
    migrate(db);

    const before = snapshotIds(db);
    migrate(db); // second run sits behind `version < 30` → no-op
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(snapshotIds(db)).toEqual(before);
  });
});
