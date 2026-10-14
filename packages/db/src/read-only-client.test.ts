import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { openLibsqlClient } from "./libsql-client";
import {
  isReadOnlyWorkspaceError,
  ReadOnlyWorkspaceError,
  readOnlyClient,
} from "./read-only-client";

/**
 * The read-only client of a viewer principal (#1842, PRD #1718): it lets
 * through ONLY statements that read, and every refusal happens BEFORE the
 * statement reaches libSQL — so the base underneath is never touched, whatever
 * the store above tries.
 */

let raw: Client;
let guarded: Client;

async function rowCount(): Promise<number> {
  const result = await raw.execute("SELECT COUNT(*) AS n FROM t");
  return Number(result.rows[0]?.["n"]);
}

beforeEach(async () => {
  raw = openLibsqlClient(":memory:");
  await raw.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)");
  await raw.execute("INSERT INTO t (label) VALUES ('uno'), ('dos')");
  guarded = readOnlyClient(raw);
});

afterEach(() => {
  guarded.close();
});

describe("readOnlyClient · what passes", () => {
  test.each([
    "SELECT label FROM t ORDER BY id",
    "select label from t order by id",
    "  \n\tSELECT label FROM t ORDER BY id",
    "SELECT label FROM t ORDER BY id;",
    "SELECT label FROM t ORDER BY id ;  \n",
  ])("a SELECT reads through: %j", async (sql) => {
    const result = await guarded.execute(sql);
    expect(result.rows.map((row) => row["label"])).toEqual(["uno", "dos"]);
  });

  test("a SELECT with bound args, as an object and as (sql, args)", async () => {
    const asObject = await guarded.execute({
      sql: "SELECT label FROM t WHERE id = ?",
      args: [2],
    });
    const asPair = await guarded.execute("SELECT label FROM t WHERE id = ?", [1]);
    expect(asObject.rows[0]?.["label"]).toBe("dos");
    expect(asPair.rows[0]?.["label"]).toBe("uno");
  });

  test("a semicolon inside a string literal is not a second statement", async () => {
    const result = await guarded.execute("SELECT 'a; DELETE FROM t' AS v");
    expect(result.rows[0]?.["v"]).toBe("a; DELETE FROM t");
  });

  test.each([
    "PRAGMA user_version",
    "pragma user_version",
    "PRAGMA main.user_version",
    "PRAGMA schema_version;",
  ])("a read-only PRAGMA reads through: %j", async (sql) => {
    await expect(guarded.execute(sql)).resolves.toBeDefined();
  });

  test("a batch made only of SELECTs runs", async () => {
    const results = await guarded.batch([
      "SELECT COUNT(*) AS n FROM t",
      { sql: "SELECT label FROM t WHERE id = ?", args: [1] },
    ]);
    expect(results).toHaveLength(2);
  });

  test("a read transaction reads, and its handle refuses writes too", async () => {
    const tx = await guarded.transaction("read");
    try {
      const result = await tx.execute("SELECT COUNT(*) AS n FROM t");
      expect(Number(result.rows[0]?.["n"])).toBe(2);
      await expect(tx.execute("DELETE FROM t")).rejects.toBeInstanceOf(
        ReadOnlyWorkspaceError,
      );
      await expect(tx.batch(["DELETE FROM t"])).rejects.toBeInstanceOf(
        ReadOnlyWorkspaceError,
      );
      await expect(tx.executeMultiple("SELECT 1;")).rejects.toBeInstanceOf(
        ReadOnlyWorkspaceError,
      );
    } finally {
      await tx.rollback();
      tx.close();
    }
    expect(await rowCount()).toBe(2);
  });
});

describe("readOnlyClient · what is refused before it reaches the base", () => {
  test.each([
    "INSERT INTO t (label) VALUES ('tres')",
    "insert into t (label) values ('tres')",
    "REPLACE INTO t (id, label) VALUES (1, 'x')",
    "UPDATE t SET label = 'x'",
    "DELETE FROM t",
    "DROP TABLE t",
    "CREATE TABLE u (id INTEGER)",
    "ALTER TABLE t ADD COLUMN extra TEXT",
    "CREATE INDEX t_label ON t (label)",
    "ATTACH DATABASE ':memory:' AS other",
    "DETACH DATABASE other",
    "VACUUM",
    "REINDEX",
    "ANALYZE",
    "BEGIN",
    "COMMIT",
    "SAVEPOINT s",
    // A CTE can carry a write; only a leading SELECT is a read.
    "WITH doomed AS (SELECT id FROM t) DELETE FROM t WHERE id IN doomed",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    // Comments before the keyword do not launder it.
    "-- SELECT\nDELETE FROM t",
    "/* SELECT */ DELETE FROM t",
    "/* comment */ SELECT label FROM t",
    // A SELECT prefix does not cover a second statement.
    "SELECT 1; DELETE FROM t",
    "SELECT 1;DELETE FROM t",
    "SELECT 1; -- trailing\nDELETE FROM t",
    "SELECT ';' ; DELETE FROM t",
    // A keyword that merely starts with SELECT is not SELECT.
    "SELECTED FROM t",
    // Pragmas: only argument-free reads of the allow-list.
    "PRAGMA user_version = 5",
    "PRAGMA user_version=5",
    "PRAGMA user_version(5)",
    "PRAGMA foreign_keys = OFF",
    "PRAGMA journal_mode = DELETE",
    "PRAGMA optimize",
    "PRAGMA wal_checkpoint",
    "PRAGMA incremental_vacuum",
    "PRAGMA shrink_memory",
    "PRAGMA user_version; DELETE FROM t",
    "EXPLAIN DELETE FROM t",
    "",
    "   ",
  ])("execute refuses %j", async (sql) => {
    await expect(guarded.execute(sql)).rejects.toBeInstanceOf(ReadOnlyWorkspaceError);
    await expect(guarded.execute({ sql, args: [] })).rejects.toBeInstanceOf(
      ReadOnlyWorkspaceError,
    );
    expect(await rowCount()).toBe(2);
  });

  test("a batch with one write among reads is refused whole, nothing runs", async () => {
    await expect(
      guarded.batch(["SELECT COUNT(*) FROM t", "DELETE FROM t"]),
    ).rejects.toBeInstanceOf(ReadOnlyWorkspaceError);
    await expect(
      guarded.batch([["INSERT INTO t (label) VALUES (?)", ["tres"]]]),
    ).rejects.toBeInstanceOf(ReadOnlyWorkspaceError);
    expect(await rowCount()).toBe(2);
  });

  test("a batch in write mode is refused even when it only reads", async () => {
    await expect(guarded.batch(["SELECT 1"], "write")).rejects.toBeInstanceOf(
      ReadOnlyWorkspaceError,
    );
  });

  test("executeMultiple is refused whatever it carries", async () => {
    await expect(guarded.executeMultiple("SELECT 1;")).rejects.toBeInstanceOf(
      ReadOnlyWorkspaceError,
    );
    await expect(guarded.executeMultiple("DELETE FROM t;")).rejects.toBeInstanceOf(
      ReadOnlyWorkspaceError,
    );
    expect(await rowCount()).toBe(2);
  });

  test("migrate is refused", async () => {
    await expect(guarded.migrate(["SELECT 1"])).rejects.toBeInstanceOf(
      ReadOnlyWorkspaceError,
    );
  });

  test.each([
    ["write" as const],
    ["deferred" as const],
    [undefined],
  ])("a transaction in mode %j is refused", async (mode) => {
    const open = mode === undefined ? guarded.transaction() : guarded.transaction(mode);
    await expect(open).rejects.toBeInstanceOf(ReadOnlyWorkspaceError);
  });

  test("the refusal names the statement kind, never the arguments", async () => {
    const error = await guarded
      .execute({ sql: "INSERT INTO t (label) VALUES (?)", args: ["secreto"] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReadOnlyWorkspaceError);
    expect(String((error as Error).message)).not.toContain("secreto");
  });

  test("the wrapper does not hand out the raw client", () => {
    const exposed = Object.values(guarded as unknown as Record<string, unknown>);
    expect(exposed).not.toContain(raw);
  });
});

describe("isReadOnlyWorkspaceError", () => {
  test("recognises the refusal bare, nested as a cause, or re-raised by its code", () => {
    const refusal = new ReadOnlyWorkspaceError("INSERT");
    const drizzleWrapped = new Error("Failed query: insert …", { cause: refusal });
    const commandReraised = Object.assign(new Error(refusal.message), {
      code: refusal.code,
    });
    expect(isReadOnlyWorkspaceError(refusal)).toBe(true);
    expect(isReadOnlyWorkspaceError(drizzleWrapped)).toBe(true);
    expect(isReadOnlyWorkspaceError(commandReraised)).toBe(true);
  });

  test("anything else is not a refusal", () => {
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(isReadOnlyWorkspaceError(new Error("SQLITE_CONSTRAINT"))).toBe(false);
    expect(isReadOnlyWorkspaceError("WORKSPACE_READ_ONLY")).toBe(false);
    expect(isReadOnlyWorkspaceError(null)).toBe(false);
    expect(isReadOnlyWorkspaceError(loop)).toBe(false);
  });
});
