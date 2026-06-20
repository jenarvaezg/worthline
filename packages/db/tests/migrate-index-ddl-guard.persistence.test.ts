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
import { describe, expect, test } from "vitest";

import { openLibsqlClient } from "@db/index";
import { execToleratingMissingTable } from "@db/migrate";

describe("execToleratingMissingTable (migration DDL/DML guard)", () => {
  test("creates the index when the table and columns exist", async () => {
    const client = openLibsqlClient(":memory:");
    await client.executeMultiple("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);");

    await execToleratingMissingTable(
      client,
      "CREATE INDEX IF NOT EXISTS t_name_idx ON t (name);",
    );

    const idx = (
      await client.execute({
        sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        args: ["t_name_idx"],
      })
    ).rows[0];
    expect(idx).toBeDefined();
    client.close();
  });

  test("tolerates a missing table (synthetic upgrade fixtures may omit it)", async () => {
    const client = openLibsqlClient(":memory:");

    await expect(
      execToleratingMissingTable(
        client,
        "CREATE INDEX IF NOT EXISTS absent_idx ON absent_table (name);",
      ),
    ).resolves.not.toThrow();
    client.close();
  });

  test("surfaces a real DDL error instead of swallowing it (column typo)", async () => {
    const client = openLibsqlClient(":memory:");
    await client.executeMultiple("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);");

    // The table exists but the column does not — a genuine migration bug the old
    // bare `catch {}` would have silently swallowed while still bumping
    // user_version. The guard must let it throw.
    await expect(
      execToleratingMissingTable(
        client,
        "CREATE INDEX IF NOT EXISTS t_bad_idx ON t (nonexistent_column);",
      ),
    ).rejects.toThrow(/no such column/i);
    client.close();
  });
});
