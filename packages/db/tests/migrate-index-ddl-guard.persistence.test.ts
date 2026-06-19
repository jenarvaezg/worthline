/**
 * Migration DDL/DML guard.
 *
 * The v23 (#201) / v24 (#207) index steps and the v26 (#248) backfill UPDATE run
 * statements with a tolerance for ONE legitimate case: a minimal synthetic upgrade
 * fixture may stand up only a subset of tables, so a statement over an absent table
 * must be a no-op rather than aborting the ladder. But a bare `catch {}` ALSO
 * swallows a genuine DDL/DML bug (a column typo, a malformed statement) while still
 * bumping `user_version` — the migration would silently "succeed" with nothing run.
 *
 * `execToleratingMissingTable` narrows the tolerance to exactly the intended case:
 * swallow "no such table", surface everything else.
 */
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { execToleratingMissingTable } from "@db/migrate";

describe("execToleratingMissingTable (migration DDL/DML guard)", () => {
  test("creates the index when the table and columns exist", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);");

    execToleratingMissingTable(db, "CREATE INDEX IF NOT EXISTS t_name_idx ON t (name);");

    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("t_name_idx");
    expect(idx).toBeDefined();
    db.close();
  });

  test("tolerates a missing table (synthetic upgrade fixtures may omit it)", () => {
    const db = new Database(":memory:");

    expect(() =>
      execToleratingMissingTable(
        db,
        "CREATE INDEX IF NOT EXISTS absent_idx ON absent_table (name);",
      ),
    ).not.toThrow();
    db.close();
  });

  test("surfaces a real DDL error instead of swallowing it (column typo)", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);");

    // The table exists but the column does not — a genuine migration bug the old
    // bare `catch {}` would have silently swallowed while still bumping
    // user_version. The guard must let it throw.
    expect(() =>
      execToleratingMissingTable(
        db,
        "CREATE INDEX IF NOT EXISTS t_bad_idx ON t (nonexistent_column);",
      ),
    ).toThrow(/no such column/i);
    db.close();
  });
});
