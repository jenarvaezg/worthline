import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

/**
 * v57 (#1448): `payout_schedules.expenses_minor`. A rented property whose income is
 * declared takes its own NET yield as its FIRE real return instead of the housing
 * rung's guessed 3 % — and net is the only honest form: Jorge's gross rent over
 * value is 6,3 %, so using the gross would overstate by as much as the default
 * understates, in the flattering direction.
 *
 * Nothing is backfilled and NULL is load-bearing: "not declared" means no rate is
 * derived at all (the tier default stays, with a notice on the FIRE panel), while a
 * declared 0 is a claim the user has to make himself.
 *
 * Seeded at v56 with a rent already in the table, so the test travels the real
 * legacy path (an additive ALTER over populated rows), not a fresh create.
 */
async function seedV56(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (56)");
  await client.executeMultiple(`
    CREATE TABLE payout_schedules (
      id TEXT PRIMARY KEY NOT NULL,
      holding_id TEXT NOT NULL,
      label TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      cadence TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT,
      exclusions_json TEXT DEFAULT '[]' NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    INSERT INTO payout_schedules (id, holding_id, label, amount_minor, cadence, start_date)
    VALUES ('s_navalcarnero', 'a_piso', 'Alquiler', 65000, 'monthly', '2024-01-01');
  `);
  return client;
}

describe("schema migration v57 (payout schedule expenses)", () => {
  test("adds expenses_minor leaving the declared rent intact and the cost unset", async () => {
    const client = await seedV56();

    await migrate(client);

    // Not backfilled to 0: "this flat costs me nothing to hold" is a statement the
    // user makes, not one the migration makes for him.
    expect(
      (
        await client.execute(
          "SELECT id, amount_minor, expenses_minor FROM payout_schedules",
        )
      ).rows,
    ).toEqual([{ id: "s_navalcarnero", amount_minor: 65_000, expenses_minor: null }]);
    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(65);
  });

  test("is idempotent over a DB that already carries the column", async () => {
    const client = await seedV56();
    await migrate(client);

    await migrate(client);

    const columns = await client.execute("PRAGMA table_info(payout_schedules)");
    expect(columns.rows.filter((row) => row.name === "expenses_minor")).toHaveLength(1);
  });

  test("a fresh schemaSql carries the column too", async () => {
    const client = openLibsqlClient(":memory:");

    await client.executeMultiple(schemaSql);

    const columns = await client.execute("PRAGMA table_info(payout_schedules)");
    expect(
      (columns.rows as unknown as Array<{ name: string; notnull: number }>).find(
        (row) => row.name === "expenses_minor",
      ),
    ).toMatchObject({ notnull: 0 });
  });
});
