/**
 * The v56 FIRE seed marker was read on every store open, even after the marker
 * had been retired (#1536). Production URL targets memoize a settled (non-pending)
 * outcome per process, the same way `migratedTargets` skips a warm migrate.
 *
 * Path / `:memory:` targets are NOT memoized: those strings are reused across
 * genuinely distinct databases, so skipping their SELECT would be a correctness
 * bug (the seed tests reopen from v55 on a fresh DB that still needs the work).
 */

import { __resetFireSeedMemoForTests } from "@db/fire-savings-capacity-seed";
import { openLibsqlClient } from "@db/libsql-client";
import { createStoreFromSqlite } from "@db/testing";
import type { Client, InStatement } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const SEED_MARKER_KEY = "fire.capacity_seed.v56";

function recordingClient(): {
  client: Client;
  records: { args: unknown[]; sql: string }[];
} {
  const real = openLibsqlClient(":memory:");
  const records: { args: unknown[]; sql: string }[] = [];
  const client = new Proxy(real, {
    get(target, prop) {
      if (prop === "execute") {
        return (statement: InStatement) => {
          if (typeof statement === "string") {
            records.push({ args: [], sql: statement });
          } else {
            const rawArgs = statement.args;
            const args = Array.isArray(rawArgs)
              ? [...rawArgs]
              : rawArgs && typeof rawArgs === "object"
                ? Object.values(rawArgs)
                : [];
            records.push({ args, sql: statement.sql });
          }
          return target.execute(statement);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Client;
  return { client, records };
}

function seedMarkerReads(records: { args: unknown[]; sql: string }[]): number {
  return records.filter((record) => {
    if (!/app_settings/i.test(record.sql) || !/select/i.test(record.sql)) return false;
    return (
      record.sql.includes(SEED_MARKER_KEY) ||
      record.args.some((value) => value === SEED_MARKER_KEY)
    );
  }).length;
}

beforeEach(() => __resetFireSeedMemoForTests());
afterEach(() => __resetFireSeedMemoForTests());

describe("FIRE seed marker memo (#1536)", () => {
  test("a warm URL-keyed open does not SELECT the seed marker", async () => {
    const { client, records } = recordingClient();
    const memoKey = "libsql://workspace-a.turso.io";

    await createStoreFromSqlite(client, { seedMemoKey: memoKey });
    expect(seedMarkerReads(records)).toBeGreaterThan(0);

    records.length = 0;
    await createStoreFromSqlite(client, { seedMemoKey: memoKey });
    expect(seedMarkerReads(records)).toBe(0);

    client.close();
  });

  test("without a memo key, every open still reads the marker (path/:memory: DBs)", async () => {
    const { client, records } = recordingClient();

    await createStoreFromSqlite(client);
    expect(seedMarkerReads(records)).toBeGreaterThan(0);

    records.length = 0;
    await createStoreFromSqlite(client);
    expect(seedMarkerReads(records)).toBeGreaterThan(0);

    client.close();
  });

  test("two URL keys do not share a memo entry", async () => {
    const first = recordingClient();
    await createStoreFromSqlite(first.client, {
      seedMemoKey: "libsql://workspace-a.turso.io",
    });
    first.client.close();

    const second = recordingClient();
    await createStoreFromSqlite(second.client, {
      seedMemoKey: "libsql://workspace-b.turso.io",
    });
    expect(seedMarkerReads(second.records)).toBeGreaterThan(0);
    second.client.close();
  });
});
