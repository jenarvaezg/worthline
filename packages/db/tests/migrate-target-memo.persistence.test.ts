import { __resetMigratedTargetsForTests, migrateTarget } from "@db/database-target";
import { openLibsqlClient } from "@db/libsql-client";
import { readSchemaVersion, SCHEMA_VERSION } from "@db/migrate";
import type { Client, InStatement } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * A real in-memory libSQL client wrapped so every `execute` / `executeMultiple`
 * SQL string it runs is recorded — the statement counter #1194's acceptance
 * criteria are phrased against ("the second open runs zero version reads"). The
 * DB is genuinely migrated, so `readSchemaVersion` on it is authoritative.
 */
function countingClient(): { client: Client; statements: string[] } {
  const real = openLibsqlClient(":memory:");
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
      // Bind native client methods to the real target — libSQL's Sqlite3Client
      // rejects a Proxy as `this` (same pattern as migrate-fast-path).
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Client;
  return { client, statements };
}

const url = (name: string) => `libsql://memo-${name}.turso.io`;

// The memo is per-process module state; start every spec from a clean slate so
// one test's populated entry can't mask another's first open.
beforeEach(() => __resetMigratedTargetsForTests());
afterEach(() => __resetMigratedTargetsForTests());

describe("migrateTarget per-process schema-version memo (#1194)", () => {
  test("the second open of an already-migrated base runs no schema-version read", async () => {
    const target = { kind: "url", url: url("second-open") } as const;

    const first = countingClient();
    await migrateTarget(target, first.client);
    first.client.close();

    const second = countingClient();
    await migrateTarget(target, second.client);
    second.client.close();

    // The whole migrate() call — including the `schema_meta` version probe — is
    // skipped on the warm path, so the second open touches the network zero times.
    expect(second.statements).toEqual([]);
    expect(second.statements.some((sql) => /schema_meta/i.test(sql))).toBe(false);
  });

  test("a base that still needs migrating runs its ladder and reaches the target version", async () => {
    const target = { kind: "url", url: url("needs-migrate") } as const;

    const { client, statements } = countingClient();
    const result = await migrateTarget(target, client);

    // The ladder genuinely ran (far more than a lone version probe) and left the
    // base at the compiled schema version — the memo only populates afterwards.
    expect(statements.length).toBeGreaterThan(1);
    expect(await readSchemaVersion(client)).toBe(SCHEMA_VERSION);
    expect(result).toEqual({ ranV18Backfill: false, ranV33Backfill: false });
    client.close();
  });

  test("multi-base: one entry per base, no cross-contamination", async () => {
    const a = { kind: "url", url: url("workspace-a") } as const;
    const b = { kind: "url", url: url("workspace-b") } as const;

    // Migrate A → its entry is memoized.
    const firstA = countingClient();
    await migrateTarget(a, firstA.client);
    firstA.client.close();

    // Opening B (a DIFFERENT base) must still migrate — A's memo must not shadow it.
    const firstB = countingClient();
    await migrateTarget(b, firstB.client);
    expect(firstB.statements.length).toBeGreaterThan(1);
    expect(await readSchemaVersion(firstB.client)).toBe(SCHEMA_VERSION);
    firstB.client.close();

    // Both bases are now individually warm: each re-open is a no-op read.
    const warmA = countingClient();
    await migrateTarget(a, warmA.client);
    expect(warmA.statements).toEqual([]);
    warmA.client.close();

    const warmB = countingClient();
    await migrateTarget(b, warmB.client);
    expect(warmB.statements).toEqual([]);
    warmB.client.close();
  });

  test("path targets are never memoized (a reused :memory:/file url is a distinct DB each time)", async () => {
    const target = { kind: "path", databasePath: "/tmp/never-memoized.sqlite" } as const;

    const first = countingClient();
    await migrateTarget(target, first.client);
    first.client.close();

    // A path target reuses one url string across genuinely distinct databases, so
    // skipping its migration would be a correctness bug — the ladder must re-run.
    const second = countingClient();
    await migrateTarget(target, second.client);
    expect(second.statements.length).toBeGreaterThan(1);
    expect(await readSchemaVersion(second.client)).toBe(SCHEMA_VERSION);
    second.client.close();
  });
});
