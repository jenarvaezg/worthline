import type { Client, InStatement, ResultSet } from "@libsql/client";
import { describe, expect, test } from "vitest";

import { migrate, SCHEMA_VERSION } from "@db/migrate";

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

        if (sql === "PRAGMA user_version") {
          return result([
            { user_version: SCHEMA_VERSION },
          ] as unknown as ResultSet["rows"]);
        }

        return result();
      },
      executeMultiple: async (sql: string) => {
        statements.push(sql);
        return undefined;
      },
    } as unknown as Client;

    await migrate(client);

    expect(statements).toEqual(["PRAGMA user_version"]);
  });
});
