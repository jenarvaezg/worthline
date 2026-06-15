/**
 * Index-migration DDL guard.
 *
 * The v23 (#201) and v24 (#207) migration steps create indexes with a bare
 * `try { sqlite.exec(...) } catch {}`. The catch exists for ONE legitimate
 * reason: a minimal synthetic upgrade fixture may stand up only a subset of
 * tables, so `CREATE INDEX` over an absent table must be a no-op rather than
 * aborting the ladder. But a bare catch ALSO swallows a genuine DDL bug (a
 * column typo, a malformed statement) while still bumping `user_version` — the
 * migration would silently "succeed" with the index never created.
 *
 * `createIndexToleratingMissingTable` narrows the tolerance to exactly the
 * intended case: swallow "no such table", surface everything else.
 */
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { createIndexToleratingMissingTable } from "../src/migrate";

describe("createIndexToleratingMissingTable (index migration DDL guard)", () => {
  test("creates the index when the table and columns exist", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);");

    createIndexToleratingMissingTable(
      db,
      "CREATE INDEX IF NOT EXISTS t_name_idx ON t (name);",
    );

    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("t_name_idx");
    expect(idx).toBeDefined();
    db.close();
  });

  test("tolerates a missing table (synthetic upgrade fixtures may omit it)", () => {
    const db = new Database(":memory:");

    expect(() =>
      createIndexToleratingMissingTable(
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
      createIndexToleratingMissingTable(
        db,
        "CREATE INDEX IF NOT EXISTS t_bad_idx ON t (nonexistent_column);",
      ),
    ).toThrow(/no such column/i);
    db.close();
  });
});
