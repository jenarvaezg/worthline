import { openLibsqlClient } from "@db/libsql-client";
import {
  migrate,
  readSchemaVersion,
  SCHEMA_VERSION,
  writeSchemaVersion,
} from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
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

/**
 * A real in-memory client whose `execute` / `executeMultiple` SQL is recorded.
 * Same Proxy-bind pattern as the Turso fixture below: libSQL rejects a Proxy as
 * `this`.
 */
function countingClient(real: Client): { client: Client; statements: string[] } {
  const statements: string[] = [];
  const client = new Proxy(real, {
    get(target, prop) {
      if (prop === "execute") {
        return (statement: InStatement) => {
          statements.push(typeof statement === "string" ? statement : statement.sql);
          return target.execute(statement);
        };
      }
      if (prop === "executeMultiple") {
        return (sql: string) => {
          statements.push(sql);
          return target.executeMultiple(sql);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Client;
  return { client, statements };
}

const schemaMetaInserts = (statements: string[]) =>
  statements.filter((sql) => /INSERT INTO schema_meta/i.test(sql));

const appliedFullSchema = (statements: string[]) =>
  statements.filter((sql) => /CREATE TABLE IF NOT EXISTS `app_settings`/.test(sql));

async function capacitySeedMarker(client: Client): Promise<string | undefined> {
  const row = await client.execute(
    "SELECT value FROM app_settings WHERE key = 'fire.capacity_seed.v56'",
  );
  return row.rows[0] === undefined ? undefined : String(row.rows[0].value);
}

describe("migrate empty-DB fast path (#1464)", () => {
  test("an empty DB stamps SCHEMA_VERSION in one write and skips the ladder", async () => {
    const real = openLibsqlClient(":memory:");
    const { client, statements } = countingClient(real);

    const result = await migrate(client);

    expect(await readSchemaVersion(client)).toBe(SCHEMA_VERSION);
    expect(result).toEqual({ ranV18Backfill: false, ranV33Backfill: false });
    // O(1) version seal: schemaSql once, then a single stamp. Not one write per
    // ladder step (~SCHEMA_VERSION − 2).
    expect(appliedFullSchema(statements)).toHaveLength(1);
    expect(schemaMetaInserts(statements)).toHaveLength(1);
    // Fresh DBs have no plan or config — v56 must not enqueue a seed marker.
    expect(await capacitySeedMarker(client)).toBeUndefined();
    // schemaSql is the full target: objects the ladder used to add after v<2
    // must already be there, or the skip would ship a truncated schema.
    const tables = (
      await real.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
    ).rows.map((row) => String(row.name));
    expect(tables).toContain("warning_overrides");
    const investmentColumns = (
      await real.execute("PRAGMA table_info(investment_assets)")
    ).rows.map((row) => String(row.name));
    expect(investmentColumns).toContain("benchmark_distributing");
    real.close();
  });

  test("an existing DB below SCHEMA_VERSION still walks the ladder", async () => {
    const real = openLibsqlClient(":memory:");
    await real.executeMultiple(schemaSql);
    await writeSchemaVersion(real, 18);
    const { client, statements } = countingClient(real);

    const result = await migrate(client);

    expect(await readSchemaVersion(client)).toBe(SCHEMA_VERSION);
    // Already past v18 / already at the cadence shape from schemaSql — the
    // backfills belong to genuine upgrades, not this fixture.
    expect(result).toEqual({ ranV18Backfill: false, ranV33Backfill: false });
    // The version-0 skip must not fire: remaining steps each stamp schema_meta,
    // schemaSql is not re-applied, and v56 still enqueues the seed (version ≥ 2).
    expect(appliedFullSchema(statements)).toHaveLength(0);
    expect(schemaMetaInserts(statements).length).toBeGreaterThan(1);
    expect(await capacitySeedMarker(client)).toBe("pending");
    real.close();
  });

  test("a genuine pre-v18 upgrade still flags the two-date backfill", async () => {
    const real = openLibsqlClient(":memory:");
    await real.executeMultiple(
      schemaSql.replace(
        /\t`disbursement_date` text NOT NULL,\n\t`first_payment_date` text NOT NULL,\n/,
        "\t`start_date` text NOT NULL,\n",
      ),
    );
    await real.execute("PRAGMA user_version = 17");

    const result = await migrate(real);

    expect(result.ranV18Backfill).toBe(true);
    expect(result.ranV33Backfill).toBe(false);
    expect(await readSchemaVersion(real)).toBe(SCHEMA_VERSION);
    real.close();
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
