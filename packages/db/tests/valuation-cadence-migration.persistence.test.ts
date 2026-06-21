/**
 * Schema v33 migration (ADR 0031, #393): the valuation_cadence column.
 *
 * A genuine upgrade (a DB whose assets/liabilities predate the cadence column)
 * gets the column added to BOTH tables and `ranV33Backfill === true` — the signal
 * the store uses to re-ripple every modeled holding (their default flipped from
 * interpolated to step in #390–392). No value is backfilled — null reads as step.
 * A fresh DB (schema-sql already carries the column) only bumps the version and
 * returns `ranV33Backfill === false` (nothing stale to correct).
 */
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";

const hasColumn = async (client: Client, table: string): Promise<boolean> =>
  (
    (await client.execute(`PRAGMA table_info(${table})`)).rows as unknown as Array<{
      name: string;
    }>
  ).some((c) => c.name === "valuation_cadence");

/**
 * Pre-v33: strip the valuation_cadence column from both tables so migrate()
 * exercises the real legacy-DB path (ALTER TABLE ADD COLUMN), not merely a bump
 * of an already-present column.
 */
async function seedPreV33(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(
    schemaSql.replace(/[ \t]*`valuation_cadence` text,\n/g, ""),
  );
  await client.execute("PRAGMA user_version = 32");

  await client.executeMultiple(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier) VALUES
      ('a_home', 'Piso', 'real_estate', 'EUR', 300000, 'housing');

    INSERT INTO liabilities (id, name, type, currency, current_balance_minor, debt_model) VALUES
      ('l_mortgage', 'Hipoteca', 'mortgage', 'EUR', 200000, 'amortizable'),
      ('l_card', 'Tarjeta', 'debt', 'EUR', 1500, 'revolving');
  `);

  return client;
}

describe("valuation-cadence schema migration (v33)", () => {
  test("a genuine upgrade adds the column to both tables and flags re-ripple", async () => {
    const client = await seedPreV33();
    expect(await hasColumn(client, "assets")).toBe(false); // genuinely pre-v33
    expect(await hasColumn(client, "liabilities")).toBe(false);

    const result = await migrate(client);

    expect(await hasColumn(client, "assets")).toBe(true);
    expect(await hasColumn(client, "liabilities")).toBe(true);
    expect(result.ranV33Backfill).toBe(true);
    expect(
      Number((await client.execute("PRAGMA user_version")).rows[0]!.user_version),
    ).toBe(SCHEMA_VERSION);
  });

  test("no value is backfilled — every row reads null (the default step)", async () => {
    const client = await seedPreV33();
    await migrate(client);

    const nullCount = Number(
      (
        await client.execute(
          "SELECT (SELECT COUNT(*) FROM assets WHERE valuation_cadence IS NOT NULL) + " +
            "(SELECT COUNT(*) FROM liabilities WHERE valuation_cadence IS NOT NULL) AS n",
        )
      ).rows[0]!.n,
    );
    expect(nullCount).toBe(0);
  });

  test("a fresh DB already has the column and does NOT flag re-ripple", async () => {
    const client = openLibsqlClient(":memory:");
    await client.executeMultiple(schemaSql);
    await client.execute("PRAGMA user_version = 32");

    expect(await hasColumn(client, "assets")).toBe(true); // schema-sql already carries it
    expect(await hasColumn(client, "liabilities")).toBe(true);

    const result = await migrate(client);

    expect(result.ranV33Backfill).toBe(false);
    expect(
      Number((await client.execute("PRAGMA user_version")).rows[0]!.user_version),
    ).toBe(SCHEMA_VERSION);
  });

  test("is idempotent on a second run (sits behind version < 33)", async () => {
    const client = await seedPreV33();
    const first = await migrate(client);
    expect(first.ranV33Backfill).toBe(true);

    const second = await migrate(client);
    // The early `version >= SCHEMA_VERSION` return never re-adds the column.
    expect(second.ranV33Backfill).toBe(false);
    expect(await hasColumn(client, "assets")).toBe(true);
  });
});
