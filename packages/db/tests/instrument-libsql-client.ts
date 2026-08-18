/**
 * SQL-statement instrumentation for read/write-shape tests (#206, #1435).
 *
 * The libSQL client has no `verbose` hook, so the only way to count what a seam
 * actually sends to the database is to wrap `execute`/`batch` and inspect each
 * SQL string. Shared by every test that asserts a query shape is BOUNDED rather
 * than proportional to the size of the history it touches.
 */

import type { Client } from "@libsql/client";

/**
 * Pull the SQL text out of any libSQL statement shape (string, `{ sql }`, or the
 * `[sql, args?]` batch tuple).
 */
export function sqlText(stmt: unknown): string {
  if (typeof stmt === "string") return stmt;
  if (Array.isArray(stmt) && typeof stmt[0] === "string") return stmt[0];
  if (
    stmt &&
    typeof stmt === "object" &&
    typeof (stmt as { sql?: unknown }).sql === "string"
  ) {
    return (stmt as { sql: string }).sql;
  }
  return "";
}

/** Wrap a libSQL client so every SQL statement it runs is reported to `tally`. */
export function instrumentClient(real: Client, tally: (sql: string) => void): Client {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "execute") {
        return (...args: unknown[]) => {
          tally(sqlText(args[0]));
          return (target.execute as (...a: unknown[]) => unknown)(...args);
        };
      }
      if (prop === "batch") {
        return (...args: unknown[]) => {
          const [stmts] = args;
          if (Array.isArray(stmts)) for (const s of stmts) tally(sqlText(s));
          return (target.batch as (...a: unknown[]) => unknown)(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Client;
}
