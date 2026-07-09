import { openLibsqlClient } from "@db/libsql-client";
import { migrate, readSchemaVersion, SCHEMA_VERSION } from "@db/migrate";
import type { Client, InStatement, ResultSet } from "@libsql/client";
import { describe, expect, test } from "vitest";

function result(rows: ResultSet["rows"] = []): ResultSet {
  return {
    columnTypes: [],
    columns: [],
    lastInsertRowid: undefined,
    rows,
    rowsAffected: 0,
    toJSON: () => ({
      columnTypes: [],
      columns: [],
      lastInsertRowid: null,
      rows: [],
      rowsAffected: 0,
    }),
  };
}

describe("migrate fast path", () => {
  test("an already-current workspace pays only the version read", async () => {
    const statements: string[] = [];
    const client = {
      execute: async (statement: InStatement) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        statements.push(sql);

        if (sql === "SELECT version FROM schema_meta LIMIT 1") {
          return result([{ version: SCHEMA_VERSION }] as unknown as ResultSet["rows"]);
        }

        return result();
      },
      executeMultiple: async (sql: string) => {
        statements.push(sql);
        return undefined;
      },
    } as unknown as Client;

    await migrate(client);

    // The version lives in `schema_meta` now (Turso rejects `PRAGMA user_version`
    // writes); a current DB pays only that single read.
    expect(statements).toEqual(["SELECT version FROM schema_meta LIMIT 1"]);
  });

  test("falls back to PRAGMA user_version for a legacy DB without schema_meta", async () => {
    const statements: string[] = [];
    const client = {
      execute: async (statement: InStatement) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        statements.push(sql);

        if (sql === "SELECT version FROM schema_meta LIMIT 1") {
          throw new Error("no such table: schema_meta");
        }
        if (sql === "PRAGMA user_version") {
          return result([
            { user_version: SCHEMA_VERSION },
          ] as unknown as ResultSet["rows"]);
        }
        return result();
      },
      executeMultiple: async () => undefined,
    } as unknown as Client;

    // A legacy local DB already at the latest version is recognized via the
    // PRAGMA fallback and never re-migrated (so an existing DB is left untouched).
    await migrate(client);
    expect(statements).toEqual([
      "SELECT version FROM schema_meta LIMIT 1",
      "PRAGMA user_version",
    ]);
  });
});

describe("migrate remote tolerance", () => {
  // Regression: a remote libSQL (Turso) rejects BOTH `PRAGMA journal_mode = WAL`
  // and `PRAGMA user_version = N` over HTTP with SQL_PARSE_ERROR. Provision-on-
  // first-login migrates a remote workspace, so the ladder must tolerate those
  // rejections and still reach the latest schema (tracked in `schema_meta`) — this
  // is the CallbackRouteError that broke the very first hosted Google sign-in.
  test("a fresh remote that rejects journal_mode + user_version writes still reaches the latest schema", async () => {
    const real = openLibsqlClient(":memory:");
    const remoteLike = new Proxy(real, {
      get(target, prop) {
        if (prop === "execute") {
          return (statement: InStatement) => {
            const sql = typeof statement === "string" ? statement : statement.sql;
            if (/journal_mode/i.test(sql) || /PRAGMA user_version\s*=/i.test(sql)) {
              return Promise.reject(
                new Error(`SQL_PARSE_ERROR: SQL not allowed statement: ${sql}`),
              );
            }
            return target.execute(statement);
          };
        }
        // Bind native client methods (e.g. executeMultiple) to the real target —
        // libSQL's Sqlite3Client rejects a Proxy as `this`.
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Client;

    await expect(migrate(remoteLike)).resolves.toBeDefined();

    // Version is read from `schema_meta`, not the (never-written) PRAGMA.
    expect(await readSchemaVersion(remoteLike)).toBe(SCHEMA_VERSION);
    const pragma = Number(
      (await real.execute("PRAGMA user_version")).rows[0]!.user_version,
    );
    expect(pragma).toBe(0);
  });
});
