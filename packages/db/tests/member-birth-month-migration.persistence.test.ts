import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

/**
 * v55 (#1415): `members.birth_month`. The FIRE reference age is derived from the
 * birth date on every read instead of read back from a typed `currentAge` that
 * froze — the age Jorge entered at 62 was still 62 the year he turned 63. The
 * month is what makes the derived age exact inside the natural year; with only
 * the year the age is `year − birthYear`, honest to ±1 year.
 *
 * Seeded at v54 without the column so the test exercises the real legacy-DB path
 * (additive ALTER over a members table that already has rows), not a version bump.
 */
async function seedV54(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (54)");
  await client.executeMultiple(`
    CREATE TABLE members (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      disabled_at TEXT,
      birth_year INTEGER,
      fiscal_country TEXT,
      risk_tolerance TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    INSERT INTO members (id, name, birth_year) VALUES ('m_jorge', 'Jorge', 1963);
  `);
  return client;
}

describe("schema migration v55 (member birth month)", () => {
  test("adds birth_month leaving the existing member's year intact and the month unset", async () => {
    const client = await seedV54();

    await migrate(client);

    // Nothing is backfilled: a member who only ever gave a year genuinely does not
    // know the month, and inventing one would fake precision the data lacks.
    expect(
      (await client.execute("SELECT id, birth_year, birth_month FROM members")).rows,
    ).toEqual([{ id: "m_jorge", birth_year: 1963, birth_month: null }]);
    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(55);
  });

  test("is idempotent over a DB that already carries the column", async () => {
    const client = await seedV54();
    await migrate(client);

    await migrate(client);

    const columns = await client.execute("PRAGMA table_info(members)");
    expect(columns.rows.filter((row) => row.name === "birth_month")).toHaveLength(1);
  });
});
